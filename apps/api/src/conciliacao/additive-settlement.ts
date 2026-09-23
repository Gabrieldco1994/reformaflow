import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import {
  CashFlowEntry,
  CrossProjectSettlement,
  Expense,
  Prisma,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import {
  AdditiveSettlementCommand,
  AdditiveSettlementResult,
  InstallmentSettlementSummary,
  buildInstallments,
  isNeutralExpenseType,
  isSinglePaymentForm,
  parsePaidParcelas,
} from "@reformaflow/domain";
import { PrismaService, INCLUDE_SOFT_DELETED } from "../prisma/prisma.service";
import { RateioRequester } from "../expense/rateio.types";
import {
  assertInlineAccount,
  assertInlineProject,
  currentInlineRequester,
} from "../bank-account/inline-expenses";
import { ACL_NOT_FOUND_MESSAGE } from "../common/access-rules";
import {
  AMBIGUOUS_ACCOUNT_MESSAGE,
  resolveUniqueLegacyMatch,
} from "../common/invoice-identity";

type Tx = Prisma.TransactionClient;
export const ADDITIVE = "ADDITIVE";
export const LEGACY_REPLACEMENT = "LEGACY_REPLACEMENT";
export const FUNDING_CONFLICT =
  "Desfaça os aportes da parcela antes de alterar seus dados financeiros.";
const drift = () =>
  new ConflictException("A proveniência da conciliação foi alterada.");
const absent = () => new NotFoundException(ACL_NOT_FOUND_MESSAGE);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const statusOf = (paid: number, contracted: number) =>
  paid === 0
    ? ("UNPAID" as const)
    : paid === contracted
      ? ("PAID" as const)
      : ("PARTIAL" as const);

interface Snapshot {
  version: 1;
  source: string;
  target: string;
  pending: string;
  projection: string;
}

function snapshot(row: CrossProjectSettlement): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(row.snapshot ?? "null");
  } catch (error) {
    if (error instanceof SyntaxError) throw drift();
    throw error;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !("target" in value) ||
    typeof value.target !== "string" ||
    !("pending" in value) ||
    typeof value.pending !== "string" ||
    !("projection" in value) ||
    typeof value.projection !== "string" ||
    Object.keys(value).length !== 5 ||
    ![value.source, value.target, value.pending, value.projection].every((v) =>
      /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw drift();
  return {
    version: 1,
    source: value.source,
    target: value.target,
    pending: value.pending,
    projection: value.projection,
  };
}

function rootFinancial(e: Expense) {
  return {
    id: e.id,
    tenantId: e.tenantId,
    projectId: e.projectId,
    valor: e.valor,
    quantidade: e.quantidade,
    valorTotal: e.valorTotal,
    formaPagamento: e.formaPagamento,
    dataPagamento: e.dataPagamento,
    quantidadeParcela: e.quantidadeParcela,
    dataInicioParcela: e.dataInicioParcela,
    dataCompra: e.dataCompra,
    installmentDateOverrides: e.installmentDateOverrides,
    accountId: e.accountId,
    bankLast4: e.bankLast4,
    cardLast4: e.cardLast4,
    origin: e.origin,
    importId: e.importId,
    externalId: e.externalId,
    dedupeKeyStrong: e.dedupeKeyStrong,
    dedupeKeyNatural: e.dedupeKeyNatural,
    linkedExpenseId: e.linkedExpenseId,
    plannedExpenseId: e.plannedExpenseId,
    settledByExpenseId: e.settledByExpenseId,
    settlesInvoiceKey: e.settlesInvoiceKey,
    recorrente: e.recorrente,
    recurrenceKey: e.recurrenceKey,
    seriesKey: e.seriesKey,
    invoiceUndoState: e.invoiceUndoState,
    invoiceUndoParcelaCount: e.invoiceUndoParcelaCount,
    invoiceUndoDueMonth: e.invoiceUndoDueMonth,
    invoiceUndoCardId: e.invoiceUndoCardId,
    invoiceUndoTrailVersion: e.invoiceUndoTrailVersion,
    deletedAt: e.deletedAt,
  };
}
function cashFinancial(e: CashFlowEntry) {
  return {
    id: e.id,
    tenantId: e.tenantId,
    projectId: e.projectId,
    expenseId: e.expenseId,
    receiptId: e.receiptId,
    budgetAllocationId: e.budgetAllocationId,
    tipo: e.tipo,
    valor: e.valor,
    data: e.data,
    status: e.status,
    parcela: e.parcela,
    formaPagamento: e.formaPagamento,
    deletedAt: e.deletedAt,
    createdAt: e.createdAt,
  };
}
function pendingHash(e: CashFlowEntry) {
  return hash({ ...cashFinancial(e), valor: null, deletedAt: null });
}
function sourceHash(e: Expense, cash: CashFlowEntry[], accountId: string) {
  return hash({
    root: rootFinancial(e),
    status: e.status,
    paidParcelas: e.paidParcelas,
    accountId,
    cash: cash.map(cashFinancial),
  });
}

export function validateFundingCommand(
  value: unknown,
): asserts value is AdditiveSettlementCommand {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "mode",
          "targetExpenseId",
          "parcelaIndex",
          "amountCents",
          "requestId",
        ].includes(k),
    ) ||
    !("mode" in value) ||
    value.mode !== ADDITIVE ||
    !("targetExpenseId" in value) ||
    typeof value.targetExpenseId !== "string" ||
    !value.targetExpenseId.trim() ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !value.requestId.trim() ||
    value.requestId.length > 200 ||
    !("parcelaIndex" in value) ||
    typeof value.parcelaIndex !== "number" ||
    !Number.isInteger(value.parcelaIndex) ||
    value.parcelaIndex < 0 ||
    !("amountCents" in value) ||
    typeof value.amountCents !== "number" ||
    !Number.isInteger(value.amountCents) ||
    value.amountCents <= 0 ||
    value.amountCents > 2147483647
  ) {
    throw new BadRequestException("Conciliação aditiva inválida.");
  }
}

