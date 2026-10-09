import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import {
  CashFlowEntry,
  CreditCard,
  CreditCardStatementImport,
  Prisma,
  Receipt,
} from "@prisma/client";
import {
  CARD_IMPORT_REVIEW_REASON,
  type CardImportReviewCandidate,
  type CardImportReviewItem,
  type ImportSessionDraftLineV1,
  type ImportSessionObservationViewV1,
  resolveInstallmentIndex,
} from "@reformaflow/domain";
import { canonical } from "../common/canonical";
import { INCLUDE_SOFT_DELETED } from "../prisma/prisma.service";
import { detectInstallment } from "./parsers/types";
import {
  buildStoredExpenseInstallments,
  parseStoredExpenseSchedule,
} from "../expense/documented-schedule";

export const CARD_PURCHASE_INSPECTION = {
  IMPORT: "import",
  RESTORE: "restore",
} as const;
type CardPurchaseInspectionIntent =
  (typeof CARD_PURCHASE_INSPECTION)[keyof typeof CARD_PURCHASE_INSPECTION];
const CARD_PURCHASE_CONFLICT = "Compra de cartao concorrente ou ambigua";

export function normalizeSeriesMerchant(merchant: string): string {
  return (merchant || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSeriesKey(
  cardId: string,
  merchant: string,
  amountCents: number,
  total: number,
): string {
  return `${cardId}|${normalizeSeriesMerchant(merchant)}|${amountCents}|${total}`;
}

export function parseCardSeries(key: string | null) {
  const parts = key?.split("|");
  if (
    !parts ||
    parts.length !== 4 ||
    !parts[0] ||
    !parts[1] ||
    !/^[1-9]\d*$/.test(parts[2]) ||
    !/^[1-9]\d*$/.test(parts[3])
  )
    return null;
  const amount = Number(parts[2]);
  const total = Number(parts[3]);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total))
    return null;
  return { cardId: parts[0], merchant: parts[1], amount, total };
}

export interface PurchaseIdentity {
  id?: string;
  cardId: string;
  projectId: string;
  merchant: string;
  total: number;
  seriesKey: string | null;
  externalId: string | null;
  dedupeKeyStrong: string | null;
}

/** Row evidence the family decision reads. Never includes cash flow. */
interface FamilyEvidence {
  valorTotal: number;
  quantidadeParcela: number | null;
  seriesKey: string | null;
  titulo: string | null;
  fornecedor: string | null;
  importId: string | null;
  cardLast4: string | null;
}

const rootInclude = (tenantId: string) =>
  ({
    cashFlow: {
      where: { tenantId, deletedAt: null },
      orderBy: { id: "asc" },
    },
    _count: {
      select: { cashFlow: { where: { tenantId: { not: tenantId } } } },
    },
  }) satisfies Prisma.ExpenseInclude;
type CompanionRoot = Prisma.ExpenseGetPayload<{
  include: ReturnType<typeof rootInclude>;
}>;

export interface ImportInspection {
  companions: CompanionRoot[];
  receipts: Receipt[];
}
export interface RestoreInspection extends ImportInspection {
  unowned: CashFlowEntry[];
  imports: CreditCardStatementImport[];
  cards: CreditCard[];
}

/**
 * Bound-parameter ceiling guard. SQLite builds used by Prisma cap a statement
 * at 999 variables, and Prisma cannot split a filter it cannot prove positive
 * (a query with `not`), so every list-valued filter goes through this helper.
 * Never truncate: every chunk is queried and the results merged.
 */
