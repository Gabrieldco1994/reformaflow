import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CashFlowEntry,
  CreditCard,
  CreditCardStatementImport,
  CrossProjectSettlement,
  Expense,
  FinancingInstallment,
  FloorPlanMarker,
  ImportedInvoiceLiquidation,
  Prisma,
  Project,
  RateioAllocation,
  Room,
} from '@prisma/client';
import {
  canUseInlineProject,
  currentInlineRequester,
  resolveInlineProject,
} from '../bank-account/inline-expenses';
import {
  ACL_NOT_FOUND_MESSAGE,
  EXPENSE_MODULE,
  userCanAccessProject,
  userCanAccessProjectModule,
} from '../common/access-rules';
import { IMPORTED_INVOICE_TRAIL_CONFLICT_MESSAGE } from '../common/imported-invoice-trail';
import { MANUAL_INVOICE_KEY_VERSION } from '../common/manual-invoice-key';
import { ADDITIVE, FUNDING_CONFLICT, isActiveFundingRow } from '../conciliacao/additive-settlement';
import { INCLUDE_SOFT_DELETED } from '../prisma/prisma.service';
import { assertRateioRequester, RateioRequester } from './rateio.types';

/**
 * Read model for the removal/refund guard graph (#704 R3).
 *
 * One loader fills it with a bounded number of `IN (...)` queries inside the
 * caller's transaction; the pure evaluators below (and the ones in
 * `removal-decision.ts`, `refund-purpose.service.ts`) only read from it. The
 * single-id DELETE and the batched `canDelete` read run the SAME evaluators.
 * Reading anything that was not prefetched is a programming error
 * (`RemovalContextMiss`, deliberately NOT an HttpException) so a gap can
 * never degrade into a silent `false`/`true`.
 */
type Tx = Prisma.TransactionClient;

export const REFUND_UNLINK_FIRST =
  'Desfaça a finalidade do crédito antes de alterar este vínculo.';
export const RATEIO_PARTICIPANT_MUTATION_MESSAGE =
  'Esta despesa participa de um rateio. Altere valores, status, cronograma, recorrência ou vínculos pelo fluxo dedicado do rateio.';
export const RATEIO_TARGET_DELETE_MESSAGE =
  'Esta despesa é alvo de rateio. Desfaça o rateio na compra fonte antes de removê-la.';
export const SETTLEMENT_PARTICIPANT_MUTATION_MESSAGE =
  'Esta despesa participa de uma conciliação cross-project por parcela. Altere valores, status, cronograma ou vínculos pelo fluxo dedicado: Cartões/Contas → cartão ou conta → Vincular → Desvincular.';
export const SETTLEMENT_TARGET_DELETE_MESSAGE =
  'Esta despesa é alvo de conciliação por parcela. Desvincule a fonte antes de removê-la: Cartões/Contas → cartão ou conta → Vincular → Desvincular.';
export const RELATED_EXPENSE_NOT_FOUND_MESSAGE =
  'Despesa relacionada não encontrada';

export type RateioParticipation = 'source' | 'target' | null;
export type ExpenseWithProject = Expense & { project: Project | null };

export class RemovalContextMiss extends Error {
  constructor(what: string) {
    super(`RemovalContext read of unloaded facts: ${what}`);
    this.name = 'RemovalContextMiss';
  }
}

/** SQLite caps bound variables at 32766; ids are chunked well below it. */
const CHUNK = 900;

export const uniqueIds = (
  ids: Iterable<string | null | undefined>,
): string[] => [...new Set([...ids].filter((id): id is string => !!id))];