/** Explicit import ownership wins over denormalized account fields, including duplicated last4. */
export async function fundingAccount(
  tx: Tx,
  e: Expense,
  actor: RateioRequester,
) {
  let id = e.accountId;
  if (e.importId) {
    const batch = await tx.bankStatementImport.findFirst({
      where: { id: e.importId, tenantId: e.tenantId, deletedAt: null },
    });
    if (
      !batch ||
      batch.status !== "COMPLETED" ||
      (id && id !== batch.accountId)
    )
      throw absent();
    id = batch.accountId;
  } else if (!id) {
    const matches = e.bankLast4
      ? await tx.bankAccount.findMany({
          where: {
            tenantId: e.tenantId,
            projectId: e.projectId,
            last4: e.bankLast4,
            deletedAt: null,
          },
        })
      : [];
    id =
      resolveUniqueLegacyMatch(matches, AMBIGUOUS_ACCOUNT_MESSAGE)?.id ?? null;
  }
  if (!id) throw absent();
  const scope = await assertInlineAccount(
    tx,
    e.tenantId,
    e.projectId,
    id,
    actor,
  );
  if (scope.type !== "PESSOAL") throw absent();
  return scope.account;
}

export async function guardActiveFunding(
  tx: Tx,
  tenantId: string,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  if (
    await tx.crossProjectSettlement.count({
      where: {
        tenantId,
        mode: ADDITIVE,
        reversedAt: null,
        OR: [
          { sourceExpenseId: { in: ids } },
          { targetExpenseId: { in: ids } },
        ],
      },
    })
  )
    throw new ConflictException(FUNDING_CONFLICT);
}

export async function guardFundingProject(
  tx: Tx,
  tenantId: string,
  projectId: string,
): Promise<void> {
  if (
    await tx.crossProjectSettlement.count({
      where: {
        tenantId,
        mode: ADDITIVE,
        reversedAt: null,
        OR: [
          { source: { tenantId, projectId } },
          { target: { tenantId, projectId } },
        ],
      },
    })
  )
    throw new ConflictException(FUNDING_CONFLICT);
}