const IN_CHUNK = 500;
function chunks<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
const byId = <T extends { id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Cash-flow facts the family decision may read, once cash flow is loaded. */
interface CashFlowEvidence {
  hasPositive: boolean;
  labels: readonly (string | null)[];
}
const cashFlowEvidence = (
  entries: readonly { valor: number; parcela: string | null }[],
): CashFlowEvidence => ({
  hasPositive: entries.some((entry) => entry.valor > 0),
  labels: entries.map((entry) => entry.parcela),
});

/**
 * Strict "N/M" installment label with 1 <= N <= M (the generator emits
 * `${i + 1}/${n}` with n >= 1, so 1/1 is readable); anything else is unreadable.
 */
function parseInstallmentLabelTotal(label: string | null): number | null {
  const match = /^(\d{1,3})\/(\d{1,3})$/.exec(label?.trim() ?? "");
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  return current >= 1 && current <= total ? total : null;
}

/**
 * A native financial edit can change the installment count without touching
 * `seriesKey`, so the key's total alone may be stale. The row's ACTIVE cash
 * flow (any status, PAGO included) is the current state that must agree: at
 * least one readable label carries the series total and none contradicts it.
 * A complete 1..N list is not required (3/10 with labels 3/10..10/10 confirms
 * 10). Missing or unreadable labels alone never confirm.
 */
function cashFlowConfirmsSeriesTotal(
  cash: CashFlowEvidence | null,
  seriesTotal: number,
): boolean {
  if (!cash) return false;
  const totals = cash.labels
    .map(parseInstallmentLabelTotal)
    .filter((total): total is number => total !== null);
  return totals.length > 0 && totals.every((total) => total === seriesTotal);
}

/**
 * Family decision shared by both intents. `cash` is `null` while cash flow has
 * not been read: the monetary guard (valorTotal <= 0 with no positive cash flow
 * is not a family member) and the series-total confirmation can only be applied
 * once it is known, so `null` keeps the row as a candidate instead of dropping
 * or releasing it on partial evidence.
 */
function createFamilyMatcher(
  purchase: PurchaseIdentity,
  intent: CardPurchaseInspectionIntent,
  importCardId: (importId: string | null) => string | undefined,
  purchaseCardLast4: string | undefined,
) {
  const merchant = normalizeSeriesMerchant(
    detectInstallment(purchase.merchant).cleanMerchant,
  );
  return (row: FamilyEvidence, cash: CashFlowEvidence | null): boolean => {
    if (row.valorTotal <= 0 && cash && !cash.hasPositive) return false;
    const series = parseCardSeries(row.seriesKey);
    const title = detectInstallment(row.titulo ?? "");
    const total = series?.total ?? title.total ?? row.quantidadeParcela;
    // An import's default total=1 is not proof of independence. It follows
    // ordinary admission, still checking strong identities below, rather than
    // expanding a restore cohort from merchant similarity in either direction.
    if (
      intent === CARD_PURCHASE_INSPECTION.IMPORT &&
      (purchase.total <= 1 || (total ?? 0) <= 1)
    )
      return false;
    const ids = new Set(
      [importCardId(row.importId), series?.cardId].filter(
        (id): id is string => !!id,
      ),
    );
    if (ids.size) {
      if (!ids.has(purchase.cardId)) return false;
      if (ids.size > 1) return true; // contradictory explicit identities are ambiguous
    } else if (
      purchaseCardLast4 === undefined ||
      row.cardLast4 !== purchaseCardLast4
    ) {
      return false;
    }
    if (purchase.seriesKey && row.seriesKey === purchase.seriesKey) return true;
    // Import only: a valid canonical seriesKey carries the purchase's FULL
    // installment count. A document line whose full count differs is a
    // different purchase, so it is not a companion. Deliberately narrow:
    //  - `quantidadeParcela` is the REMAINING count, never a full count;
    //  - a mutable title may veto (disagreeing with the seriesKey is a
    //    contradiction and stays ambiguous) but can never release by itself;
    //  - the key is not editable but can go stale after a native edit, so the
    //    row's active cash-flow labels must confirm the key's total and any
    //    contradicting readable label vetoes (unknown cash flow never releases);
    //  - no valid seriesKey means incomplete evidence, which stays conservative.
    // Strong external identities are unaffected: they are matched on
    // `externalIds`/`strongIds` by the caller regardless of this decision.
    if (
      intent === CARD_PURCHASE_INSPECTION.IMPORT &&
      series &&
      series.total !== purchase.total &&
      (title.total === undefined || title.total === series.total) &&
      cashFlowConfirmsSeriesTotal(cash, series.total)
    )
      return false;
    const names = [series?.merchant, row.fornecedor, title.cleanMerchant]
      .filter((name): name is string => !!name)
      .map((name) =>
        normalizeSeriesMerchant(detectInstallment(name).cleanMerchant),
      );
    // Restore retains incomplete family evidence; import reaches this point
    // only when both sides carry installment evidence.
    return (
      (names.length === 0 || names.includes(merchant)) &&
      (purchase.total > 1 || (total ?? 0) > 1)
    );
  };
}

const CONFLICT = () => new ConflictException(CARD_PURCHASE_CONFLICT);
const isBlocking = (row: CompanionRoot) =>
  !row.deletedAt || row.cashFlow.length > 0 || row._count.cashFlow > 0;

/**
 * Strong identity is checked for both operations. Restore additionally requires
 * a conservative exclusion proof for the historical cohort. Import does not
 * adopt that cohort: merchant similarity alone cannot connect an ordinary line
 * to an installment purchase. Compatible installments remain ambiguous without
 * a date, amount or status window; passive tombstones never instruct revival.
 * Import releases installment pairs only when a valid seriesKey proves a
 * different full installment count (see createFamilyMatcher).
 *
 * Import runs the two-phase scope (no cache, same transaction as the caller):
 * phase 1 reads minimal scalar evidence to pick a superset cohort, phase 2
 * hydrates cash flow only for that cohort and the strong identities. Restore
 * keeps the full historical read because its fingerprint hashes every row.
 */
export async function inspectCardPurchaseCompanions(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
  intent: typeof CARD_PURCHASE_INSPECTION.IMPORT,
): Promise<ImportInspection>;
export async function inspectCardPurchaseCompanions(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
  intent: typeof CARD_PURCHASE_INSPECTION.RESTORE,
): Promise<RestoreInspection>;
export async function inspectCardPurchaseCompanions(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
  intent: CardPurchaseInspectionIntent,
): Promise<ImportInspection | RestoreInspection>;
export async function inspectCardPurchaseCompanions(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
  intent: CardPurchaseInspectionIntent,
): Promise<ImportInspection | RestoreInspection> {
  if (intent === CARD_PURCHASE_INSPECTION.IMPORT)
    return inspectForImport(tx, tenantId, purchase);
  if (intent === CARD_PURCHASE_INSPECTION.RESTORE)
    return inspectForRestore(tx, tenantId, purchase);
  throw CONFLICT();
}

async function inspectForRestore(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
): Promise<RestoreInspection> {
  const roots = await tx.expense.findMany({
    where: {
      tenantId,
      id: { not: purchase.id },
      deletedAt: INCLUDE_SOFT_DELETED,
      project: { tenantId, deletedAt: null },
    },
    orderBy: { id: "asc" },
    include: rootInclude(tenantId),
  });
  const imports = await tx.creditCardStatementImport.findMany({
    where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
    orderBy: { id: "asc" },
  });
  const cards = await tx.creditCard.findMany({
    where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
    orderBy: { id: "asc" },
  });
  const importCards = new Map(imports.map((item) => [item.id, item.cardId]));
  const matches = createFamilyMatcher(
    purchase,
    CARD_PURCHASE_INSPECTION.RESTORE,
    (importId) => (importId ? importCards.get(importId) : undefined),
    cards.find((card) => card.id === purchase.cardId)?.last4,
  );
  const externalIds = new Set(purchase.externalId ? [purchase.externalId] : []);
  const strongIds = new Set(
    purchase.dedupeKeyStrong ? [purchase.dedupeKeyStrong] : [],
  );
  const family = roots.filter((row) =>
    matches(row, cashFlowEvidence(row.cashFlow)),
  );
  for (const row of family) {
    if (row.externalId) externalIds.add(row.externalId);
    if (row.dedupeKeyStrong) strongIds.add(row.dedupeKeyStrong);
  }
  const companions = roots.filter(
    (row) =>
      family.includes(row) ||
      (!!row.externalId && externalIds.has(row.externalId)) ||
      (!!row.dedupeKeyStrong && strongIds.has(row.dedupeKeyStrong)),
  );
  const receipts = await tx.receipt.findMany({
    where: {
      tenantId,
      deletedAt: INCLUDE_SOFT_DELETED,
      OR: [
        { externalId: { in: [...externalIds] } },
        { dedupeKeyStrong: { in: [...strongIds] } },
      ],
    },
    orderBy: { id: "asc" },
  });
  const unowned = await tx.cashFlowEntry.findMany({
    where: {
      tenantId,
      projectId: purchase.projectId,
      expenseId: null,
      deletedAt: null,
      tipo: "DESPESA",
      formaPagamento: "CARTAO_CREDITO",
      valor: { gt: 0 },
    },
    orderBy: { id: "asc" },
  });
  if (receipts.length || unowned.length || companions.some(isBlocking))
    throw CONFLICT();
  return { companions, receipts, unowned, imports, cards };
}

interface ImportGathering extends ImportInspection {
  /** Ids of the roots the family decision selected (excludes strong-only companions). */
  familyIds: ReadonlySet<string>;
  importCardId: (importId: string | null) => string | undefined;
}

const importRootScope = (tenantId: string, purchase: PurchaseIdentity) =>
  ({
    tenantId,
    id: { not: purchase.id },
    deletedAt: INCLUDE_SOFT_DELETED,
    project: { tenantId, deletedAt: null },
  }) satisfies Prisma.ExpenseWhereInput;
const familyEvidenceSelect = {
  id: true,
  valorTotal: true,
  quantidadeParcela: true,
  seriesKey: true,
  titulo: true,
  fornecedor: true,
  importId: true,
  cardLast4: true,
} satisfies Prisma.ExpenseSelect;

async function gatherImportFamily(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
): Promise<ImportGathering> {
  const rootScope = importRootScope(tenantId, purchase);
  const include = rootInclude(tenantId);
  const externalIds = new Set(purchase.externalId ? [purchase.externalId] : []);
  const strongIds = new Set(
    purchase.dedupeKeyStrong ? [purchase.dedupeKeyStrong] : [],
  );

  // Phase 1 (superset cohort). A single line (total <= 1) has no family in
  // import, so it never scans the tenant. An installment line reads scalar
  // evidence only (no cash flow, no wide columns) and keeps every row that
  // could be a family member once the cash-flow guard is known.
  const candidateIds: string[] = [];
  let isFamily: ReturnType<typeof createFamilyMatcher> = () => false;
  const importCards = new Map<string, string>();
  if (purchase.total > 1) {
    const cardRows = await tx.creditCard.findMany({
      where: { tenantId, id: purchase.cardId, deletedAt: INCLUDE_SOFT_DELETED },
      select: { last4: true },
    });
    const evidence = await tx.expense.findMany({
      where: rootScope,
      orderBy: { id: "asc" },
      select: familyEvidenceSelect,
    });
    const referencedImports = [
      ...new Set(
        evidence.map((row) => row.importId).filter((id): id is string => !!id),
      ),
    ];
    for (const part of chunks(referencedImports)) {
      const rows = await tx.creditCardStatementImport.findMany({
        where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED, id: { in: part } },
        select: { id: true, cardId: true },
      });
      for (const row of rows) importCards.set(row.id, row.cardId);
    }
    isFamily = createFamilyMatcher(
      purchase,
      CARD_PURCHASE_INSPECTION.IMPORT,
      (importId) => (importId ? importCards.get(importId) : undefined),
      cardRows[0]?.last4,
    );
    for (const row of evidence)
      if (isFamily(row, null)) candidateIds.push(row.id);
  }

  // Phase 2: hydrate only the cohort and the direct strong identities.
  const loaded = new Map<string, CompanionRoot>();
  const load = async (where: Prisma.ExpenseWhereInput) => {
    const rows = await tx.expense.findMany({
      where: { ...rootScope, ...where },
      orderBy: { id: "asc" },
      include,
    });
    for (const row of rows) loaded.set(row.id, row);
  };
  const loadByIds = async (ids: readonly string[]) => {
    for (const part of chunks(ids))
      await load({ id: { in: part, not: purchase.id } });
  };
  const loadByStrong = async (
    external: readonly string[],
    strong: readonly string[],
  ) => {
    for (const part of chunks(external))
      await load({ externalId: { in: part } });
    for (const part of chunks(strong))
      await load({ dedupeKeyStrong: { in: part } });
  };
  await loadByIds(candidateIds);
  await loadByStrong([...externalIds], [...strongIds]);

  const candidateSet = new Set(candidateIds);
  // The exact family re-runs the decision on the phase-1 cohort now that cash
  // flow is known (monetary guard and series-total confirmation).
  const family = [...loaded.values()].filter(
    (row) =>
      candidateSet.has(row.id) && isFamily(row, cashFlowEvidence(row.cashFlow)),
  );
  const familyExternal = family
    .map((row) => row.externalId)
    .filter((id): id is string => !!id && !externalIds.has(id));
  const familyStrong = family
    .map((row) => row.dedupeKeyStrong)
    .filter((id): id is string => !!id && !strongIds.has(id));
  for (const id of familyExternal) externalIds.add(id);
  for (const id of familyStrong) strongIds.add(id);
  await loadByStrong(familyExternal, familyStrong);

  const roots = [...loaded.values()].sort(byId);
  const companions = roots.filter(
    (row) =>
      family.includes(row) ||
      (!!row.externalId && externalIds.has(row.externalId)) ||
      (!!row.dedupeKeyStrong && strongIds.has(row.dedupeKeyStrong)),
  );
  const receiptMap = new Map<string, Receipt>();
  const findReceipts = async (where: Prisma.ReceiptWhereInput) => {
    const rows = await tx.receipt.findMany({
      where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED, ...where },
      orderBy: { id: "asc" },
    });
    for (const row of rows) receiptMap.set(row.id, row);
  };
  for (const part of chunks([...externalIds]))
    await findReceipts({ externalId: { in: part } });
  for (const part of chunks([...strongIds]))
    await findReceipts({ dedupeKeyStrong: { in: part } });
  const receipts = [...receiptMap.values()].sort(byId);
  return {
    companions,
    receipts,
    familyIds: new Set(family.map((row) => row.id)),
    importCardId: (importId) =>
      importId ? importCards.get(importId) : undefined,
  };
}