const byId = <T extends { id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;


/** Rows by id plus multi-key lookups, so accessors never scan the whole store per subject. */
class Indexed<T extends { id: string }> {
  private readonly rows = new Map<string, T>();
  private readonly byKey: Array<Map<string, T[]>>;
  constructor(private readonly keyers: Array<(row: T) => string | null | undefined>) {
    this.byKey = keyers.map(() => new Map());
  }
  add(row: T): void {
    if (this.rows.has(row.id)) return;
    this.rows.set(row.id, row);
    this.keyers.forEach((keyer, index) => {
      const key = keyer(row);
      if (!key) return;
      const bucket = this.byKey[index].get(key);
      if (bucket) bucket.push(row);
      else this.byKey[index].set(key, [row]);
    });
  }
  find(ids: string[]): T[] {
    const out = new Map<string, T>();
    for (const id of ids)
      for (const index of this.byKey)
        for (const row of index.get(id) ?? []) out.set(row.id, row);
    return [...out.values()].sort(byId);
  }
  all(): T[] {
    return [...this.rows.values()];
  }
}

async function chunked<T>(
  ids: string[],
  read: (part: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK)
    out.push(...(await read(ids.slice(i, i + CHUNK))));
  return out;
}

type ActorOutcome =
  | { actor: RateioRequester & { id: string } }
  | { error: unknown };

export class RemovalContext {
  constructor(readonly tenantId: string) {}

  private readonly expenses = new Map<string, Expense | null>();
  private readonly pointers = new Indexed<Expense>([(r) => r.linkedExpenseId, (r) => r.plannedExpenseId, (r) => r.settledByExpenseId]);
  private readonly projects = new Map<string, Project | null>();
  private readonly allocationRows = new Indexed<RateioAllocation>([(r) => r.sourceExpenseId, (r) => r.targetExpenseId]);
  private readonly allocationFor = new Set<string>();
  private readonly settlementRows = new Indexed<CrossProjectSettlement>([(r) => r.sourceExpenseId, (r) => r.targetExpenseId]);
  private readonly settlementFor = new Set<string>();
  private readonly incomingFor = new Set<string>();
  private readonly cashflowRows = new Indexed<CashFlowEntry>([(r) => r.expenseId]);
  private readonly cashflowFor = new Set<string>();
  private readonly ledgerRows = new Indexed<ImportedInvoiceLiquidation>([(r) => r.paymentExpenseId, (r) => r.purchaseExpenseId, (r) => r.cashFlowEntryId]);
  private readonly ledgerByExpenseFor = new Set<string>();
  private readonly ledgerByCashFlowFor = new Set<string>();
  private readonly financingRows = new Indexed<FinancingInstallment>([(r) => r.expenseId]);
  private readonly financingFor = new Set<string>();
  private readonly markerRows = new Indexed<FloorPlanMarker>([(r) => r.expenseId]);
  private readonly markerFor = new Set<string>();
  private readonly imports = new Map<string, CreditCardStatementImport | null>();
  private readonly cards = new Map<string, CreditCard | null>();
  private readonly rooms = new Map<string, Room | null>();
  private actorOutcome?: ActorOutcome;

  // ---------------------------------------------------------------- loaders

  private putExpense(row: Expense): void {
    this.expenses.set(row.id, row);
    this.pointers.add(row);
  }

  async captureActor(tx: Tx, requester: RateioRequester): Promise<void> {
    if (this.actorOutcome) return;
    try {
      this.actorOutcome = {
        actor: await currentInlineRequester(tx, this.tenantId, requester),
      };
    } catch (error) {
      this.actorOutcome = { error };
    }
  }

  /** The session was already re-read inside this transaction by the caller. */
  setActor(actor: RateioRequester & { id: string }): void {
    this.actorOutcome = { actor };
  }

  /** Re-throws the recorded session failure at the exact step that used to reload it. */
  resolvedActor(): RateioRequester & { id: string } {
    if (!this.actorOutcome) throw new RemovalContextMiss('actor');
    if ('error' in this.actorOutcome) throw this.actorOutcome.error;
    return this.actorOutcome.actor;
  }

  /** Any tenant, any state: callers apply the tenant/live filters they always applied. */
  async loadExpenses(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.expenses.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.expense.findMany({
        where: { id: { in: part }, deletedAt: INCLUDE_SOFT_DELETED },
      }),
    ))
      this.putExpense(row);
    for (const id of todo) if (!this.expenses.has(id)) this.expenses.set(id, null);
  }

  async loadProjects(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.projects.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.project.findMany({
        where: { id: { in: part }, deletedAt: INCLUDE_SOFT_DELETED },
      }),
    ))
      this.projects.set(row.id, row);
    for (const id of todo) if (!this.projects.has(id)) this.projects.set(id, null);
  }

  /** Projects of every expense already loaded plus `extra`; call after the last expense load. */
  async loadReferencedProjects(tx: Tx, extra: string[] = []): Promise<void> {
    await this.loadProjects(tx, [
      ...extra,
      ...[...this.expenses.values()].map((row) => row?.projectId),
    ].filter((id): id is string => !!id));
  }

  async loadAllocations(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.allocationFor.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.rateioAllocation.findMany({
        where: {
          tenantId: this.tenantId,
          OR: [
            { sourceExpenseId: { in: part } },
            { targetExpenseId: { in: part } },
          ],
        },
      }),
    ))
      this.allocationRows.add(row);
    for (const id of todo) this.allocationFor.add(id);
  }

  async loadSettlements(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.settlementFor.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.crossProjectSettlement.findMany({
        where: {
          tenantId: this.tenantId,
          OR: [
            { sourceExpenseId: { in: part } },
            { targetExpenseId: { in: part } },
          ],
        },
      }),
    ))
      this.settlementRows.add(row);
    for (const id of todo) this.settlementFor.add(id);
  }

  /** Rows pointing at `ids` through linked/planned/settledBy, any state. */
  async loadIncoming(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.incomingFor.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.expense.findMany({
        where: {
          tenantId: this.tenantId,
          deletedAt: INCLUDE_SOFT_DELETED,
          OR: [
            { linkedExpenseId: { in: part } },
            { plannedExpenseId: { in: part } },
            { settledByExpenseId: { in: part } },
          ],
        },
      }),
    ))
      this.putExpense(row);
    for (const id of todo) this.incomingFor.add(id);
  }

  async loadCashflow(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.cashflowFor.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.cashFlowEntry.findMany({
        where: {
          tenantId: this.tenantId,
          expenseId: { in: part },
          deletedAt: INCLUDE_SOFT_DELETED,
        },
      }),
    ))
      this.cashflowRows.add(row);
    for (const id of todo) this.cashflowFor.add(id);
  }

  async loadLedgerByExpense(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.ledgerByExpenseFor.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.importedInvoiceLiquidation.findMany({
        where: {
          tenantId: this.tenantId,
          deletedAt: INCLUDE_SOFT_DELETED,
          OR: [
            { paymentExpenseId: { in: part } },
            { purchaseExpenseId: { in: part } },
          ],
        },
      }),
    ))
      this.ledgerRows.add(row);
    for (const id of todo) this.ledgerByExpenseFor.add(id);
  }

  async loadLedgerByCashFlow(tx: Tx, cashFlowIds: string[]): Promise<void> {
    const todo = uniqueIds(cashFlowIds).filter(
      (id) => !this.ledgerByCashFlowFor.has(id),
    );
    for (const row of await chunked(todo, (part) =>
      tx.importedInvoiceLiquidation.findMany({
        where: {
          tenantId: this.tenantId,
          deletedAt: INCLUDE_SOFT_DELETED,
          cashFlowEntryId: { in: part },
        },
      }),
    ))
      this.ledgerRows.add(row);
    for (const id of todo) this.ledgerByCashFlowFor.add(id);
  }

  async loadFinancing(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.financingFor.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.financingInstallment.findMany({
        where: {
          tenantId: this.tenantId,
          expenseId: { in: part },
          deletedAt: INCLUDE_SOFT_DELETED,
        },
      }),
    ))
      this.financingRows.add(row);
    for (const id of todo) this.financingFor.add(id);
  }

  async loadMarkers(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.markerFor.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.floorPlanMarker.findMany({ where: { expenseId: { in: part } } }),
    ))
      this.markerRows.add(row);
    for (const id of todo) this.markerFor.add(id);
  }

  async loadImports(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.imports.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.creditCardStatementImport.findMany({
        where: { id: { in: part }, deletedAt: INCLUDE_SOFT_DELETED },
      }),
    ))
      this.imports.set(row.id, row);
    for (const id of todo) if (!this.imports.has(id)) this.imports.set(id, null);
  }

  async loadCards(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.cards.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.creditCard.findMany({
        where: { id: { in: part }, deletedAt: INCLUDE_SOFT_DELETED },
      }),
    ))
      this.cards.set(row.id, row);
    for (const id of todo) if (!this.cards.has(id)) this.cards.set(id, null);
  }

  async loadRooms(tx: Tx, ids: string[]): Promise<void> {
    const todo = uniqueIds(ids).filter((id) => !this.rooms.has(id));
    for (const row of await chunked(todo, (part) =>
      tx.room.findMany({
        where: { id: { in: part }, deletedAt: INCLUDE_SOFT_DELETED },
      }),
    ))
      this.rooms.set(row.id, row);
    for (const id of todo) if (!this.rooms.has(id)) this.rooms.set(id, null);
  }

  // -------------------------------------------------------------- accessors

  private need(covered: Set<string>, ids: string[], what: string): void {
    for (const id of ids)
      if (!covered.has(id)) throw new RemovalContextMiss(`${what}:${id}`);
  }

  /** Row by id, any tenant/state; `null` when it does not exist. */
  expense(id: string): Expense | null {
    const row = this.expenses.get(id);
    if (row === undefined) throw new RemovalContextMiss(`expense:${id}`);
    return row;
  }

  liveExpense(id: string): Expense | null {
    const row = this.expense(id);
    return row && row.tenantId === this.tenantId && !row.deletedAt ? row : null;
  }

  /** Any state, any tenant (the relation `include` used by the old guards does not filter). */
  project(id: string): Project | null {
    const row = this.projects.get(id);
    if (row === undefined) throw new RemovalContextMiss(`project:${id}`);
    return row;
  }

  liveProject(id: string): Project | null {
    const row = this.project(id);
    return row && row.tenantId === this.tenantId && !row.deletedAt ? row : null;
  }

  expenseWithProject(id: string): ExpenseWithProject | null {
    const row = this.expense(id);
    return row ? { ...row, project: this.project(row.projectId) } : null;
  }

  allocationsOf(ids: string[]): RateioAllocation[] {
    this.need(this.allocationFor, ids, 'allocations');
    return this.allocationRows.find(ids);
  }

  settlementsOf(ids: string[]): CrossProjectSettlement[] {
    this.need(this.settlementFor, ids, 'settlements');
    return this.settlementRows.find(ids);
  }

  /** Active settlements only (`reversedAt IS NULL`). */
  activeSettlementsOf(ids: string[]): CrossProjectSettlement[] {
    return this.settlementsOf(ids).filter((row) => !row.reversedAt);
  }

  /** Rows (any state) whose linked/planned/settledBy pointer targets one of `ids`. */
  incomingOf(ids: string[]): Expense[] {
    this.need(this.incomingFor, ids, 'incoming');
    return this.pointers.find(ids).filter((row) => row.tenantId === this.tenantId);
  }

  /** Live rows mirroring `id` through `linkedExpenseId`. */
  mirrorsOf(id: string): Expense[] {
    return this.incomingOf([id]).filter(
      (row) => row.linkedExpenseId === id && !row.deletedAt,
    );
  }

  cashflowOf(ids: string[]): CashFlowEntry[] {
    this.need(this.cashflowFor, ids, 'cashflow');
    return this.cashflowRows.find(ids);
  }

  ledgerOf(ids: string[]): ImportedInvoiceLiquidation[] {
    this.need(this.ledgerByExpenseFor, ids, 'ledger');
    const cashFlowIds = this.cashflowOf(ids).map((row) => row.id);
    this.need(this.ledgerByCashFlowFor, cashFlowIds, 'ledger-cashflow');
    // Expense.id and CashFlowEntry.id are separate namespaces that may collide, so the
    // shared index is a superset: each key is honoured only against its own column.
    const expenseIds = new Set(ids);
    const cfeIds = new Set(cashFlowIds);
    return this.ledgerRows
      .find([...ids, ...cashFlowIds])
      .filter(
        (row) =>
          expenseIds.has(row.paymentExpenseId) ||
          expenseIds.has(row.purchaseExpenseId) ||
          cfeIds.has(row.cashFlowEntryId),
      );
  }

  /** Ids (among `ids`) that are the PURCHASE of an active import-liquidation claim. */
  activePurchaseTrail(ids: string[]): Set<string> {
    this.need(this.ledgerByExpenseFor, ids, 'ledger');
    const wanted = new Set(ids);
    return new Set(
      this.ledgerRows
        .find(ids)
        .filter((row) => !row.deletedAt && wanted.has(row.purchaseExpenseId))
        .map((row) => row.purchaseExpenseId),
    );
  }

  financingOf(ids: string[]): FinancingInstallment[] {
    this.need(this.financingFor, ids, 'financing');
    return this.financingRows.find(ids);
  }

  markersOf(ids: string[]): FloorPlanMarker[] {
    this.need(this.markerFor, ids, 'markers');
    return this.markerRows.find(ids);
  }

  importById(id: string): CreditCardStatementImport | null {
    const row = this.imports.get(id);
    if (row === undefined) throw new RemovalContextMiss(`import:${id}`);
    return row;
  }

  cardById(id: string): CreditCard | null {
    const row = this.cards.get(id);
    if (row === undefined) throw new RemovalContextMiss(`card:${id}`);
    return row;
  }

  roomById(id: string): Room | null {
    const row = this.rooms.get(id);
    if (row === undefined) throw new RemovalContextMiss(`room:${id}`);
    return row;
  }
}

