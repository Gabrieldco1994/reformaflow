import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  CashFlowEntry,
  CreditCard,
  Expense,
  Prisma,
  RateioAllocation,
} from "@prisma/client";
import { createHash } from "node:crypto";
import {
  ExpenseType,
  isNeutralExpenseType,
  isSinglePaymentForm,
  PaymentForm,
} from "@reformaflow/domain";
import {
  assertInlineProject,
  canUseInlineProject,
  currentInlineRequester,
} from "../bank-account/inline-expenses";
import {
  ACL_NOT_FOUND_MESSAGE,
  CREDIT_CARD_MODULE,
} from "../common/access-rules";
import { canonical } from "../common/canonical";
import { PrismaService } from "../prisma/prisma.service";
import { RateioRequester } from "./rateio.types";
import {
  inlineProjectFrom,
  loadRefundFacts,
  refundGraphOf,
  refundParticipantIds,
  RemovalContext,
  REFUND_UNLINK_FIRST,
} from "./removal-context";
import {
  RefundPurposeAction,
  RefundPurposeRequest,
  RefundPurposeResponse,
  RefundPurposeStateResponse,
  RefundPurposeSummary,
  UndoRefundPurposeResponse,
} from "./refund-purpose.types";

export { REFUND_UNLINK_FIRST };
const conflict = () =>
  new ConflictException(
    "Dados do crédito alterados ou incompatíveis. Confira os dados e faça uma nova prévia.",
  );
const missing = () => new NotFoundException(ACL_NOT_FOUND_MESSAGE);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseRequest(value: unknown): RefundPurposeRequest {
  if (
    object(value) &&
    text(value.targetProjectId) &&
    (value.roomId === null || text(value.roomId))
  ) {
    const keys = Object.keys(value).sort().join(",");
    if (value.mode === "preview" && keys === "mode,roomId,targetProjectId")
      return {
        mode: "preview",
        targetProjectId: value.targetProjectId,
        roomId: value.roomId,
      };
    if (
      value.mode === "apply" &&
      keys ===
        "expectedFingerprint,expectedRevision,mode,roomId,targetProjectId" &&
      revision(value.expectedRevision) &&
      typeof value.expectedFingerprint === "string" &&
      /^[a-f0-9]{64}$/.test(value.expectedFingerprint)
    ) {
      return {
        mode: "apply",
        targetProjectId: value.targetProjectId,
        roomId: value.roomId,
        expectedRevision: value.expectedRevision,
        expectedFingerprint: value.expectedFingerprint,
      };
    }
  }
  throw new BadRequestException(
    "Solicitação de finalidade de crédito inválida",
  );
}

export async function reserveRefundWriter(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$executeRaw`UPDATE tenants SET id = id WHERE id = ${tenantId} AND deleted_at IS NULL`;
}

export async function assertNoRefundPurpose(
  tx: Prisma.TransactionClient,
  tenantId: string,
  expenseIds: string[],
): Promise<void> {
  if (
    await tx.rateioAllocation.findFirst({
      where: {
        tenantId,
        isRefundCredit: true,
        OR: [
          { sourceExpenseId: { in: expenseIds } },
          { targetExpenseId: { in: expenseIds } },
        ],
      },
    })
  )
    throw new ConflictException(REFUND_UNLINK_FIRST);
}

export function rethrowRefundWriteConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (["P2002", "P2028", "P2034", "P1008"].includes(error.code) ||
      (error.code === "P2010" && ["5", "6"].includes(String(error.meta?.code))))
  )
    throw conflict();
  throw error;
}

function targetRecipe(
  source: Expense,
  targetProjectId: string,
  roomId: string | null,
) {
  return {
    tenantId: source.tenantId,
    projectId: targetProjectId,
    roomId,
    tipoDespesa: source.tipoDespesa,
    categoriaMaoDeObra: source.categoriaMaoDeObra,
    valor: source.valorTotal,
    valorTotal: source.valorTotal,
    quantidade: 1,
    titulo: source.titulo,
    fornecedor: source.fornecedor,
    link: source.link,
    imageUrl: source.imageUrl,
    formaPagamento: PaymentForm.A_VISTA,
    status: "PAGO",
    dataCompra: source.dataCompra,
    dataPagamento: source.dataPagamento,
  };
}