async function inspectForImport(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
): Promise<ImportInspection> {
  const { companions, receipts } = await gatherImportFamily(
    tx,
    tenantId,
    purchase,
  );
  // The unowned card cash-flow read is restore-only: import never consults it.
  if (receipts.length || companions.some(isBlocking)) throw CONFLICT();
  return { companions, receipts };
}

export type ImportFamilyRoot = CompanionRoot;

/**
 * Outcome of the import admission of ONE line, computed under the writer.
 * - CLEAR: nothing blocks; the line is an ordinary new purchase.
 * - REVIEW, two cases, both only over live, same-project/card roots with
 *   only nominal cash flow (any status, PAGO included, is preserved):
 *   (a) the SAME full installment count N with a different valid seriesKey;
 *   (b) two or more roots of the IDENTICAL series (k >= 2) that are not
 *   siblings of the line: no root can be chosen as the continuation, so the
 *   answer never depends on the callback. Neither a duplicate nor proven
 *   independent: a human decides, bound to the reviewed state by a fingerprint.
 * - BLOCKED: anything else (strong identity, Receipt, foreign cash flow,
 *   tombstone with cash flow, contradiction, non-nominal cash flow...).
 *   `sameSeries` marks the case where the only obstacle is exactly ONE live
 *   root with the IDENTICAL seriesKey, which the ordinary series dedupe (reuse,
 *   not this decision) owns.
 *   A live root created by ANOTHER line of the same document and occurrence is
 *   not counted at all (see `excludableSibling`).
 */
