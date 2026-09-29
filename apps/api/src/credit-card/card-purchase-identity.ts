import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { INCLUDE_SOFT_DELETED } from "../prisma/prisma.service";
import { detectInstallment } from "./parsers/types";

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

interface PurchaseIdentity {
  id?: string;
  cardId: string;
  projectId: string;
  merchant: string;
  total: number;
  seriesKey: string | null;
  externalId: string | null;
  dedupeKeyStrong: string | null;
}

/**
 * Strong identity is checked for both operations. Restore additionally requires
 * a conservative exclusion proof for the historical cohort. Import does not
 * adopt that cohort: merchant similarity alone cannot connect an ordinary line
 * to an installment purchase. Compatible installments remain ambiguous without
 * a date, amount or status window; passive tombstones never instruct revival.
 */
export async function inspectCardPurchaseCompanions(
  tx: Prisma.TransactionClient,
  tenantId: string,
  purchase: PurchaseIdentity,
  intent: CardPurchaseInspectionIntent,
) {
  if (
    intent !== CARD_PURCHASE_INSPECTION.IMPORT &&
    intent !== CARD_PURCHASE_INSPECTION.RESTORE
  )
    throw new ConflictException(CARD_PURCHASE_CONFLICT);
  const roots = await tx.expense.findMany({
    where: {
      tenantId,
      id: { not: purchase.id },
      deletedAt: INCLUDE_SOFT_DELETED,
      project: { tenantId, deletedAt: null },
    },
    orderBy: { id: "asc" },
    include: {
      cashFlow: {
        where: { tenantId, deletedAt: null },
        orderBy: { id: "asc" },
      },
      _count: {
        select: { cashFlow: { where: { tenantId: { not: tenantId } } } },
      },
    },
  });
  const imports = await tx.creditCardStatementImport.findMany({
    where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
    orderBy: { id: "asc" },
  });
  const cards = await tx.creditCard.findMany({
    where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
    orderBy: { id: "asc" },
  });
  const merchant = normalizeSeriesMerchant(
    detectInstallment(purchase.merchant).cleanMerchant,
  );
  const externalIds = new Set(purchase.externalId ? [purchase.externalId] : []);
  const strongIds = new Set(
    purchase.dedupeKeyStrong ? [purchase.dedupeKeyStrong] : [],
  );
  const sameFamily = (row: (typeof roots)[number]) => {
    if (row.valorTotal <= 0 && !row.cashFlow.some((entry) => entry.valor > 0))
      return false;
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
    const batch = imports.find((item) => item.id === row.importId);
    const ids = new Set(
      [batch?.cardId, series?.cardId].filter((id): id is string => !!id),
    );
    const finals = cards.filter((card) => card.last4 === row.cardLast4);
    if (ids.size) {
      if (!ids.has(purchase.cardId)) return false;
      if (ids.size > 1) return true; // contradictory explicit identities are ambiguous
    } else if (!finals.some((card) => card.id === purchase.cardId)) {
      return false;
    }
    if (purchase.seriesKey && row.seriesKey === purchase.seriesKey) return true;
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
  const family = roots.filter(sameFamily);
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
  if (
    receipts.length ||
    (intent === CARD_PURCHASE_INSPECTION.RESTORE && unowned.length) ||
    companions.some(
      (row) => !row.deletedAt || row.cashFlow.length || row._count.cashFlow,
    )
  ) {
    throw new ConflictException(CARD_PURCHASE_CONFLICT);
  }
  return { companions, receipts, unowned, imports, cards };
}