export async function guardFundingAccount(
  tx: Tx,
  tenantId: string,
  projectId: string,
  id: string,
): Promise<void> {
  const account = await tx.bankAccount.findFirst({
    where: { id, tenantId, projectId, deletedAt: null },
  });
  if (!account) throw absent();
  const imports = await tx.bankStatementImport.findMany({
    where: { tenantId, accountId: id, deletedAt: INCLUDE_SOFT_DELETED },
    select: { id: true },
  });
  if (
    await tx.crossProjectSettlement.count({
      where: {
        tenantId,
        mode: ADDITIVE,
        reversedAt: null,
        source: {
          tenantId,
          projectId,
          OR: [
            { importId: { in: imports.map((row) => row.id) } },
            { importId: null, accountId: id },
            { importId: null, accountId: null, bankLast4: account.last4 },
          ],
        },
      },
    })
  )
    throw new ConflictException(FUNDING_CONFLICT);
}

async function ordinary(
  tx: Tx,
  e: Expense,
  allowLegacySibling = false,
): Promise<void> {
  if (
    e.linkedExpenseId ||
    e.plannedExpenseId ||
    e.settledByExpenseId ||
    e.settlesInvoiceKey ||
    e.recorrente ||
    e.recurrenceKey ||
    e.cardLast4 ||
    e.seriesKey ||
    e.invoiceUndoState !== null ||
    e.invoiceUndoTrailVersion !== null ||
    e.invoiceUndoParcelaCount !== null ||
    e.invoiceUndoDueMonth !== null ||
    e.invoiceUndoCardId !== null ||
    isNeutralExpenseType(e.tipoDespesa) ||
    e.tipoDespesa === "INVESTIMENTOS"
  )
    throw drift();
  const ids = [e.id];
  const legacySources = allowLegacySibling
    ? await tx.crossProjectSettlement.findMany({
        where: {
          tenantId: e.tenantId,
          targetExpenseId: e.id,
          mode: LEGACY_REPLACEMENT,
        },
        select: { sourceExpenseId: true },
      })
    : [];
  const [links, rateio, ledger, financing] = await Promise.all([
    tx.expense.count({
      where: {
        tenantId: e.tenantId,
        deletedAt: null,
        id: { notIn: legacySources.map((row) => row.sourceExpenseId) },
        OR: [
          { linkedExpenseId: e.id },
          { plannedExpenseId: e.id },
          { settledByExpenseId: e.id },
        ],
      },
    }),
    tx.rateioAllocation.count({
      where: {
        tenantId: e.tenantId,
        OR: [{ sourceExpenseId: e.id }, { targetExpenseId: e.id }],
      },
    }),
    tx.importedInvoiceLiquidation.count({
      where: {
        tenantId: e.tenantId,
        OR: [
          { paymentExpenseId: { in: ids } },
          { purchaseExpenseId: { in: ids } },
        ],
      },
    }),
    tx.financingInstallment.count({
      where: { expenseId: e.id, deletedAt: null },
    }),
  ]);
  if (links || rateio || ledger || financing) throw drift();
}