export type ImportAdmission =
  | { kind: "CLEAR" }
  | { kind: "REVIEW"; roots: ImportFamilyRoot[] }
  | { kind: "BLOCKED"; sameSeries: boolean };

type ReviewStanding = "ELIGIBLE" | "SAME_SERIES" | "NO";

/**
 * A root may be offered for review only when every proof is present. There is
 * no monetary tolerance: the key nominal must equal every active cash flow
 * entry exactly, and the active labels must confirm the key's total.
 */
function reviewStanding(
  row: CompanionRoot,
  purchase: PurchaseIdentity,
  familyIds: ReadonlySet<string>,
  importCardId: (importId: string | null) => string | undefined,
): ReviewStanding {
  const series = parseCardSeries(row.seriesKey);
  const wanted = parseCardSeries(purchase.seriesKey);
  if (!series || !wanted || !familyIds.has(row.id) || row.deletedAt)
    return "NO";
  if (row.projectId !== purchase.projectId || row._count.cashFlow > 0)
    return "NO";
  if (
    series.cardId !== purchase.cardId ||
    (importCardId(row.importId) ?? series.cardId) !== purchase.cardId
  )
    return "NO";
  if (series.merchant !== wanted.merchant || series.total !== wanted.total)
    return "NO";
  if (
    (purchase.externalId && row.externalId === purchase.externalId) ||
    (purchase.dedupeKeyStrong &&
      row.dedupeKeyStrong === purchase.dedupeKeyStrong)
  )
    return "NO";
  const title = detectInstallment(row.titulo ?? "");
  if (title.total !== undefined && title.total !== series.total) return "NO";
  if (
    !cashFlowConfirmsSeriesTotal(
      cashFlowEvidence(row.cashFlow),
      series.total,
    ) ||
    !row.cashFlow.every(
      (entry) =>
        entry.valor === series.amount && entry.projectId === row.projectId,
    )
  )
    return "NO";
  return row.seriesKey === purchase.seriesKey ? "SAME_SERIES" : "ELIGIBLE";
}

/**
 * Same document, same occurrence: `current` -> externalIds of EVERY parsed line
 * of that occurrence (installment purchases only, before any selection).
 * Identity comes from the persisted `externalId`, never from batch memory.
 */
export type OccurrenceGroups = ReadonlyMap<number, ReadonlySet<string>>;