// ------------------------------------------------------- refund graph facts

/** Same shape/ordering the refund fingerprint has always hashed. */
export function refundGraphOf(ctx: RemovalContext, ids: string[]) {
  return {
    cashflow: ctx.cashflowOf(ids),
    incoming: ctx.incomingOf(ids),
    allocations: ctx.allocationsOf(ids),
    settlements: ctx.settlementsOf(ids),
    ledger: ctx.ledgerOf(ids),
    financing: ctx.financingOf(ids),
    markers: ctx.markersOf(ids),
  };
}

export function refundParticipantIds(
  evidence: ReturnType<typeof refundGraphOf>,
  source: Pick<Expense, 'linkedExpenseId' | 'plannedExpenseId' | 'settledByExpenseId'>,
): string[] {
  return uniqueIds([
    ...evidence.incoming.map((row) => row.id),
    ...evidence.allocations.flatMap((row) => [
      row.sourceExpenseId,
      row.targetExpenseId,
    ]),
    ...evidence.settlements.flatMap((row) => [
      row.sourceExpenseId,
      row.targetExpenseId,
    ]),
    ...evidence.ledger.flatMap((row) => [
      row.paymentExpenseId,
      row.purchaseExpenseId,
    ]),
    source.linkedExpenseId,
    source.plannedExpenseId,
    source.settledByExpenseId,
  ]);
}