function targetOccurrence(
  target: Expense,
  cash: CashFlowEntry[],
  rows: CrossProjectSettlement[],
  index: number,
) {
  const slices = buildInstallments(target);
  const slice = slices[index];
  if (!slice || slice.valor <= 0)
    throw new BadRequestException("Parcela inválida.");
  if (
    rows.some(
      (row) =>
        row.mode === LEGACY_REPLACEMENT &&
        row.targetExpenseId === target.id &&
        row.parcelaIndex === index,
    )
  )
    throw drift();
  const history = rows.filter(
    (row) =>
      row.mode === ADDITIVE &&
      row.targetExpenseId === target.id &&
      row.parcelaIndex === index,
  );
  const active = history.filter((row) => !row.reversedAt);
  const paidCents = active.reduce((sum, row) => sum + row.realValor, 0);
  const remainingCents = slice.valor - paidCents;
  if (remainingCents < 0) throw drift();
  const pendingCandidates = cash.filter(
    (c) =>
      c.status === "PLANEJADO" &&
      (active.length
        ? c.id === active[0].targetPendingCashFlowEntryId
        : !c.deletedAt &&
          c.parcela ===
            (isSinglePaymentForm(target.formaPagamento)
              ? null
              : slice.parcela)),
  );
  const pending = pendingCandidates[0];
  if (
    pendingCandidates.length !== 1 ||
    !pending ||
    pending.valor !== remainingCents ||
    pending.data.getTime() !== slice.data.getTime() ||
    pending.tipo !== "DESPESA" ||
    pending.projectId !== target.projectId ||
    pending.receiptId ||
    pending.budgetAllocationId ||
    Boolean(pending.deletedAt) !== (remainingCents === 0) ||
    active.some(
      (r) =>
        r.plannedValor !== slice.valor ||
        r.targetPendingCashFlowEntryId !== pending.id ||
        snapshot(r).pending !== pendingHash(pending),
    )
  )
    throw drift();
  const paidSet = new Set(
    target.status === "PAGO"
      ? slices.map((_, i) => i)
      : parsePaidParcelas(target.paidParcelas, slices.length),
  );
  const allowedCashIds = new Set([
    pending.id,
    ...active.map((r) => r.targetPaidCashFlowEntryId),
  ]);
  if (
    cash.some(
      (c) =>
        !c.deletedAt &&
        c.parcela === pending.parcela &&
        !allowedCashIds.has(c.id),
    )
  )
    throw drift();
  if (paidSet.has(index) !== (remainingCents === 0)) throw drift();
  return {
    slices,
    slice,
    history,
    active,
    pending,
    paidSet,
    paidCents,
    remainingCents,
  };
}

async function context(
  tx: Tx,
  tenantId: string,
  projectId: string,
  sourceId: string,
  targetId: string,
  index: number,
  actor: RateioRequester,
  replay?: CrossProjectSettlement | null,
) {
  const rows = await tx.crossProjectSettlement.findMany({
    where: {
      tenantId,
      OR: [
        { sourceExpenseId: sourceId, reversedAt: null },
        { targetExpenseId: targetId, parcelaIndex: index, reversedAt: null },
        ...(replay ? [{ id: replay.id }] : []),
      ],
    },
    orderBy: { id: "asc" },
  });
  const ids = [
    ...new Set([
      sourceId,
      targetId,
      ...rows.flatMap((r) => [r.sourceExpenseId, r.targetExpenseId]),
    ]),
  ];
  const expenses = await tx.expense.findMany({
    where: { tenantId, id: { in: ids }, deletedAt: null },
  });
  if (expenses.length !== ids.length) throw absent();
  for (const e of expenses)
    await assertInlineProject(tx, tenantId, e.projectId, actor);
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const source = byId.get(sourceId)!;
  const target = byId.get(targetId)!;
  if (source.projectId !== projectId || source.projectId === target.projectId)
    throw absent();
  const accounts = new Map<string, string>();
  for (const id of new Set([sourceId, ...rows.map((r) => r.sourceExpenseId)])) {
    accounts.set(id, (await fundingAccount(tx, byId.get(id)!, actor)).id);
  }
  const cash = await tx.cashFlowEntry.findMany({
    where: {
      tenantId,
      expenseId: { in: ids },
      deletedAt: INCLUDE_SOFT_DELETED,
    },
    orderBy: { id: "asc" },
  });
  const cashFor = (id: string) => cash.filter((c) => c.expenseId === id);
  await ordinary(tx, source);
  await ordinary(tx, target, true);
  const sourceCash = cashFor(sourceId).filter((c) => !c.deletedAt);
  if (
    !isSinglePaymentForm(source.formaPagamento) ||
    source.status !== "PAGO" ||
    source.valorTotal <= 0 ||
    sourceCash.length !== 1 ||
    sourceCash[0].status !== "PAGO" ||
    sourceCash[0].tipo !== "DESPESA" ||
    sourceCash[0].valor !== source.valorTotal ||
    sourceCash[0].receiptId ||
    sourceCash[0].budgetAllocationId ||
    !source.dataPagamento ||
    sourceCash[0].data.getTime() !== source.dataPagamento.getTime()
  )
    throw drift();
  const occurrence = targetOccurrence(target, cashFor(targetId), rows, index);
  if (
    rows.some(
      (r) => r.mode === LEGACY_REPLACEMENT && r.sourceExpenseId === sourceId,
    )
  )
    throw drift();
  for (const row of rows.filter((r) => r.mode === ADDITIVE && !r.reversedAt)) {
    const proof = snapshot(row);
    const paid = cash.find((c) => c.id === row.targetPaidCashFlowEntryId);
    if (
      !paid ||
      paid.deletedAt ||
      hash(cashFinancial(paid)) !== proof.projection ||
      sourceHash(
        byId.get(row.sourceExpenseId)!,
        cashFor(row.sourceExpenseId),
        accounts.get(row.sourceExpenseId)!,
      ) !== proof.source ||
      hash(rootFinancial(byId.get(row.targetExpenseId)!)) !== proof.target
    )
      throw drift();
  }
  const consumed = rows
    .filter(
      (r) =>
        r.mode === ADDITIVE && !r.reversedAt && r.sourceExpenseId === sourceId,
    )
    .reduce((sum, r) => sum + r.realValor, 0);
  if (consumed > source.valorTotal) throw drift();
  return {
    source,
    target,
    rows,
    ...occurrence,
    sourceAvailableCents: source.valorTotal - consumed,
    sourceCash: sourceCash[0],
    sourceProof: sourceHash(source, cashFor(sourceId), accounts.get(sourceId)!),
  };
}
type Context = Awaited<ReturnType<typeof context>>;