export function occurrenceGroups(
  transactions: ReadonlyArray<{
    externalId: string;
    installmentCurrent?: number | null;
    installmentTotal?: number | null;
  }>,
): OccurrenceGroups {
  const groups = new Map<number, Set<string>>();
  for (const t of transactions) {
    if (!t.installmentTotal || t.installmentTotal <= 1) continue;
    const current =
      t.installmentCurrent && t.installmentCurrent >= 1
        ? t.installmentCurrent
        : 1;
    const ids = groups.get(current) ?? new Set<string>();
    ids.add(t.externalId);
    groups.set(current, ids);
  }
  return groups;
}

/** `isSibling(id)`: `id` is ANOTHER line of the same document and occurrence as `line`. */
export function siblingPredicate(
  groups: OccurrenceGroups,
  line: { externalId: string; current: number },
): (externalId: string) => boolean {
  const ids = groups.get(line.current);
  return (externalId) =>
    externalId !== line.externalId && !!ids?.has(externalId);
}

interface SiblingCandidate {
  externalId: string | null;
  dedupeKeyStrong: string | null;
  deletedAt: Date | null;
  seriesKey: string | null;
}

/**
 * A live root of the line's own series that was created by ANOTHER line of the
 * same document occurrence is not a candidate for this line. A root that shares
 * the line's strong identity (externalId or dedupeKeyStrong) is never excluded,
 * and neither is a tombstone.
 */
export function excludableSibling(
  row: SiblingCandidate,
  purchase: Pick<
    PurchaseIdentity,
    "seriesKey" | "externalId" | "dedupeKeyStrong"
  >,
  isSibling: ((externalId: string) => boolean) | undefined,
): boolean {
  if (!isSibling || row.deletedAt || !row.externalId) return false;
  if (!purchase.seriesKey || row.seriesKey !== purchase.seriesKey) return false;
  if (
    (purchase.externalId && row.externalId === purchase.externalId) ||
    (purchase.dedupeKeyStrong &&
      row.dedupeKeyStrong === purchase.dedupeKeyStrong)
  )
    return false;
  return isSibling(row.externalId);
}

export async function classifyCardImport(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
  isSibling?: (externalId: string) => boolean,
): Promise<ImportAdmission> {
  return importAdmission(
    await gatherImportFamily(tx, tenantId, purchase),
    purchase,
    isSibling,
  );
}

function importAdmission(
  { companions, receipts, familyIds, importCardId }: ImportGathering,
  purchase: PurchaseIdentity,
  isSibling?: (externalId: string) => boolean,
): ImportAdmission {
  const blocking = companions
    .filter(isBlocking)
    .filter((row) => !excludableSibling(row, purchase, isSibling));
  if (!receipts.length && blocking.length === 0) return { kind: "CLEAR" };
  if (receipts.length) return { kind: "BLOCKED", sameSeries: false };
  const standing = blocking.map((row) =>
    reviewStanding(row, purchase, familyIds, importCardId),
  );
  if (standing.includes("NO")) return { kind: "BLOCKED", sameSeries: false };
  const sameCount = standing.filter((s) => s === "SAME_SERIES").length;
  // Two or more live same-series roots: no root can be chosen as "the" purchase.
  if (sameCount >= 2) return { kind: "REVIEW", roots: blocking };
  if (sameCount === 1) return { kind: "BLOCKED", sameSeries: true };
  return { kind: "REVIEW", roots: blocking };
}

export interface CardImportFacts extends ImportInspection {
  imports: readonly Pick<
    CreditCardStatementImport,
    "id" | "tenantId" | "cardId" | "deletedAt"
  >[];
  cards: readonly Pick<
    CreditCard,
    "id" | "tenantId" | "projectId" | "last4" | "deletedAt"
  >[];
}
export type CardImportEnumeration =
  | {
      kind: "EXHAUSTED";
      visitedRows: number;
      inspection: CardImportFacts;
      admission: ImportAdmission;
    }
  | { kind: "BUDGET_EXCEEDED"; visitedRows: number };
const BOUNDED_CHUNK = 300;