/**
 * Everything `planRefund` reads, for every source in `sourceIds`, in a fixed
 * number of chunked queries. `roomIds`/`projectIds` carry request intent that
 * cannot be derived from the graph (preview/apply).
 */
export async function loadRefundFacts(
  tx: Tx,
  ctx: RemovalContext,
  sourceIds: string[],
  intent: { roomIds?: string[]; projectIds?: string[] } = {},
): Promise<void> {
  const sources = uniqueIds(sourceIds);
  await ctx.loadExpenses(tx, sources);
  await ctx.loadAllocations(tx, sources);
  const owned = new Map<string, RateioAllocation>();
  for (const id of sources) {
    const edge = ctx
      .allocationsOf([id])
      .find((row) => row.sourceExpenseId === id && row.isRefundCredit);
    if (edge) owned.set(id, edge);
  }
  await ctx.loadExpenses(
    tx,
    [...owned.values()].map((edge) => edge.targetExpenseId),
  );
  const graphIds = uniqueIds([
    ...sources,
    ...[...owned.values()].map((edge) => edge.targetExpenseId),
  ]);
  await ctx.loadCashflow(tx, graphIds);
  await ctx.loadIncoming(tx, graphIds);
  await ctx.loadAllocations(tx, graphIds);
  await ctx.loadSettlements(tx, graphIds);
  await ctx.loadLedgerByExpense(tx, graphIds);
  await ctx.loadLedgerByCashFlow(
    tx,
    ctx.cashflowOf(graphIds).map((row) => row.id),
  );
  await ctx.loadFinancing(tx, graphIds);
  await ctx.loadMarkers(tx, graphIds);

  // The participant set is per source (its own graph), exactly as planRefund builds it.
  const participants: string[] = [];
  for (const id of sources) {
    const source = ctx.expense(id);
    const target = owned.get(id)?.targetExpenseId;
    const graphOfSource = target ? [id, target] : [id];
    if (source)
      participants.push(
        ...refundParticipantIds(refundGraphOf(ctx, graphOfSource), source),
      );
  }
  await ctx.loadExpenses(tx, participants);

  const batchIds = sources.flatMap((id) => {
    const importId = ctx.expense(id)?.importId;
    return importId ? [importId] : [];
  });
  await ctx.loadImports(tx, batchIds);
  await ctx.loadCards(
    tx,
    batchIds.flatMap((id) => {
      const cardId = ctx.importById(id)?.cardId;
      return cardId ? [cardId] : [];
    }),
  );
  await ctx.loadRooms(tx, [
    ...(intent.roomIds ?? []),
    ...[...owned.values()].flatMap((edge) => {
      const roomId = ctx.expense(edge.targetExpenseId)?.roomId;
      return roomId ? [roomId] : [];
    }),
  ]);
  await ctx.loadReferencedProjects(tx, intent.projectIds ?? []);
}