async function projectTarget(
  tx: Tx,
  ctx: Context,
  paidCents: number,
  index: number,
) {
  const remaining = ctx.slice.valor - paidCents;
  const pendingUpdate = await tx.cashFlowEntry.updateMany({
    where: {
      id: ctx.pending.id,
      tenantId: ctx.target.tenantId,
      expenseId: ctx.target.id,
      deletedAt: ctx.pending.deletedAt,
      valor: ctx.pending.valor,
      status: "PLANEJADO",
    },
    data: { valor: remaining, deletedAt: remaining === 0 ? new Date() : null },
  });
  if (pendingUpdate.count !== 1) throw drift();
  const paidSet = new Set(ctx.paidSet);
  if (remaining === 0) paidSet.add(index);
  else paidSet.delete(index);
  const allPaid = paidSet.size === ctx.slices.length;
  const result = await tx.expense.updateMany({
    where: {
      id: ctx.target.id,
      tenantId: ctx.target.tenantId,
      deletedAt: null,
      status: ctx.target.status,
      paidParcelas: ctx.target.paidParcelas,
      valorTotal: ctx.target.valorTotal,
    },
    data: {
      status: allPaid ? "PAGO" : "PLANEJADO",
      paidParcelas:
        allPaid || !paidSet.size
          ? null
          : JSON.stringify([...paidSet].sort((a, b) => a - b)),
    },
  });
  if (result.count !== 1) throw drift();
}

function result(
  ctx: Context,
  row: CrossProjectSettlement,
  replayed: boolean,
): AdditiveSettlementResult {
  return {
    ok: true,
    settlementId: row.id,
    state: row.reversedAt ? "REVERSED" : "ACTIVE",
    replayed,
    sourceId: row.sourceExpenseId,
    targetId: row.targetExpenseId,
    parcelaIndex: row.parcelaIndex,
    amountCents: row.realValor,
    contractedCents: ctx.slice.valor,
    paidCents: ctx.paidCents,
    remainingCents: ctx.remainingCents,
    sourceAvailableCents: ctx.sourceAvailableCents,
    settlementStatus: statusOf(ctx.paidCents, ctx.slice.valor),
  };
}

async function write<T>(
  prisma: PrismaService,
  tenantId: string,
  requester: RateioRequester,
  action: (tx: Tx, actor: RateioRequester & { id: string }) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        // ponytail: SQLite serializes writers; use database row locks if the storage engine changes.
        await tx.$executeRaw`UPDATE tenants SET id = id WHERE id = ${tenantId}`;
        return action(
          tx,
          await currentInlineRequester(tx, tenantId, requester),
        );
      },
      { timeout: 15000 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P1008", "P2028", "P2034", "P2002"].includes(error.code)
    ) {
      throw new ConflictException({
        code: "RETRYABLE_CONFLICT",
        message: "Tente novamente com a mesma chave.",
      });
    }
    throw error;
  }
}