/** Internal read-only facts, not KEEP/ACL authority. Every materialized row, including rereads, spends balance. */
export async function inspectCardImportInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
  remaining: number,
  isSibling?: (externalId: string) => boolean,
): Promise<CardImportEnumeration> {
  if (!Number.isSafeInteger(remaining) || remaining < 0)
    throw new RangeError("Invalid matching row balance");
  let visitedRows = 0;
  const overflow = new Error("Card import matching row balance exceeded");
  async function readPages<T extends { id: string }>(
    read: (after: string | null, take: number) => Promise<T[]>,
  ): Promise<T[]> {
    let after: string | null = null;
    const all: T[] = [];
    for (;;) {
      const take = Math.min(BOUNDED_CHUNK, remaining - visitedRows + 1);
      const rows = await read(after, take);
      visitedRows += rows.length;
      if (visitedRows > remaining) throw overflow;
      all.push(...rows);
      if (rows.length < take) return all;
      after = rows[rows.length - 1]!.id;
    }
  }
  const cursor = (after: string | null) =>
    after === null ? {} : { id: { gt: after } };
  const rootScope = importRootScope(tenantId, purchase);
  const imports = new Map<string, CardImportFacts["imports"][number]>();
  const cards = new Map<string, CardImportFacts["cards"][number]>();
  const importCardId = (id: string | null) =>
    id ? imports.get(id)?.cardId : undefined;
  const loadImports = async (ids: readonly string[]) => {
    for (const part of chunks(
      [...new Set(ids)].filter((id) => !imports.has(id)),
      BOUNDED_CHUNK,
    )) {
      const rows = await readPages((after, take) =>
        tx.creditCardStatementImport.findMany({
          where: {
            tenantId,
            deletedAt: INCLUDE_SOFT_DELETED,
            AND: [{ id: { in: part } }, cursor(after)],
          },
          select: { id: true, tenantId: true, cardId: true, deletedAt: true },
          orderBy: { id: "asc" },
          take,
        }),
      );
      for (const row of rows) imports.set(row.id, row);
    }
  };
  const loadCards = async (ids: readonly string[]) => {
    for (const part of chunks(
      [...new Set(ids)].filter((id) => !cards.has(id)),
      BOUNDED_CHUNK,
    )) {
      const rows = await readPages((after, take) =>
        tx.creditCard.findMany({
          where: {
            tenantId,
            deletedAt: INCLUDE_SOFT_DELETED,
            AND: [{ id: { in: part } }, cursor(after)],
          },
          select: {
            id: true,
            tenantId: true,
            projectId: true,
            last4: true,
            deletedAt: true,
          },
          orderBy: { id: "asc" },
          take,
        }),
      );
      for (const row of rows) cards.set(row.id, row);
    }
  };
  const loaded = new Map<string, CompanionRoot>();
  const loadRoots = async (where: Prisma.ExpenseWhereInput) => {
    const roots = await readPages((after, take) =>
      tx.expense.findMany({
        where: {
          deletedAt: INCLUDE_SOFT_DELETED,
          AND: [rootScope, where, cursor(after)],
        },
        include: { _count: rootInclude(tenantId)._count },
        orderBy: { id: "asc" },
        take,
      }),
    );
    const cash = new Map<string, CashFlowEntry[]>();
    for (const part of chunks(
      roots.map((row) => row.id),
      BOUNDED_CHUNK,
    )) {
      const rows = await readPages((after, take) =>
        tx.cashFlowEntry.findMany({
          where: {
            tenantId,
            deletedAt: null,
            expenseId: { in: part },
            ...cursor(after),
          },
          orderBy: { id: "asc" },
          take,
        }),
      );
      for (const row of rows) {
        if (row.expenseId === null)
          throw new Error("Invalid card import cash-flow evidence");
        const entries = cash.get(row.expenseId) ?? [];
        entries.push(row);
        cash.set(row.expenseId, entries);
      }
    }
    await loadImports(
      roots.flatMap((row) => (row.importId ? [row.importId] : [])),
    );
    await loadCards([...imports.values()].map((row) => row.cardId));
    for (const root of roots)
      loaded.set(root.id, { ...root, cashFlow: cash.get(root.id) ?? [] });
  };
  const loadStrong = async (
    external: readonly string[],
    strong: readonly string[],
  ) => {
    for (const part of chunks(external, BOUNDED_CHUNK))
      await loadRoots({ externalId: { in: part } });
    for (const part of chunks(strong, BOUNDED_CHUNK))
      await loadRoots({ dedupeKeyStrong: { in: part } });
  };
  try {
    const evidence =
      purchase.total > 1
        ? await readPages((after, take) =>
            tx.expense.findMany({
              where: {
                deletedAt: INCLUDE_SOFT_DELETED,
                AND: [rootScope, cursor(after)],
              },
              select: familyEvidenceSelect,
              orderBy: { id: "asc" },
              take,
            }),
          )
        : [];
    await loadImports(
      evidence.flatMap((row) => (row.importId ? [row.importId] : [])),
    );
    await loadCards([
      purchase.cardId,
      ...[...imports.values()].map((row) => row.cardId),
    ]);
    const isFamily = createFamilyMatcher(
      purchase,
      CARD_PURCHASE_INSPECTION.IMPORT,
      importCardId,
      cards.get(purchase.cardId)?.last4,
    );
    const candidateIds = evidence
      .filter((row) => isFamily(row, null))
      .map((row) => row.id);
    for (const part of chunks(candidateIds, BOUNDED_CHUNK))
      await loadRoots({ id: { in: part } });
    const externalIds = new Set(
      purchase.externalId ? [purchase.externalId] : [],
    );
    const strongIds = new Set(
      purchase.dedupeKeyStrong ? [purchase.dedupeKeyStrong] : [],
    );
    await loadStrong([...externalIds], [...strongIds]);
    const candidateSet = new Set(candidateIds);
    const family = [...loaded.values()].filter(
      (row) =>
        candidateSet.has(row.id) &&
        isFamily(row, cashFlowEvidence(row.cashFlow)),
    );
    const familyExternal = family.flatMap((row) =>
      row.externalId && !externalIds.has(row.externalId)
        ? [row.externalId]
        : [],
    );
    const familyStrong = family.flatMap((row) =>
      row.dedupeKeyStrong && !strongIds.has(row.dedupeKeyStrong)
        ? [row.dedupeKeyStrong]
        : [],
    );
    for (const id of familyExternal) externalIds.add(id);
    for (const id of familyStrong) strongIds.add(id);
    await loadStrong(familyExternal, familyStrong);
    const familyIds = new Set(family.map((row) => row.id));
    const companions = [...loaded.values()]
      .sort(byId)
      .filter(
        (row) =>
          familyIds.has(row.id) ||
          (!!row.externalId && externalIds.has(row.externalId)) ||
          (!!row.dedupeKeyStrong && strongIds.has(row.dedupeKeyStrong)),
      );
    const receipts = new Map<string, Receipt>();
    const loadReceipts = async (where: Prisma.ReceiptWhereInput) => {
      const rows = await readPages((after, take) =>
        tx.receipt.findMany({
          where: {
            tenantId,
            deletedAt: INCLUDE_SOFT_DELETED,
            AND: [where, cursor(after)],
          },
          orderBy: { id: "asc" },
          take,
        }),
      );
      for (const row of rows) receipts.set(row.id, row);
    };
    for (const part of chunks([...externalIds], BOUNDED_CHUNK))
      await loadReceipts({ externalId: { in: part } });
    for (const part of chunks([...strongIds], BOUNDED_CHUNK))
      await loadReceipts({ dedupeKeyStrong: { in: part } });
    const inspection: CardImportFacts = {
      companions,
      receipts: [...receipts.values()].sort(byId),
      imports: [...imports.values()].sort(byId),
      cards: [...cards.values()].sort(byId),
    };
    return {
      kind: "EXHAUSTED",
      visitedRows,
      inspection,
      admission: importAdmission(
        { ...inspection, familyIds, importCardId },
        purchase,
        isSibling,
      ),
    };
  } catch (error) {
    if (error !== overflow) throw error;
    return { kind: "BUDGET_EXCEEDED", visitedRows };
  }
}