// -------------------------------------------------- reverse-source read facts

/** Facts for `assertCanReverseSources`: the sources plus their (any-state) targets/pointers. */
export async function loadReverseTargetFacts(
  tx: Tx,
  ctx: RemovalContext,
  sourceIds: string[],
): Promise<void> {
  const sources = uniqueIds(sourceIds);
  await ctx.loadExpenses(tx, sources);
  await ctx.loadAllocations(tx, sources);
  await ctx.loadSettlements(tx, sources);
  await ctx.loadExpenses(tx, reverseTargetIds(ctx, sources));
  await ctx.loadReferencedProjects(tx);
}

/** Adds what `prepareUnratearSource`/`prepareUnsettleBySource` check after the ACL. */
export async function loadReverseClaimFacts(
  tx: Tx,
  ctx: RemovalContext,
  sourceIds: string[],
): Promise<void> {
  const sources = uniqueIds(sourceIds);
  await loadReverseTargetFacts(tx, ctx, sources);
  const targets = uniqueIds([
    ...ctx.allocationsOf(sources).map((row) => row.targetExpenseId),
    ...ctx.settlementsOf(sources).map((row) => row.targetExpenseId),
  ]);
  await ctx.loadAllocations(tx, targets);
  await ctx.loadLedgerByExpense(tx, [...sources, ...targets]);
}