export async function applyParcelaFunding(
  prisma: PrismaService,
  tenantId: string,
  projectId: string,
  sourceId: string,
  command: unknown,
  requester: RateioRequester,
): Promise<AdditiveSettlementResult> {
  validateFundingCommand(command);
  return write(prisma, tenantId, requester, async (tx, actor) => {
    const existing = await tx.crossProjectSettlement.findFirst({
      where: { tenantId, requestId: command.requestId },
    });
    const ctx = await context(
      tx,
      tenantId,
      projectId,
      sourceId,
      command.targetExpenseId,
      command.parcelaIndex,
      actor,
      existing,
    );
    if (existing) {
      if (
        existing.mode !== ADDITIVE ||
        existing.sourceExpenseId !== sourceId ||
        existing.targetExpenseId !== command.targetExpenseId ||
        existing.parcelaIndex !== command.parcelaIndex ||
        existing.realValor !== command.amountCents
      ) {
        throw new ConflictException("A chave já pertence a outra conciliação.");
      }
      return result(ctx, existing, true);
    }
    if (
      ctx.active.some((r) => r.sourceExpenseId === sourceId) ||
      command.amountCents > ctx.remainingCents ||
      command.amountCents > ctx.sourceAvailableCents
    )
      throw new ConflictException("Saldo insuficiente ou aporte já existente.");
    const paid = await tx.cashFlowEntry.create({
      data: {
        id: randomUUID(),
        tenantId,
        projectId: ctx.target.projectId,
        expenseId: ctx.target.id,
        valor: command.amountCents,
        tipo: "DESPESA",
        data: ctx.sourceCash.data,
        status: "PAGO",
        categoria: ctx.pending.categoria,
        subcategoria: ctx.pending.subcategoria,
        ambiente: ctx.pending.ambiente,
        formaPagamento: null,
        parcela: ctx.pending.parcela,
      },
    });
    const proof: Snapshot = {
      version: 1,
      source: ctx.sourceProof,
      target: hash(rootFinancial(ctx.target)),
      pending: pendingHash(ctx.pending),
      projection: hash(cashFinancial(paid)),
    };
    const row = await tx.crossProjectSettlement.create({
      data: {
        tenantId,
        mode: ADDITIVE,
        requestId: command.requestId,
        sourceExpenseId: sourceId,
        targetExpenseId: ctx.target.id,
        parcelaIndex: command.parcelaIndex,
        realValor: command.amountCents,
        plannedValor: ctx.slice.valor,
        plannedStatus: "PLANEJADO",
        createdByUserId: actor.id,
        sourceCashFlowEntryId: ctx.sourceCash.id,
        targetPaidCashFlowEntryId: paid.id,
        targetPendingCashFlowEntryId: ctx.pending.id,
        snapshot: JSON.stringify(proof),
      },
    });
    await projectTarget(
      tx,
      ctx,
      ctx.paidCents + command.amountCents,
      command.parcelaIndex,
    );
    return result(
      {
        ...ctx,
        paidCents: ctx.paidCents + command.amountCents,
        remainingCents: ctx.remainingCents - command.amountCents,
        sourceAvailableCents: ctx.sourceAvailableCents - command.amountCents,
      },
      row,
      false,
    );
  });
}

export async function undoParcelaFunding(
  prisma: PrismaService,
  tenantId: string,
  projectId: string,
  sourceId: string,
  settlementId: string,
  requester: RateioRequester,
): Promise<AdditiveSettlementResult> {
  return write(prisma, tenantId, requester, async (tx, actor) => {
    const row = await tx.crossProjectSettlement.findFirst({
      where: {
        id: settlementId,
        tenantId,
        sourceExpenseId: sourceId,
        mode: ADDITIVE,
      },
    });
    if (!row) throw absent();
    const ctx = await context(
      tx,
      tenantId,
      projectId,
      sourceId,
      row.targetExpenseId,
      row.parcelaIndex,
      actor,
      row,
    );
    if (row.reversedAt) return result(ctx, row, true);
    const now = new Date();
    const changed = await tx.crossProjectSettlement.updateMany({
      where: { id: row.id, tenantId, mode: ADDITIVE, reversedAt: null },
      data: { reversedAt: now, reversedByUserId: actor.id },
    });
    const projection = await tx.cashFlowEntry.updateMany({
      where: {
        id: row.targetPaidCashFlowEntryId!,
        tenantId,
        expenseId: row.targetExpenseId,
        deletedAt: null,
        valor: row.realValor,
        status: "PAGO",
      },
      data: { deletedAt: now },
    });
    if (changed.count !== 1 || projection.count !== 1) throw drift();
    await projectTarget(
      tx,
      ctx,
      ctx.paidCents - row.realValor,
      row.parcelaIndex,
    );
    return result(
      {
        ...ctx,
        paidCents: ctx.paidCents - row.realValor,
        remainingCents: ctx.remainingCents + row.realValor,
        sourceAvailableCents: ctx.sourceAvailableCents + row.realValor,
      },
      { ...row, reversedAt: now },
      false,
    );
  });
}