function noOrigin(expense: Expense): boolean {
  return (
    expense.origin === "none" &&
    [
      expense.cardLast4,
      expense.bankLast4,
      expense.accountId,
      expense.importId,
      expense.externalId,
      expense.dedupeKeyStrong,
      expense.dedupeKeyNatural,
      expense.settlesInvoiceKey,
      expense.plannedExpenseId,
      expense.settledByExpenseId,
      expense.linkedExpenseId,
      expense.recurrenceKey,
      expense.seriesKey,
      expense.quantidadeParcela,
      expense.dataInicioParcela,
      expense.paidParcelas,
      expense.installmentDateOverrides,
      expense.recorrenciaFim,
      expense.invoiceUndoState,
      expense.invoiceUndoCardId,
      expense.invoiceUndoDueMonth,
      expense.invoiceUndoParcelaCount,
      expense.invoiceUndoTrailVersion,
    ].every((value) => value === null) &&
    !expense.recorrente &&
    expense.refundPurposeRevision === 0
  );
}

/** Loads the facts for one source, then runs the pure plan (same path the batched `canDelete` read uses). */
async function planRefund(
  tx: Prisma.TransactionClient,
  tenantId: string,
  projectId: string,
  expenseId: string,
  requester: RateioRequester,
  intent: { targetProjectId: string; roomId: string | null },
  allowDeletedSource = false,
) {
  const actor = await currentInlineRequester(tx, tenantId, requester);
  const ctx = new RemovalContext(tenantId);
  await loadRefundFacts(tx, ctx, [expenseId], {
    roomIds: intent.roomId ? [intent.roomId] : [],
    projectIds: [projectId, intent.targetProjectId],
  });
  return planRefundFrom(
    ctx,
    projectId,
    expenseId,
    actor,
    intent,
    allowDeletedSource,
  );
}

/**
 * Source-own facts that make a credit ineligible for ANY destination (no destination term). Pure and
 * side-effect free, so the former single condition can be sliced without changing behavior. `active` are the
 * source's live cash-flow rows as the caller selected them; `sourceCashflow` are all its rows, deleted
 * history included.
 */
function sourceFactsBlocked(
  source: Expense,
  card: Pick<CreditCard, "last4">,
  active: CashFlowEntry[],
  sourceCashflow: CashFlowEntry[],
  projectId: string,
): boolean {
  const occurrence = active[0];
  return Boolean(
    source.valorTotal >= 0 ||
    source.valor * source.quantidade !== source.valorTotal ||
    !Object.values(ExpenseType).includes(source.tipoDespesa as ExpenseType) ||
    isNeutralExpenseType(source.tipoDespesa) ||
    source.tipoDespesa === ExpenseType.INVESTIMENTOS ||
    source.status !== "PAGO" ||
    !isSinglePaymentForm(source.formaPagamento) ||
    !["none", "import"].includes(source.origin) ||
    !source.externalId ||
    source.cardLast4 !== card.last4 ||
    source.bankLast4 ||
    source.accountId ||
    source.recorrente ||
    source.recurrenceKey ||
    source.recorrenciaFim ||
    source.seriesKey ||
    source.plannedExpenseId ||
    source.settledByExpenseId ||
    source.settlesInvoiceKey ||
    source.quantidadeParcela ||
    source.dataInicioParcela ||
    source.paidParcelas ||
    source.installmentDateOverrides ||
    Object.entries(source).some(
      ([key, value]) => key.startsWith("invoiceUndo") && value !== null,
    ) ||
    !source.dataPagamento ||
    active.length !== 1 ||
    !occurrence ||
    occurrence.projectId !== projectId ||
    occurrence.valor !== source.valorTotal ||
    occurrence.status !== "PAGO" ||
    occurrence.tipo !== "DESPESA" ||
    occurrence.receiptId ||
    occurrence.budgetAllocationId ||
    occurrence.data.getTime() !== source.dataPagamento.getTime() ||
    sourceCashflow.some((row) => row.projectId !== projectId),
  );
}

