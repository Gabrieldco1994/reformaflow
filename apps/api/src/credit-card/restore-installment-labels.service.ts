import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  buildInstallments,
  parseInstallmentDateOverrides,
} from "@reformaflow/domain";
import { INCLUDE_SOFT_DELETED, PrismaService } from "../prisma/prisma.service";
import { RateioRequester } from "../expense/rateio.types";
import {
  ACL_NOT_FOUND_MESSAGE,
  isFullAccessRole,
  projectTypeHasModule,
  userCanAccessProject,
  userCanAccessProjectModule,
} from "../common/access-rules";

interface RestoreScope {
  tenantId: string;
  projectId: string;
  cardId: string;
  importId: string;
  expenseId: string;
}

const conflict = () =>
  new ConflictException("Historico de parcelas indisponivel ou divergente");
type RestoreRequest =
  | { mode: "preview" }
  | { mode: "apply"; expectedFingerprint: string };

function parseRequest(body: unknown): RestoreRequest {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw new BadRequestException("Solicitacao de restauracao invalida");
  }
  const keys = Object.keys(body).sort().join(",");
  if ("mode" in body && body.mode === "preview" && keys === "mode")
    return { mode: "preview" };
  if (
    "mode" in body &&
    body.mode === "apply" &&
    keys === "expectedFingerprint,mode" &&
    "expectedFingerprint" in body &&
    typeof body.expectedFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(body.expectedFingerprint)
  ) {
    return { mode: "apply", expectedFingerprint: body.expectedFingerprint };
  }
  throw new BadRequestException("Solicitacao de restauracao invalida");
}

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