/** Totals belong to the target; contributor identity requires authorization of the entire set. */
export async function fundingSummaries(
  tx: Tx,
  tenantId: string,
  ids: string[],
  requester?: RateioRequester,
) {
  const historyRows = await tx.crossProjectSettlement.findMany({
    where: { tenantId, mode: ADDITIVE, targetExpenseId: { in: ids } },
    orderBy: [{ parcelaIndex: "asc" }, { id: "asc" }],
    include: { target: true, source: true },
  });
  const rows = historyRows.filter((row) => row.mode === ADDITIVE);
  const result = new Map<string, InstallmentSettlementSummary[]>();
  for (const targetId of new Set(rows.map((r) => r.targetExpenseId))) {
    const history = rows.filter((r) => r.targetExpenseId === targetId);
    const target = history[0].target;
    const slices = buildInstallments(target);
    const summaries: InstallmentSettlementSummary[] = [];
    for (const index of new Set(history.map((r) => r.parcelaIndex))) {
      const active = history.filter(
        (r) => r.parcelaIndex === index && !r.reversedAt,
      );
      const slice = slices[index];
      if (!slice) {
        if (active.length) throw drift();
        continue;
      }
      const paid = active.reduce((sum, r) => sum + r.realValor, 0);
      let visible = !!requester;
      if (requester)
        for (const row of active) {
          try {
            if (row.source.deletedAt) throw absent();
            await assertInlineProject(
              tx,
              tenantId,
              row.source.projectId,
              requester,
            );
            await fundingAccount(tx, row.source, requester);
          } catch (error) {
            if (
              !(
                error instanceof NotFoundException ||
                error instanceof ConflictException
              )
            )
              throw error;
            visible = false;
          }
        }
      const projections = visible
        ? await tx.cashFlowEntry.findMany({
            where: {
              tenantId,
              id: {
                in: active.flatMap((r) =>
                  r.targetPaidCashFlowEntryId
                    ? [r.targetPaidCashFlowEntryId]
                    : [],
                ),
              },
              deletedAt: null,
            },
          })
        : [];
      summaries.push({
        parcelaIndex: index,
        dueDate: slice.data.toISOString(),
        contractedCents: slice.valor,
        paidCents: paid,
        remainingCents: slice.valor - paid,
        settlementStatus: statusOf(paid, slice.valor),
        ...(visible && projections.length === active.length
          ? {
              contributions: active
                .map((r) => ({
                  settlementId: r.id,
                  sourceId: r.sourceExpenseId,
                  amountCents: r.realValor,
                  paymentDate: projections
                    .find((c) => c.id === r.targetPaidCashFlowEntryId)!
                    .data.toISOString(),
                }))
                .sort(
                  (a, b) =>
                    a.paymentDate.localeCompare(b.paymentDate) ||
                    a.settlementId.localeCompare(b.settlementId),
                ),
            }
          : {}),
      });
    }
    result.set(targetId, summaries);
  }
  // Accounting callers consume history only; authorized expense reads also offer first contributions.
  if (requester && ids.length) {
    const [targets, cash, legacy] = await Promise.all([
      tx.expense.findMany({
        where: { tenantId, id: { in: ids }, deletedAt: null },
      }),
      tx.cashFlowEntry.findMany({
        where: { tenantId, expenseId: { in: ids }, deletedAt: null },
      }),
      tx.crossProjectSettlement.findMany({
        where: {
          tenantId,
          mode: LEGACY_REPLACEMENT,
          targetExpenseId: { in: ids },
        },
      }),
    ]);
    for (const target of targets) {
      const summaries = (result.get(target.id) ?? []).filter(
        (summary) => summary.paidCents > 0,
      );
      if (summaries.length) result.set(target.id, summaries);
      else result.delete(target.id);
      const initial: InstallmentSettlementSummary[] = [];
      const targetCash = cash.filter((entry) => entry.expenseId === target.id);
      for (const [index] of buildInstallments(target).entries()) {
        if (summaries.some((summary) => summary.parcelaIndex === index))
          continue;
        try {
          const occurrence = targetOccurrence(
            target,
            targetCash,
            legacy,
            index,
          );
          initial.push({
            parcelaIndex: index,
            dueDate: occurrence.slice.data.toISOString(),
            contractedCents: occurrence.slice.valor,
            paidCents: 0,
            remainingCents: occurrence.remainingCents,
            settlementStatus: "UNPAID",
            contributions: [],
          });
        } catch (error) {
          if (
            !(
              error instanceof ConflictException ||
              error instanceof BadRequestException
            )
          )
            throw error;
        }
      }
      if (!initial.length) continue;
      try {
        await assertInlineProject(tx, tenantId, target.projectId, requester);
        await ordinary(tx, target, true);
      } catch (error) {
        if (
          !(
            error instanceof ConflictException ||
            error instanceof NotFoundException
          )
        )
          throw error;
        continue;
      }
      result.set(
        target.id,
        [...summaries, ...initial].sort(
          (a, b) => a.parcelaIndex - b.parcelaIndex,
        ),
      );
    }
  }
  return result;
}