/**
 * Graph facts of the source alone. Without an owned refund edge the source must also be free of any pointer,
 * allocation or incoming reference.
 */
function graphBlocked(
  source: Pick<Expense, "linkedExpenseId">,
  evidence: ReturnType<typeof refundGraphOf>,
  owned: RateioAllocation | undefined,
): boolean {
  return Boolean(
    evidence.settlements.length ||
    evidence.ledger.length ||
    evidence.financing.length ||
    evidence.markers.length ||
    (!owned &&
      (source.linkedExpenseId ||
        evidence.allocations.length ||
        evidence.incoming.length)),
  );
}

/** Statement batch and card of a source as the plan resolves them; `null` when absent, foreign or deleted. */
function batchAndCardOf(
  ctx: RemovalContext,
  source: Expense,
  projectId: string,
) {
  const foundBatch = source.importId ? ctx.importById(source.importId) : null;
  const batch =
    foundBatch && foundBatch.tenantId === ctx.tenantId && !foundBatch.deletedAt
      ? foundBatch
      : null;
  const foundCard = batch ? ctx.cardById(batch.cardId) : null;
  const card =
    foundCard &&
    foundCard.tenantId === ctx.tenantId &&
    foundCard.projectId === projectId &&
    !foundCard.deletedAt
      ? foundCard
      : null;
  return { batch, card };
}