function reverseTargetIds(ctx: RemovalContext, sourceIds: string[]): string[] {
  const wanted = new Set(sourceIds);
  return uniqueIds([
    ...sourceIds.map((id) => ctx.liveExpense(id)?.linkedExpenseId),
    ...ctx
      .allocationsOf(sourceIds)
      .filter((row) => wanted.has(row.sourceExpenseId))
      .map((row) => row.targetExpenseId),
    ...ctx
      .activeSettlementsOf(sourceIds)
      .filter((row) => wanted.has(row.sourceExpenseId))
      .map((row) => row.targetExpenseId),
  ]);
}

// --------------------------------------------------------- pure evaluators

export function requesterCanSeeProject(
  requester: RateioRequester | undefined,
  project: { id: string; type: string } | null | undefined,
  requiredModule: string,
): boolean {
  if (!requester || !project) return false;
  return (
    userCanAccessProject(requester.role, requester.allowedProjects, project.id) &&
    userCanAccessProjectModule(
      requester.role,
      requester.allowedProjectTypes,
      requester.allowedModules ?? [],
      project.type,
      requiredModule,
    )
  );
}

/** `assertInlineProject` over prefetched rows: the context keeps the tenant/live scope, the decision is shared. */
export function inlineProjectFrom(
  ctx: RemovalContext,
  id: string,
  requester: RateioRequester,
  module: Parameters<typeof canUseInlineProject>[2] = EXPENSE_MODULE,
): Project {
  return resolveInlineProject(ctx.liveProject(id), requester, module);
}

export function assertDeletionProvenance(
  existing: { settlesInvoiceKey: string | null; invoiceUndoState?: string | null },
  hasActivePurchaseTrail: boolean,
): void {
  if (
    (existing.settlesInvoiceKey ?? '').startsWith(`${MANUAL_INVOICE_KEY_VERSION}:`)
  ) {
    throw new ConflictException(
      'Este é um pagamento de fatura registrado no cockpit. Desfaça o ' +
        'pagamento na fatura antes de alterá-lo ou removê-lo.',
    );
  }
  if (hasActivePurchaseTrail || existing.invoiceUndoState != null) {
    throw new ConflictException(
      'Esta despesa foi liquidada por um pagamento de fatura importado. ' +
        'Desfaça a importação primeiro.',
    );
  }
}

/** The `isRemove` branch of `ExpenseService.guardImportedInvoiceTrail`. */
export function assertRemovableProvenance(
  existing: {
    settlesInvoiceKey: string | null;
    invoiceUndoState?: string | null;
    documentedSchedule?: string | null;
  },
  hasActivePurchaseTrail: boolean,
): void {
  if (existing.documentedSchedule != null) {
    throw new ConflictException('Cronograma documentado exige correção assistida');
  }
  assertDeletionProvenance(existing, hasActivePurchaseTrail);
}