export type KeepLineFacts = Pick<
  ImportSessionDraftLineV1,
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "dataCompra"
  | "firstDueDate"
>;
export type KeepObservationFacts = Pick<
  ImportSessionObservationViewV1,
  | "id"
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "installmentIndex"
  | "dataCompra"
>;
export type CardKeepCompatibility =
  | {
      kind: "COMPATIBLE";
      bindings: readonly {
        observationId: string;
        canonicalIndex: number;
        cashFlowEntryId: string;
      }[];
    }
  | { kind: "NEEDS_INPUT" }
  | { kind: "BLOCKED" };

export function hasUnknownCardOccurrenceFacts(
  value: Pick<
    KeepObservationFacts,
    "amountMeaning" | "amountCents" | "installmentCount"
  >,
): boolean {
  return (
    value.amountMeaning === "UNKNOWN" ||
    value.amountCents === null ||
    value.installmentCount === null
  );
}

/** Pure occurrence compatibility, independent of new-purchase admission. Caller still owes current participant ACL. */
export function checkCardImportKeep(
  tenantId: string,
  purchase: PurchaseIdentity,
  facts: CardImportFacts,
  rootExpenseId: string,
  line: KeepLineFacts,
  observations: readonly KeepObservationFacts[],
): CardKeepCompatibility {
  const blocked = { kind: "BLOCKED" } as const;
  const needsInput = { kind: "NEEDS_INPUT" } as const;
  const selected = facts.companions.filter((row) => row.id === rootExpenseId);
  if (selected.length !== 1 || facts.receipts.length) return blocked;
  const root = selected[0]!;
  if (
    root.deletedAt ||
    root.tenantId !== tenantId ||
    root.projectId !== purchase.projectId ||
    root._count.cashFlow > 0 ||
    facts.companions.some(
      (row) =>
        (!!purchase.externalId && row.externalId === purchase.externalId) ||
        (!!purchase.dedupeKeyStrong &&
          row.dedupeKeyStrong === purchase.dedupeKeyStrong) ||
        (row.id !== root.id &&
          ((!!root.externalId && row.externalId === root.externalId) ||
            (!!root.dedupeKeyStrong &&
              row.dedupeKeyStrong === root.dedupeKeyStrong))) ||
        (!!row.deletedAt && isBlocking(row)),
    )
  )
    return blocked;
  const stored = parseStoredExpenseSchedule(root.documentedSchedule);
  if (!stored) return needsInput;
  if (
    stored.kind !== "source" ||
    stored.tenantId !== tenantId ||
    stored.sourceExpenseId !== root.id ||
    stored.sourceProjectId !== root.projectId ||
    stored.cardId !== purchase.cardId
  )
    return blocked;
  const card = facts.cards.filter((row) => row.id === stored.cardId);
  if (card.length !== 1) return needsInput;
  if (
    card[0]!.deletedAt ||
    card[0]!.tenantId !== tenantId ||
    card[0]!.projectId !== root.projectId ||
    (root.cardLast4 !== null && root.cardLast4 !== card[0]!.last4)
  )
    return blocked;
  const series = parseCardSeries(root.seriesKey);
  if (root.seriesKey !== null && (!series || series.cardId !== stored.cardId))
    return blocked;
  if (stored.version === 1) {
    if (
      root.importId !== stored.importId ||
      root.externalId !== stored.externalId
    )
      return blocked;
    const imports = facts.imports.filter((row) => row.id === stored.importId);
    if (imports.length !== 1) return needsInput;
    if (
      imports[0]!.deletedAt ||
      imports[0]!.tenantId !== tenantId ||
      imports[0]!.cardId !== stored.cardId
    )
      return blocked;
  } else {
    if (
      root.importId !== stored.provenance.originalImportId ||
      root.externalId !== stored.provenance.originalExternalId
    )
      return blocked;
    if (root.importId && facts.imports.some((row) => row.id === root.importId))
      return blocked;
  }
  const installments = buildStoredExpenseInstallments(root);
  const first = installments[0];
  if (!first) return needsInput;
  // The first due date anchors the stored agenda, not each later observation's cycle.
  if (line.firstDueDate !== null && line.firstDueDate !== day(first.data))
    return blocked;
  if (
    installments.reduce((sum, item) => sum + item.valor, 0) !== root.valorTotal
  )
    return blocked;
  if (root.cashFlow.length !== installments.length) return needsInput;
  const cashByIndex = new Map<number, CashFlowEntry>();
  for (const cash of root.cashFlow) {
    let index: number;
    try {
      index = resolveInstallmentIndex(installments, cash.parcela);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return needsInput;
    }
    if (cashByIndex.has(index)) return needsInput;
    const item = installments[index]!;
    if (
      cash.tenantId !== tenantId ||
      cash.projectId !== root.projectId ||
      cash.expenseId !== root.id ||
      cash.deletedAt ||
      cash.valor !== item.valor ||
      cash.data.getTime() !== item.data.getTime() ||
      (cash.invoiceDueMonth !== null &&
        item.invoiceDueMonth !== null &&
        cash.invoiceDueMonth !== item.invoiceDueMonth)
    )
      return blocked;
    cashByIndex.set(index, cash);
  }
  if (
    !observations.length ||
    new Set(observations.map((row) => row.id)).size !== observations.length
  )
    return needsInput;
  const bindings: Array<{
    observationId: string;
    canonicalIndex: number;
    cashFlowEntryId: string;
  }> = [];
  const amountMatches = (
    input: KeepLineFacts | KeepObservationFacts,
    amount: number,
  ) =>
    input.amountCents ===
    (input.amountMeaning === "TOTAL_PURCHASE" ? root.valorTotal : amount);
  for (const observation of observations) {
    if ([line, observation].some(hasUnknownCardOccurrenceFacts))
      return needsInput;
    if (
      [line, observation].some(
        (input) =>
          input.installmentCount !== purchase.total ||
          (input.dataCompra !== null &&
            root.dataCompra !== null &&
            input.dataCompra !== root.dataCompra.toISOString().slice(0, 10)),
      )
    )
      return blocked;
    if (observation.installmentIndex === null && installments.length > 1)
      return needsInput;
    const matching = installments.filter((item) => {
      if (
        installments.length === 1 &&
        (item.parcela === null || item.parcela === "1/1")
      )
        return (
          observation.installmentCount === 1 &&
          (observation.installmentIndex === null ||
            observation.installmentIndex === 1)
        );
      if (item.parcela === null) return false;
      const label = detectInstallment(item.parcela);
      return (
        label.current === observation.installmentIndex &&
        label.total === observation.installmentCount
      );
    });
    if (matching.length !== 1) return needsInput;
    const item = matching[0]!;
    if (
      !amountMatches(line, item.valor) ||
      !amountMatches(observation, item.valor)
    )
      return blocked;
    const index = resolveInstallmentIndex(installments, item.parcela);
    const cash = cashByIndex.get(index);
    if (!cash) return needsInput;
    bindings.push({
      observationId: observation.id,
      canonicalIndex: index,
      cashFlowEntryId: cash.id,
    });
  }
  return { kind: "COMPATIBLE", bindings };
}