export function planRefundFrom(
  ctx: RemovalContext,
  projectId: string,
  expenseId: string,
  actor: RateioRequester & { id: string },
  intent: { targetProjectId: string; roomId: string | null },
  allowDeletedSource = false,
) {
  const tenantId = ctx.tenantId;
  const sourceProject = inlineProjectFrom(ctx, projectId, actor);
  inlineProjectFrom(ctx, projectId, actor, CREDIT_CARD_MODULE);
  const targetProject = inlineProjectFrom(ctx, intent.targetProjectId, actor);
  const found = ctx.expense(expenseId);
  const source =
    found &&
    found.tenantId === tenantId &&
    found.projectId === projectId &&
    (allowDeletedSource || !found.deletedAt)
      ? found
      : null;
  if (!source) throw missing();
  const foundRoom = intent.roomId ? ctx.roomById(intent.roomId) : null;
  const room =
    foundRoom && foundRoom.projectId === targetProject.id && !foundRoom.deletedAt
      ? foundRoom
      : null;
  if (intent.roomId && !room) throw missing();
  const { batch, card } = batchAndCardOf(ctx, source, projectId);
  if (!source.importId) throw conflict();
  if (!batch || !card) throw missing();
  if (batch.status !== "COMPLETED") throw conflict();
  const edges = ctx
    .allocationsOf([expenseId])
    .filter((row) => row.sourceExpenseId === expenseId);
  const owned = edges.find((row) => row.isRefundCredit);
  const foundTarget = owned ? ctx.expense(owned.targetExpenseId) : null;
  const target =
    foundTarget && foundTarget.tenantId === tenantId && !foundTarget.deletedAt
      ? foundTarget
      : null;
  const evidence = refundGraphOf(ctx, target ? [expenseId, target.id] : [expenseId]);
  const participants = refundParticipantIds(evidence, source).map((id) =>
    ctx.expense(id),
  );
  // The old query was tenant-scoped, any state: a row that is absent or foreign is "missing".
  if (participants.some((row) => !row || row.tenantId !== tenantId))
    throw missing();
  for (const participantProjectId of new Set(
    participants.map((row) => row!.projectId),
  )) {
    if (
      participantProjectId !== sourceProject.id &&
      participantProjectId !== targetProject.id
    )
      inlineProjectFrom(ctx, participantProjectId, actor);
  }
  const sourceCashflow = evidence.cashflow.filter(
    (row) => row.expenseId === expenseId,
  );
  // A deletion caller may have tombstoned the current CFE after its source.
  // Older deleted generations never substitute for that occurrence.
  const active = sourceCashflow.filter(
    (row) =>
      !row.deletedAt ||
      (allowDeletedSource &&
        source.deletedAt &&
        row.deletedAt >= source.deletedAt),
  );
  const occurrence = active[0];
  if (
    projectId === targetProject.id ||
    sourceFactsBlocked(source, card, active, sourceCashflow, projectId) ||
    graphBlocked(source, evidence, owned)
  )
    throw conflict();
  const recipe = targetRecipe(source, targetProject.id, intent.roomId);
  const cfeRecipe = {
    tenantId,
    projectId: targetProject.id,
    valor: source.valorTotal,
    tipo: "DESPESA",
    data: occurrence.data,
    categoria: source.tipoDespesa,
    subcategoria: source.categoriaMaoDeObra,
    ambiente: room?.name ?? null,
    formaPagamento: PaymentForm.A_VISTA,
    status: "PAGO",
    receiptId: null,
    budgetAllocationId: null,
    parcela: null,
  };
  if (owned) {
    if (
      !target ||
      edges.length !== 1 ||
      evidence.allocations.length !== 1 ||
      owned.plannedStatus !== "PAGO" ||
      Object.entries(owned).some(
        ([key, value]) =>
          key.startsWith("planned") &&
          key !== "plannedStatus" &&
          value !== null,
      ) ||
      owned.allocation !== source.valorTotal ||
      source.linkedExpenseId !== target.id ||
      target.deletedAt ||
      !noOrigin(target) ||
      Object.entries(recipe).some(
        ([key, value]) =>
          canonical(target[key as keyof Expense]) !== canonical(value),
      ) ||
      evidence.incoming.length !== 1 ||
      evidence.incoming[0].id !== source.id
    )
      throw conflict();
    const targetCashflow = evidence.cashflow.filter(
      (row) => row.expenseId === target.id,
    );
    if (
      targetCashflow.length !== 1 ||
      targetCashflow[0].deletedAt ||
      targetCashflow[0].createdAt.getTime() !==
        targetCashflow[0].updatedAt.getTime() ||
      Object.entries(cfeRecipe).some(
        ([key, value]) =>
          canonical(
            targetCashflow[0][key as keyof (typeof targetCashflow)[number]],
          ) !== canonical(value),
      )
    )
      throw conflict();
  }

  const { updatedAt, ...sourceBusiness } = source;
  const summary: RefundPurposeSummary = {
    sourceExpenseId: expenseId,
    targetProjectId: targetProject.id,
    roomId: intent.roomId,
    tipoDespesa: source.tipoDespesa as ExpenseType,
    allocationCents: source.valorTotal,
    dataCompra: source.dataCompra?.toISOString() ?? null,
    // Presence is guaranteed by sourceFactsBlocked above.
    dataPagamento: source.dataPagamento!.toISOString(),
    cashFlowDate: occurrence.data.toISOString(),
    cardId: card.id,
    importId: batch.id,
  };
  const fingerprint = (baseRevision: number) =>
    createHash("sha256")
      .update(
        canonical({
          operation: "refund-purpose",
          version: 1,
          scope: { tenantId, projectId, expenseId },
          requester: {
            ...actor,
            allowedProjects: [...(actor.allowedProjects ?? [])].sort(),
            allowedModules: [...(actor.allowedModules ?? [])].sort(),
            allowedProjectTypes: [...(actor.allowedProjectTypes ?? [])].sort(),
          },
          baseRevision,
          intent: {
            targetProjectId: intent.targetProjectId,
            roomId: intent.roomId,
            recipe,
            cfeRecipe,
          },
          source: {
            ...sourceBusiness,
            linkedExpenseId: null,
            refundPurposeRevision: baseRevision,
          },
          sourceCashflow,
          provenance: { batch, card },
          parents: { sourceProject, targetProject, room },
          graph: {
            ...evidence,
            cashflow: sourceCashflow,
            incoming: evidence.incoming.filter(
              (row) => !owned || row.id !== source.id,
            ),
            allocations: evidence.allocations.filter(
              (row) => row.id !== owned?.id,
            ),
          },
        }),
      )
      .digest("hex");
  return { source, target, owned, recipe, cfeRecipe, summary, fingerprint };
}