export function evaluateRateioParticipation(
  rows: Array<{
    sourceExpenseId: string;
    targetExpenseId: string;
    isRefundCredit: boolean;
  }>,
  expenseId: string,
  allowSource: boolean,
  allowTarget: boolean,
): RateioParticipation {
  const isSource = rows.some((row) => row.sourceExpenseId === expenseId);
  const isTarget = rows.some((row) => row.targetExpenseId === expenseId);
  if (rows.some((row) => row.isRefundCredit) && (!allowSource || !allowTarget)) {
    throw new ConflictException(REFUND_UNLINK_FIRST);
  }
  if ((isSource && !allowSource) || (isTarget && !allowTarget)) {
    throw new BadRequestException(
      isTarget && allowSource
        ? RATEIO_TARGET_DELETE_MESSAGE
        : RATEIO_PARTICIPANT_MUTATION_MESSAGE,
    );
  }
  return isSource ? 'source' : isTarget ? 'target' : null;
}

export function evaluateSettlementParticipation(
  activeRows: Array<{
    sourceExpenseId: string;
    targetExpenseId: string;
    mode: string;
  }>,
  expenseId: string,
  allowSource: boolean,
  allowTarget: boolean,
): RateioParticipation {
  if ((!allowSource || !allowTarget) && activeRows.some((row) => row.mode === ADDITIVE)) {
    throw new ConflictException('Desfaça os aportes antes de alterar os dados financeiros.');
  }
  const isSource = activeRows.some((row) => row.sourceExpenseId === expenseId);
  const isTarget = activeRows.some((row) => row.targetExpenseId === expenseId);
  if ((isSource && !allowSource) || (isTarget && !allowTarget)) {
    throw new BadRequestException(
      isTarget && allowSource
        ? SETTLEMENT_TARGET_DELETE_MESSAGE
        : SETTLEMENT_PARTICIPANT_MUTATION_MESSAGE,
    );
  }
  return isSource ? 'source' : isTarget ? 'target' : null;
}

/** `guardActiveFunding` over prefetched rows: the loader scoped tenant/ids, the state is `isActiveFundingRow`. */
export function assertNoActiveFunding(
  ctx: RemovalContext,
  ids: string[],
): void {
  if (!ids.length) return;
  if (ctx.settlementsOf(ids).some(isActiveFundingRow))
    throw new ConflictException(FUNDING_CONFLICT);
}

export function assertNoRefundPurposeFrom(
  ctx: RemovalContext,
  ids: string[],
): void {
  if (ctx.allocationsOf(ids).some((row) => row.isRefundCredit))
    throw new ConflictException(REFUND_UNLINK_FIRST);
}

/** Loop shared with `ConciliacaoService.authorizedTargets`. */
export function assertAuthorizedTargets(
  tenantId: string,
  ids: string[],
  targetsById: Map<
    string,
    { tenantId: string; project: { id: string; type: string; tenantId: string; deletedAt: Date | null } | null }
  >,
  requester: RateioRequester,
  error: (targetExpenseId: string) => Error,
): void {
  for (const id of ids) {
    const target = targetsById.get(id);
    if (
      !target ||
      target.tenantId !== tenantId ||
      !target.project ||
      target.project.tenantId !== tenantId ||
      target.project.deletedAt !== null ||
      !requesterCanSeeProject(requester, target.project, EXPENSE_MODULE)
    ) {
      throw error(id);
    }
  }
}

/** Body of `ConciliacaoService.assertCanReverseSources` over prefetched facts. */
export function assertCanReverseSourcesFrom(
  ctx: RemovalContext,
  sourceIds: string[],
  requester: RateioRequester,
): void {
  assertRateioRequester(requester, new NotFoundException(ACL_NOT_FOUND_MESSAGE));
  const sources = uniqueIds(sourceIds);
  if (sources.length === 0) return;
  const targetIds = reverseTargetIds(ctx, sources);
  const targets = new Map<string, ExpenseWithProject>();
  for (const id of targetIds) {
    const row = ctx.expenseWithProject(id);
    if (row) targets.set(id, row);
  }
  assertAuthorizedTargets(
    ctx.tenantId,
    targetIds,
    targets,
    requester,
    () => new NotFoundException(ACL_NOT_FOUND_MESSAGE),
  );
}