export async function enrichFunding<T extends Expense>(
  tx: Tx,
  tenantId: string,
  items: T[],
  requester?: RateioRequester,
) {
  const summaries = await fundingSummaries(
    tx,
    tenantId,
    items.map((e) => e.id),
    requester,
  );
  const enriched: (T & {
    installmentSettlements?: InstallmentSettlementSummary[];
    sourceAvailableCents?: number;
  })[] = items.map((e) => ({
    ...e,
    ...(summaries.has(e.id)
      ? { installmentSettlements: summaries.get(e.id) }
      : {}),
  }));
  if (!requester) return enriched;
  const candidates = items.filter(
    (e) =>
      e.status === "PAGO" &&
      e.valorTotal > 0 &&
      isSinglePaymentForm(e.formaPagamento) &&
      !e.cardLast4 &&
      (e.bankLast4 || e.accountId),
  );
  if (!candidates.length) return enriched;
  const claims = await tx.crossProjectSettlement.findMany({
    where: {
      tenantId,
      reversedAt: null,
      sourceExpenseId: { in: candidates.map((e) => e.id) },
    },
    include: { target: true },
  });
  const cash = await tx.cashFlowEntry.findMany({
    where: {
      tenantId,
      expenseId: { in: candidates.map((e) => e.id) },
      deletedAt: null,
    },
  });
  for (const source of candidates) {
    const owned = claims.filter((r) => r.sourceExpenseId === source.id);
    const entries = cash.filter((c) => c.expenseId === source.id);
    if (
      entries.length !== 1 ||
      entries[0].valor !== source.valorTotal ||
      entries[0].status !== "PAGO" ||
      owned.some((r) => r.mode !== ADDITIVE)
    )
      continue;
    try {
      await fundingAccount(tx, source, requester);
      await ordinary(tx, source);
      for (const row of owned) {
        if (row.target.deletedAt) throw absent();
        await assertInlineProject(
          tx,
          tenantId,
          row.target.projectId,
          requester,
        );
      }
    } catch (error) {
      if (
        !(
          error instanceof NotFoundException ||
          error instanceof ConflictException
        )
      )
        throw error;
      continue; // Unknown availability is intentionally absent, never a success-shaped zero.
    }
    enriched.find((e) => e.id === source.id)!.sourceAvailableCents =
      source.valorTotal - owned.reduce((sum, row) => sum + row.realValor, 0);
  }
  return enriched;
}