/** Edge/source/target resolution shared by the loader-backed and batched cleanup checks. */
export function refundCleanupFrom(
  ctx: RemovalContext,
  sourceExpenseId: string,
  actor: () => RateioRequester & { id: string },
) {
  const edge = ctx
    .allocationsOf([sourceExpenseId])
    .find(
      (row) => row.sourceExpenseId === sourceExpenseId && row.isRefundCredit,
    );
  if (!edge) return null;
  const found = ctx.expense(sourceExpenseId);
  const source = found && found.tenantId === ctx.tenantId ? found : null;
  const foundTarget = ctx.expense(edge.targetExpenseId);
  const target =
    foundTarget &&
    foundTarget.tenantId === ctx.tenantId &&
    !foundTarget.deletedAt
      ? foundTarget
      : null;
  if (!source || !target) throw conflict();
  planRefundFrom(
    ctx,
    source.projectId,
    sourceExpenseId,
    actor(),
    { targetProjectId: target.projectId, roomId: target.roomId },
    true,
  );
  return { edge, source, target };
}

/** A required summary field cannot be represented from persisted data; internal, never a wire shape. */
class RefundPurposeSummaryUnrepresentable extends Error {
  constructor() {
    super("Refund purpose summary is not representable");
  }
}

/**
 * Counterpart the public projection may mention: the row is live in this tenant, its project is live and
 * usable for expenses. Every failure collapses into one class; only the ACL's own 404 is absorbed.
 */
function counterpartActive(
  ctx: RemovalContext,
  actor: RateioRequester & { id: string },
  id: string,
): boolean {
  const row = ctx.expense(id);
  if (
    !row ||
    row.tenantId !== ctx.tenantId ||
    row.deletedAt ||
    !ctx.liveProject(row.projectId)
  )
    return false;
  try {
    inlineProjectFrom(ctx, row.projectId, actor);
    return true;
  } catch (error) {
    if (error instanceof NotFoundException) return false;
    throw error;
  }
}

/** Public projection only: drops every pointer/edge that touches a counterpart the reader cannot mention. */
function publicGraphOf(
  ctx: RemovalContext,
  actor: RateioRequester & { id: string },
  source: Expense,
  evidence: ReturnType<typeof refundGraphOf>,
) {
  const seen = new Map<string, boolean>();
  const active = (id: string | null): boolean => {
    if (!id) return false;
    if (!seen.has(id)) seen.set(id, counterpartActive(ctx, actor, id));
    return seen.get(id)!;
  };
  const pointer = (id: string | null) => (active(id) ? id : null);
  return {
    source: {
      ...source,
      linkedExpenseId: pointer(source.linkedExpenseId),
      plannedExpenseId: pointer(source.plannedExpenseId),
      settledByExpenseId: pointer(source.settledByExpenseId),
    },
    evidence: {
      ...evidence,
      incoming: evidence.incoming.filter((row) => active(row.id)),
      allocations: evidence.allocations.filter(
        (row) => active(row.sourceExpenseId) && active(row.targetExpenseId),
      ),
      settlements: evidence.settlements.filter(
        (row) => active(row.sourceExpenseId) && active(row.targetExpenseId),
      ),
      ledger: evidence.ledger.filter(
        (row) => active(row.paymentExpenseId) && active(row.purchaseExpenseId),
      ),
    },
  };
}