@Injectable()
export class RestoreInstallmentLabelsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolve(
    tx: Prisma.TransactionClient,
    scope: RestoreScope,
    requester: RateioRequester | undefined,
  ) {
    const missing = () => new NotFoundException(ACL_NOT_FOUND_MESSAGE);
    if (
      !scope ||
      !requester ||
      typeof requester.id !== "string" ||
      !requester.id.trim() ||
      typeof requester.role !== "string" ||
      !requester.role.trim() ||
      [
        scope.tenantId,
        scope.projectId,
        scope.cardId,
        scope.importId,
        scope.expenseId,
      ].some((value) => typeof value !== "string" || !value.trim()) ||
      (!isFullAccessRole(requester.role) &&
        [
          requester.allowedProjects,
          requester.allowedModules,
          requester.allowedProjectTypes,
        ].some(
          (grants) =>
            !Array.isArray(grants) ||
            grants.some((value) => typeof value !== "string"),
        ))
    )
      throw missing();
    const { tenantId, projectId, cardId, importId, expenseId } = scope;
    const project = await tx.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
    });
    if (
      !project ||
      !userCanAccessProject(
        requester.role,
        requester.allowedProjects,
        projectId,
      ) ||
      !["creditCards", "expenses"].every(
        (module) =>
          projectTypeHasModule(project.type, module) &&
          userCanAccessProjectModule(
            requester.role,
            requester.allowedProjectTypes,
            requester.allowedModules ?? [],
            project.type,
            module,
          ),
      )
    )
      throw missing();
    const card = await tx.creditCard.findFirst({
      where: { id: cardId, tenantId, projectId, deletedAt: null },
    });
    const batch = await tx.creditCardStatementImport.findFirst({
      where: {
        id: importId,
        tenantId,
        cardId,
        deletedAt: null,
        status: "COMPLETED",
      },
    });
    const expense = await tx.expense.findFirst({
      where: { id: expenseId, tenantId, projectId, importId, deletedAt: null },
    });
    if (!card || !batch || !expense) throw missing();
    return { project, card, batch, expense };
  }

  private async plan(
    tx: Prisma.TransactionClient,
    scope: RestoreScope,
    requester: RateioRequester | undefined,
  ) {
    const parents = await this.resolve(tx, scope, requester);
    const { expense, card } = parents;
    const { tenantId, projectId, expenseId } = scope;
    if (
      !expense.externalId ||
      expense.externalId.startsWith("m1:") ||
      expense.cardLast4 !== card.last4 ||
      expense.bankLast4 ||
      expense.accountId ||
      expense.linkedExpenseId ||
      expense.plannedExpenseId ||
      expense.settledByExpenseId ||
      expense.settlesInvoiceKey ||
      expense.tipoDespesa === "PAGAMENTO_FATURA_CARTAO" ||
      expense.recorrente ||
      expense.recurrenceKey ||
      Object.entries(expense).some(
        ([key, value]) => key.startsWith("invoiceUndo") && value !== null,
      )
    ) {
      throw conflict();
    }
    const all = await tx.cashFlowEntry.findMany({
      where: { tenantId, expenseId, deletedAt: INCLUDE_SOFT_DELETED },
      orderBy: { id: "asc" },
    });
    if (all.some((row) => row.projectId !== projectId)) throw conflict();
    const reverse = await tx.expense.findFirst({
      where: {
        tenantId,
        deletedAt: INCLUDE_SOFT_DELETED,
        OR: [
          { linkedExpenseId: expenseId },
          { plannedExpenseId: expenseId },
          { settledByExpenseId: expenseId },
        ],
      },
      select: { id: true },
    });
    const rateio = await tx.rateioAllocation.findFirst({
      where: {
        tenantId,
        OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }],
      },
      select: { id: true },
    });
    const settlement = await tx.crossProjectSettlement.findFirst({
      where: {
        tenantId,
        OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }],
      },
      select: { id: true },
    });
    const ledger = await tx.importedInvoiceLiquidation.findFirst({
      where: {
        tenantId,
        deletedAt: INCLUDE_SOFT_DELETED,
        OR: [
          { paymentExpenseId: expenseId },
          { purchaseExpenseId: expenseId },
          { cashFlowEntryId: { in: all.map((row) => row.id) } },
        ],
      },
      select: { id: true },
    });
    if (reverse || rateio || settlement || ledger) throw conflict();
    const active = all
      .filter((row) => !row.deletedAt)
      .sort((a, b) => a.data.getTime() - b.data.getTime());
    const history = all
      .filter((row) => row.deletedAt)
      .sort((a, b) => a.data.getTime() - b.data.getTime());
    const series = expense.seriesKey?.split("|");
    if (
      !series ||
      series.length !== 4 ||
      series[0] !== card.id ||
      !series[1] ||
      !/^[1-9]\d*$/.test(series[2]) ||
      !/^[1-9]\d*$/.test(series[3])
    )
      throw conflict();
    const amount = Number(series[2]);
    const total = Number(series[3]);
    const count = active.length;
    // One complete historical generation only; multiple generations require separate review.
    if (
      !Number.isSafeInteger(amount) ||
      !Number.isSafeInteger(total) ||
      total < 2 ||
      !count ||
      count > total ||
      history.length !== count ||
      new Set(history.map((row) => row.deletedAt!.getTime())).size !== 1 ||
      new Set(active.map((row) => row.data.getTime())).size !== count ||
      expense.valorTotal !== amount * count ||
      expense.valor * expense.quantidade !== expense.valorTotal ||
      (count > 1
        ? expense.formaPagamento !== "PARCELADO" ||
          expense.quantidadeParcela !== count
        : expense.formaPagamento !== "A_VISTA" &&
          expense.formaPagamento !== "PARCELADO")
    )
      throw conflict();
    if (
      count === 1 &&
      expense.quantidadeParcela !== null &&
      expense.quantidadeParcela !== 1
    )
      throw conflict();
    if (
      !["PAGO", "PLANEJADO"].includes(expense.status) ||
      !(expense.formaPagamento === "A_VISTA"
        ? expense.dataPagamento
        : expense.dataInicioParcela)
    )
      throw conflict();
    let paid: unknown = [];
    try {
      if (expense.paidParcelas !== null)
        paid = JSON.parse(expense.paidParcelas);
    } catch (error) {
      if (error instanceof SyntaxError) throw conflict();
      throw error;
    }
    if (
      !Array.isArray(paid) ||
      paid.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= count,
      ) ||
      new Set(paid).size !== paid.length
    )
      throw conflict();
    if (expense.installmentDateOverrides !== null) {
      let overrides: unknown;
      try {
        overrides = JSON.parse(expense.installmentDateOverrides);
      } catch (error) {
        if (error instanceof SyntaxError) throw conflict();
        throw error;
      }
      if (
        !overrides ||
        typeof overrides !== "object" ||
        Array.isArray(overrides) ||
        Object.keys(overrides).length !==
          parseInstallmentDateOverrides(expense.installmentDateOverrides, count)
            .size
      ) {
        throw conflict();
      }
    }
    const schedule = buildInstallments(expense);
    if (
      schedule.length !== count ||
      schedule.some(
        (item, index) =>
          item.data.getTime() !== active[index].data.getTime() ||
          item.valor !== active[index].valor ||
          active[index].status !==
            (expense.status === "PAGO" || paid.includes(index)
              ? "PAGO"
              : "PLANEJADO"),
      )
    ) {
      throw conflict();
    }
    const entries = active.map((row, index) => {
      const old = history[index];
      const desiredLabel = `${total - count + index + 1}/${total}`;
      if (
        old.parcela !== desiredLabel ||
        old.data.getTime() !== row.data.getTime() ||
        old.valor !== amount ||
        row.valor !== amount ||
        old.status !== row.status ||
        old.tipo !== "DESPESA" ||
        row.tipo !== "DESPESA" ||
        row.receiptId ||
        old.receiptId ||
        row.budgetAllocationId ||
        old.budgetAllocationId ||
        old.createdAt > old.deletedAt! ||
        row.createdAt < old.deletedAt!
      )
        throw conflict();
      return {
        id: row.id,
        historicalId: old.id,
        currentLabel: row.parcela,
        desiredLabel,
      };
    });
    const restored = entries.every(
      (row) => row.currentLabel === row.desiredLabel,
    );
    const generic = entries.every(
      (row, index) =>
        row.currentLabel === `${index + 1}/${count}` ||
        (count === 1 &&
          expense.formaPagamento === "A_VISTA" &&
          row.currentLabel === null),
    );
    if (!restored && !generic) throw conflict();
    const fingerprint = createHash("sha256")
      .update(
        canonical({
          version: 1,
          scope,
          requester,
          parents,
          history,
          active: active.map(({ parcela, updatedAt, ...row }) => row),
          mapping: entries.map(({ currentLabel, ...row }) => row),
          exclusions: { reverse, rateio, settlement, ledger },
        }),
      )
      .digest("hex");
    return { fingerprint, entries, restored };
  }

  async restore(
    scope: RestoreScope,
    requester: RateioRequester | undefined,
    body: unknown,
  ) {
    const dto = parseRequest(body);
    return this.prisma.$transaction(async (tx) => {
      if (dto.mode === "apply") {
        await this.resolve(tx, scope, requester);
        // Reserve the SQLite writer without changing Expense.updatedAt, then re-read evidence.
        const locked = await tx.$executeRaw`
          UPDATE expenses SET id = id
          WHERE id = ${scope.expenseId} AND tenant_id = ${scope.tenantId}
            AND project_id = ${scope.projectId} AND import_id = ${scope.importId} AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM projects WHERE id = ${scope.projectId}
              AND tenant_id = ${scope.tenantId} AND deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM credit_cards WHERE id = ${scope.cardId}
              AND project_id = ${scope.projectId} AND tenant_id = ${scope.tenantId} AND deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM credit_card_imports WHERE id = ${scope.importId}
              AND card_id = ${scope.cardId} AND tenant_id = ${scope.tenantId}
              AND deleted_at IS NULL AND status = 'COMPLETED')
        `;
        if (locked !== 1) throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
      }
      const plan = await this.plan(tx, scope, requester);
      if (dto.mode === "apply" && dto.expectedFingerprint !== plan.fingerprint)
        throw conflict();
      let changed = 0;
      if (dto.mode === "apply" && !plan.restored) {
        for (const row of plan.entries) {
          const result = await tx.cashFlowEntry
            .updateMany({
              where: {
                id: row.id,
                tenantId: scope.tenantId,
                projectId: scope.projectId,
                expenseId: scope.expenseId,
                deletedAt: null,
                parcela: row.currentLabel,
              },
              data: { parcela: row.desiredLabel },
            })
            .catch((error: unknown) => {
              if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === "P2028"
              ) {
                throw new ConflictException(
                  "Restauracao concorrente; atualize a previa antes de tentar novamente",
                );
              }
              throw error;
            });
          if (result.count !== 1) throw conflict();
          changed++;
        }
      }
      return {
        fingerprint: plan.fingerprint,
        entries: plan.entries,
        changed,
        alreadyRestored: plan.restored,
      };
    });
  }
}