/** Decision core of `ExpenseService.assertCanMutateLinkedRows`, over rows however they were read. */
export function assertLinkedRowsAllowed(
  tenantId: string,
  expense: { linkedExpenseId: string | null },
  direct: Array<{ id: string }>,
  related: Array<{
    project: { id: string; type: string; tenantId: string; deletedAt: Date | null } | null;
  }>,
  requester: RateioRequester,
): void {
  if (
    expense.linkedExpenseId &&
    !direct.some((row) => row.id === expense.linkedExpenseId)
  ) {
    throw new NotFoundException(RELATED_EXPENSE_NOT_FOUND_MESSAGE);
  }
  for (const row of related) {
    if (
      !row.project ||
      row.project.tenantId !== tenantId ||
      row.project.deletedAt !== null ||
      !requesterCanSeeProject(requester, row.project, EXPENSE_MODULE)
    ) {
      throw new NotFoundException(RELATED_EXPENSE_NOT_FOUND_MESSAGE);
    }
  }
}

/** `assertCanMutateLinkedRows` over prefetched facts. */
export function assertCanMutateLinkedRowsFrom(
  ctx: RemovalContext,
  expense: { id: string; linkedExpenseId: string | null },
  requester: RateioRequester,
): void {
  assertRateioRequester(requester);
  const live = (id: string) => ctx.liveExpense(id);
  const direct = uniqueIds([
    expense.id,
    expense.linkedExpenseId,
    ...ctx.mirrorsOf(expense.id).map((row) => row.id),
  ])
    .map(live)
    .filter((row): row is Expense => !!row);
  const directIds = new Set(direct.map((row) => row.id));
  const related = uniqueIds([
    ...directIds,
    ...ctx
      .incomingOf([...directIds])
      .filter(
        (row) =>
          !row.deletedAt && !!row.linkedExpenseId && directIds.has(row.linkedExpenseId),
      )
      .map((row) => row.id),
  ])
    .map((id) => ctx.expenseWithProject(id))
    .filter((row): row is ExpenseWithProject => !!row);
  assertLinkedRowsAllowed(ctx.tenantId, expense, direct, related, requester);
}

/** `ConciliacaoService.prepareUnratearSource` over prefetched facts. */
export function evaluateUnratearSource(
  ctx: RemovalContext,
  sourceExpenseId: string,
  requester: RateioRequester,
): RateioAllocation[] {
  assertRateioRequester(requester, new NotFoundException(ACL_NOT_FOUND_MESSAGE));
  assertNoRefundPurposeFrom(ctx, [sourceExpenseId]);
  assertCanReverseSourcesFrom(ctx, [sourceExpenseId], requester);
  const rows = ctx
    .allocationsOf([sourceExpenseId])
    .filter((row) => row.sourceExpenseId === sourceExpenseId);
  if (rows.length === 0) return rows;
  const targets = rows.map((row) => row.targetExpenseId);
  if (ctx.activePurchaseTrail([sourceExpenseId, ...targets]).size > 0)
    throw new ConflictException(IMPORTED_INVOICE_TRAIL_CONFLICT_MESSAGE);
  assertNoRefundPurposeFrom(ctx, targets);
  return rows;
}

/** `ConciliacaoService.prepareUnsettleBySource` over prefetched facts. */
export function evaluateUnsettleBySource(
  ctx: RemovalContext,
  sourceExpenseId: string,
  requester: RateioRequester,
  legacyReplacementMode: string,
): CrossProjectSettlement[] {
  assertRateioRequester(requester, new NotFoundException(ACL_NOT_FOUND_MESSAGE));
  assertNoActiveFunding(ctx, [sourceExpenseId]);
  assertCanReverseSourcesFrom(ctx, [sourceExpenseId], requester);
  const rows = ctx
    .settlementsOf([sourceExpenseId])
    .filter(
      (row) =>
        row.sourceExpenseId === sourceExpenseId &&
        row.mode === legacyReplacementMode,
    );
  if (rows.length === 0) return rows;
  const targets = rows.map((row) => row.targetExpenseId);
  if (ctx.activePurchaseTrail([sourceExpenseId, ...targets]).size > 0)
    throw new ConflictException(IMPORTED_INVOICE_TRAIL_CONFLICT_MESSAGE);
  assertNoRefundPurposeFrom(ctx, targets);
  return rows;
}