/** Persisted columns only; a required one that cannot be represented is corruption, not an empty summary. */
function persistedSummaryOf(
  ctx: RemovalContext,
  source: Expense,
  target: Expense,
  owned: RateioAllocation,
  cardId: string | undefined,
): RefundPurposeSummary {
  const active = ctx
    .cashflowOf([source.id])
    .filter((row) => row.expenseId === source.id && !row.deletedAt);
  if (
    active.length !== 1 ||
    !Number.isInteger(owned.allocation) ||
    !Object.values(ExpenseType).includes(source.tipoDespesa as ExpenseType) ||
    !source.dataPagamento ||
    !cardId ||
    !source.importId
  )
    throw new RefundPurposeSummaryUnrepresentable();
  return {
    sourceExpenseId: source.id,
    targetProjectId: target.projectId,
    roomId: target.roomId,
    tipoDespesa: source.tipoDespesa as ExpenseType,
    allocationCents: owned.allocation,
    dataCompra: source.dataCompra?.toISOString() ?? null,
    dataPagamento: source.dataPagamento.toISOString(),
    cashFlowDate: active[0].data.toISOString(),
    cardId,
    importId: source.importId,
  };
}

/** Everything the reader answers, computed inside the caller's transaction and never writing. */
async function readRefundState(
  tx: Prisma.TransactionClient,
  tenantId: string,
  projectId: string,
  expenseId: string,
  requester: RateioRequester,
): Promise<RefundPurposeStateResponse> {
  const actor = await currentInlineRequester(tx, tenantId, requester);
  const ctx = new RemovalContext(tenantId);
  ctx.setActor(actor);
  await loadRefundFacts(tx, ctx, [expenseId], { projectIds: [projectId] });
  inlineProjectFrom(ctx, projectId, actor);
  inlineProjectFrom(ctx, projectId, actor, CREDIT_CARD_MODULE);
  const found = ctx.expense(expenseId);
  const source =
    found &&
    found.tenantId === tenantId &&
    found.projectId === projectId &&
    !found.deletedAt
      ? found
      : null;
  if (!source) throw missing();
  const { batch, card } = batchAndCardOf(ctx, source, projectId);
  if (source.importId && (!batch || !card)) throw missing();

  const owned = ctx
    .allocationsOf([expenseId])
    .find((row) => row.sourceExpenseId === expenseId && row.isRefundCredit);
  const foundTarget = owned ? ctx.expense(owned.targetExpenseId) : null;
  const targetProject =
    foundTarget && foundTarget.tenantId === tenantId && !foundTarget.deletedAt
      ? ctx.liveProject(foundTarget.projectId)
      : null;
  // Assignment visibility follows the interceptor's predicate (no `hasFeature`), not the graph filter.
  if (
    owned &&
    foundTarget &&
    targetProject &&
    canUseInlineProject(actor, targetProject)
  ) {
    const summary = persistedSummaryOf(
      ctx,
      source,
      foundTarget,
      owned,
      card?.id,
    );
    const actions: RefundPurposeAction[] = [];
    try {
      // DELETE only accepts a valid odd revision, so UNDO is never offered for another persisted value.
      if (
        revision(source.refundPurposeRevision) &&
        source.refundPurposeRevision % 2 === 1 &&
        refundCleanupFrom(ctx, expenseId, () => actor)
      )
        actions.push("UNDO");
    } catch (error) {
      if (
        !(
          error instanceof ConflictException ||
          error instanceof NotFoundException
        )
      )
        throw error;
    }
    return {
      sourceExpenseId: expenseId,
      assignment: { revision: source.refundPurposeRevision, summary },
      actions,
    };
  }

  const graph = publicGraphOf(
    ctx,
    actor,
    source,
    refundGraphOf(ctx, [expenseId]),
  );
  const sourceCashflow = graph.evidence.cashflow.filter(
    (row) => row.expenseId === expenseId,
  );
  const blocked =
    !source.importId ||
    batch?.status !== "COMPLETED" ||
    sourceFactsBlocked(
      graph.source,
      card!,
      sourceCashflow.filter((row) => !row.deletedAt),
      sourceCashflow,
      projectId,
    ) ||
    graphBlocked(graph.source, graph.evidence, undefined);
  return {
    sourceExpenseId: expenseId,
    assignment: null,
    actions: blocked ? [] : ["PREPARE"],
  };
}