const day = (date: Date | null): string | null =>
  date ? date.toISOString().slice(0, 10) : null;

/** The adjusted line and the invoice context a review decision was made about. */
export interface ReviewLine {
  externalId: string;
  cardId: string;
  projectId: string;
  seriesKey: string | null;
  merchant: string;
  amountCents: number;
  total: number;
  current: number;
  date: Date;
  invoiceDueMonth: string | null;
  documentaryCycle: unknown;
}

/**
 * Hash of everything the reviewer saw: the adjusted line and every offered
 * root with its active cash flow. Dates are reduced to `YYYY-MM-DD` so the hash
 * never depends on the process time zone; server-emitted timestamps
 * (`recordedAt`, `updatedAt`) are deliberately excluded.
 */
export function reviewFingerprint(
  line: ReviewLine,
  roots: readonly ImportFamilyRoot[],
): string {
  const snapshot = {
    v: 1,
    externalId: line.externalId,
    line: {
      cardId: line.cardId,
      projectId: line.projectId,
      seriesKey: line.seriesKey,
      merchant: normalizeSeriesMerchant(line.merchant),
      amountCents: line.amountCents,
      total: line.total,
      current: line.current,
      date: day(line.date),
      invoiceDueMonth: line.invoiceDueMonth,
      documentaryCycle: line.documentaryCycle ?? null,
    },
    roots: [...roots].sort(byId).map((row) => ({
      id: row.id,
      projectId: row.projectId,
      seriesKey: row.seriesKey,
      titulo: row.titulo,
      fornecedor: row.fornecedor,
      dataCompra: day(row.dataCompra),
      valorTotal: row.valorTotal,
      quantidadeParcela: row.quantidadeParcela,
      importId: row.importId,
      cashFlow: [...row.cashFlow].sort(byId).map((entry) => ({
        id: entry.id,
        projectId: entry.projectId,
        parcela: entry.parcela,
        valor: entry.valor,
        status: entry.status,
        data: day(entry.data),
      })),
    })),
  };
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

/** Public-safe candidates: same-project purchase facts only, never cash flow. */
export function reviewCandidates(
  roots: readonly ImportFamilyRoot[],
): CardImportReviewCandidate[] {
  return [...roots].sort(byId).map((row) => {
    const series = parseCardSeries(row.seriesKey)!;
    return {
      expenseId: row.id,
      titulo: row.titulo,
      installmentCount: series.total,
      seriesAmountCents: series.amount,
      dataCompra: day(row.dataCompra),
    };
  });
}

export function reviewItem(
  line: ReviewLine,
  reason: CardImportReviewItem["reason"],
  admission: Extract<ImportAdmission, { kind: "REVIEW" }> | null,
): CardImportReviewItem {
  return {
    externalId: line.externalId,
    reason,
    fingerprint: admission ? reviewFingerprint(line, admission.roots) : null,
    candidates: admission ? reviewCandidates(admission.roots) : [],
  };
}

export { CARD_IMPORT_REVIEW_REASON };