/** Lifecycle callers retain the source and its history until owned cleanup has succeeded. */
export async function prepareRefundPurposeCleanup(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sourceExpenseId: string,
  requester: RateioRequester,
) {
  const ctx = new RemovalContext(tenantId);
  await ctx.loadAllocations(tx, [sourceExpenseId]);
  const edge = ctx
    .allocationsOf([sourceExpenseId])
    .find(
      (row) => row.sourceExpenseId === sourceExpenseId && row.isRefundCredit,
    );
  if (!edge) return null;
  await loadRefundFacts(tx, ctx, [sourceExpenseId]);
  // planRefund always re-validates the session first; keep that ordering.
  await ctx.captureActor(tx, requester);
  return refundCleanupFrom(ctx, sourceExpenseId, () => ctx.resolvedActor());
}

type PreparedRefundCleanup = NonNullable<
  Awaited<ReturnType<typeof prepareRefundPurposeCleanup>>
>;

/** Writes only: every read, ACL and drift check already happened in `prepareRefundPurposeCleanup`. */
async function writeRefundPurposeCleanup(
  tx: Prisma.TransactionClient,
  tenantId: string,
  { edge, source, target }: PreparedRefundCleanup,
): Promise<string[]> {
  const now = new Date();
  await tx.cashFlowEntry.updateMany({
    where: { tenantId, expenseId: target.id, deletedAt: null },
    data: { deletedAt: now },
  });
  await tx.expense.update({
    where: { id: target.id },
    data: { deletedAt: now },
  });
  await tx.rateioAllocation.delete({ where: { id: edge.id } });
  const changed = await tx.$executeRaw`
    UPDATE expenses SET linked_expense_id = NULL, refund_purpose_revision = refund_purpose_revision + 1
    WHERE id = ${source.id} AND tenant_id = ${tenantId}
      AND refund_purpose_revision = ${source.refundPurposeRevision} AND linked_expense_id = ${target.id}
  `;
  if (changed !== 1) throw conflict();
  return [target.id];
}

export async function cleanupRefundPurpose(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sourceExpenseId: string,
  requester: RateioRequester,
): Promise<string[] | null> {
  const prepared = await prepareRefundPurposeCleanup(
    tx,
    tenantId,
    sourceExpenseId,
    requester,
  );
  if (!prepared) return null;
  return writeRefundPurposeCleanup(tx, tenantId, prepared);
}

@Injectable()
export class RefundPurposeService {
  private readonly logger = new Logger(RefundPurposeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read-only state of the refund purpose. The single error boundary: expected 4xx pass through, anything else
   * (including a typed 5xx) is one constant log and a generic 500 that keeps the original error as private cause.
   */
  async read(
    tenantId: string,
    projectId: string,
    expenseId: string,
    requester: RateioRequester,
  ): Promise<RefundPurposeStateResponse> {
    try {
      if (
        !requester ||
        !text(requester.id) ||
        ![tenantId, projectId, expenseId].every(text)
      )
        throw missing();
      return await this.prisma.$transaction((tx) =>
        readRefundState(tx, tenantId, projectId, expenseId, requester),
      );
    } catch (error) {
      if (
        error instanceof HttpException &&
        error.getStatus() >= 400 &&
        error.getStatus() < 500
      )
        throw error;
      this.logger.error("Refund purpose read failed");
      throw new InternalServerErrorException(undefined, {
        cause: error,
        description: "Internal Server Error",
      });
    }
  }

  async execute(
    tenantId: string,
    projectId: string,
    expenseId: string,
    requester: RateioRequester,
    body: unknown,
  ): Promise<RefundPurposeResponse> {
    const dto = parseRequest(body);
    if (
      !requester ||
      !text(requester.id) ||
      ![tenantId, projectId, expenseId].every(text)
    )
      throw missing();
    return this.prisma
      .$transaction(async (tx): Promise<RefundPurposeResponse> => {
        if (dto.mode === "apply") await reserveRefundWriter(tx, tenantId);
        const plan = await planRefund(
          tx,
          tenantId,
          projectId,
          expenseId,
          requester,
          dto,
        );
        if (dto.mode === "preview") {
          if (plan.owned) throw conflict();
          return {
            mode: "preview",
            revision: plan.source.refundPurposeRevision,
            fingerprint: plan.fingerprint(plan.source.refundPurposeRevision),
            summary: plan.summary,
          };
        }
        if (
          plan.source.refundPurposeRevision !==
            dto.expectedRevision + (plan.owned ? 1 : 0) ||
          plan.fingerprint(dto.expectedRevision) !== dto.expectedFingerprint
        )
          throw conflict();
        if (plan.owned && plan.target) {
          if (
            plan.target.createdByUserId !== requester.id ||
            plan.target.createdAt.getTime() !== plan.target.updatedAt.getTime()
          )
            throw conflict();
          return {
            mode: "apply",
            revision: plan.source.refundPurposeRevision,
            fingerprint: dto.expectedFingerprint,
            summary: plan.summary,
            targetExpenseId: plan.target.id,
            alreadyApplied: true,
          };
        }
        const target = await tx.expense.create({
          data: { ...plan.recipe, createdByUserId: requester.id },
        });
        await tx.cashFlowEntry.create({
          data: { ...plan.cfeRecipe, expenseId: target.id },
        });
        await tx.rateioAllocation.create({
          data: {
            tenantId,
            sourceExpenseId: expenseId,
            targetExpenseId: target.id,
            allocation: plan.source.valorTotal,
            isRefundCredit: true,
            plannedStatus: "PAGO",
          },
        });
        const changed = await tx.$executeRaw`
        UPDATE expenses SET linked_expense_id = ${target.id}, refund_purpose_revision = refund_purpose_revision + 1
        WHERE id = ${expenseId} AND tenant_id = ${tenantId} AND project_id = ${projectId}
          AND refund_purpose_revision = ${dto.expectedRevision} AND linked_expense_id IS NULL AND deleted_at IS NULL
      `;
        if (changed !== 1) throw conflict();
        return {
          mode: "apply",
          revision: dto.expectedRevision + 1,
          fingerprint: dto.expectedFingerprint,
          summary: plan.summary,
          targetExpenseId: target.id,
          alreadyApplied: false,
        };
      })
      .catch(rethrowRefundWriteConflict);
  }

  async undo(
    tenantId: string,
    projectId: string,
    expenseId: string,
    requester: RateioRequester,
    body: unknown,
  ): Promise<UndoRefundPurposeResponse> {
    if (
      !requester ||
      !text(requester.id) ||
      ![tenantId, projectId, expenseId].every(text)
    )
      throw missing();
    if (
      !object(body) ||
      Object.keys(body).join(",") !== "expectedRevision" ||
      !revision(body.expectedRevision) ||
      body.expectedRevision % 2 !== 1
    )
      throw new BadRequestException("Revisão aplicada inválida");
    const expectedRevision = body.expectedRevision;
    return this.prisma
      .$transaction(async (tx) => {
        await reserveRefundWriter(tx, tenantId);
        const actor = await currentInlineRequester(tx, tenantId, requester);
        await assertInlineProject(tx, tenantId, projectId, actor);
        await assertInlineProject(
          tx,
          tenantId,
          projectId,
          actor,
          CREDIT_CARD_MODULE,
        );
        const source = await tx.expense.findFirst({
          where: { tenantId, projectId, id: expenseId, deletedAt: null },
        });
        if (!source) throw missing();
        if (
          source.refundPurposeRevision === expectedRevision + 1 &&
          !source.linkedExpenseId
        ) {
          await assertNoRefundPurpose(tx, tenantId, [expenseId]);
          return {
            revision: source.refundPurposeRevision,
            alreadyUndone: true,
          };
        }
        // Read-only: resolves the owned target's ACL before any revision comparison, so a
        // hidden target answers the same 404 whatever revision the caller sent.
        const prepared = await prepareRefundPurposeCleanup(
          tx,
          tenantId,
          expenseId,
          actor,
        );
        if (source.refundPurposeRevision !== expectedRevision || !prepared)
          throw conflict();
        await writeRefundPurposeCleanup(tx, tenantId, prepared);
        return { revision: expectedRevision + 1, alreadyUndone: false };
      })
      .catch(rethrowRefundWriteConflict);
  }
}
