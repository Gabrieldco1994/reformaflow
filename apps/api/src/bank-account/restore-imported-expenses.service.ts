import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { Expense, Prisma } from "@prisma/client";
import {
  buildInstallments,
  isSinglePaymentForm,
  localDateUtc,
  parsePaidParcelas,
  todayLocalDateUtc,
} from "@reformaflow/domain";
import { INCLUDE_SOFT_DELETED, PrismaService } from "../prisma/prisma.service";
import { RateioRequester } from "../expense/rateio.types";
import {
  ACL_NOT_FOUND_MESSAGE,
  BANK_ACCOUNT_MODULE,
  EXPENSE_MODULE,
  projectTypeHasModule,
} from "../common/access-rules";
import {
  AMBIGUOUS_ACCOUNT_MESSAGE,
  resolveUniqueLegacyMatch,
} from "../common/invoice-identity";
import { assertInlineAccount, currentInlineRequester } from "./inline-expenses";

interface RestoreScope {
  tenantId: string;
  projectId: string;
  accountId: string;
}
export interface RestoreResult {
  fingerprint: string;
  entries: Array<{
    expenseId: string;
    cashFlowEntryId: string;
    externalId: string;
    importId: string;
    valorCents: number;
    date: string;
    status: string;
  }>;
  bankCashDeltaCents: number;
  changed: number;
}
const MAX_SELECTION = 50;
const AUDIT_ACTION = "bankAccounts.restoreImportedExpenses";
const missing = () => new NotFoundException(ACL_NOT_FOUND_MESSAGE);
const conflict = (code = "RESTORE_CONFLICT") =>
  new ConflictException({
    code,
    message:
      "Restauracao indisponivel; confira o historico e solicite uma nova previa.",
  });
type RestoreRequest =
  | { mode: "preview"; externalIds: string[] }
  | { mode: "apply"; externalIds: string[]; expectedFingerprint: string };

function parseRequest(body: unknown): RestoreRequest {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype ||
    !("mode" in body) ||
    !("externalIds" in body)
  ) {
    throw new BadRequestException("Solicitacao de restauracao invalida");
  }
  const ids: unknown = body.externalIds;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_SELECTION ||
    !ids.every(
      (id): id is string =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 200 &&
        id.trim() === id,
    ) ||
    new Set(ids).size !== ids.length
  ) {
    throw new BadRequestException(
      "Selecione identificadores unicos, nao vazios (maximo 50)",
    );
  }
  const externalIds = [...ids].sort();
  const keys = Object.keys(body).sort().join(",");
  if (body.mode === "preview" && keys === "externalIds,mode")
    return { mode: "preview", externalIds };
  if (
    body.mode === "apply" &&
    keys === "expectedFingerprint,externalIds,mode" &&
    "expectedFingerprint" in body &&
    typeof body.expectedFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(body.expectedFingerprint)
  ) {
    return {
      mode: "apply",
      externalIds,
      expectedFingerprint: body.expectedFingerprint,
    };
  }
  throw new BadRequestException("Solicitacao de restauracao invalida");
}

@Injectable()
export class RestoreImportedExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  private async plan(
    tx: Prisma.TransactionClient,
    scope: RestoreScope,
    requester: RateioRequester,
    externalIds: string[],
  ) {
    const { tenantId, projectId, accountId } = scope;
    const actor = await currentInlineRequester(tx, tenantId, requester).catch(
      (error: unknown) => {
        if (error instanceof UnauthorizedException) throw missing();
        throw error;
      },
    );
    const owner = await assertInlineAccount(
      tx,
      tenantId,
      projectId,
      accountId,
      actor,
    );
    if (
      ![BANK_ACCOUNT_MODULE, EXPENSE_MODULE].every((module) =>
        projectTypeHasModule(owner.type, module),
      )
    )
      throw missing();
    const roots = await tx.expense.findMany({
      where: {
        tenantId,
        externalId: { in: externalIds },
        deletedAt: INCLUDE_SOFT_DELETED,
      },
      orderBy: { id: "asc" },
      include: {
        _count: {
          select: {
            cashFlow: {
              where: {
                OR: [
                  { tenantId: { not: tenantId } },
                  { projectId: { not: projectId } },
                ],
              },
            },
          },
        },
      },
    });
    const receipts = await tx.receipt.findMany({
      where: {
        tenantId,
        externalId: { in: externalIds },
        deletedAt: INCLUDE_SOFT_DELETED,
      },
    });
    if (
      receipts.length ||
      roots.length !== externalIds.length ||
      externalIds.some(
        (id) => roots.filter((row) => row.externalId === id).length !== 1,
      ) ||
      roots.some(
        (row) =>
          row.projectId !== projectId ||
          !row.importId ||
          row._count.cashFlow !== 0 ||
          row.bankLast4 !== owner.account.last4 ||
          (row.accountId !== null && row.accountId !== accountId),
      )
    )
      throw missing();
    const batches = await tx.bankStatementImport.findMany({
      where: {
        tenantId,
        accountId,
        id: { in: roots.map((row) => row.importId!) },
        deletedAt: null,
        status: "COMPLETED",
      },
      orderBy: { id: "asc" },
    });
    if (
      roots.some((row) => !batches.some((batch) => batch.id === row.importId))
    )
      throw missing();
    const ids = roots.map((row) => row.id);
    // Parent-scoped count above rejects foreign ownership without reading foreign CFE contents.
    const history = await tx.cashFlowEntry.findMany({
      where: {
        tenantId,
        projectId,
        expenseId: { in: ids },
        deletedAt: INCLUDE_SOFT_DELETED,
      },
      orderBy: { id: "asc" },
    });

    const reverse = await tx.expense.findFirst({
      where: {
        tenantId,
        deletedAt: INCLUDE_SOFT_DELETED,
        OR: [
          { linkedExpenseId: { in: ids } },
          { plannedExpenseId: { in: ids } },
          { settledByExpenseId: { in: ids } },
        ],
      },
    });
    const rateio = await tx.rateioAllocation.findFirst({
      where: {
        tenantId,
        OR: [
          { sourceExpenseId: { in: ids } },
          { targetExpenseId: { in: ids } },
        ],
      },
    });
    const settlement = await tx.crossProjectSettlement.findFirst({
      where: {
        tenantId,
        OR: [
          { sourceExpenseId: { in: ids } },
          { targetExpenseId: { in: ids } },
        ],
      },
    });
    const ledger = await tx.importedInvoiceLiquidation.findFirst({
      where: {
        tenantId,
        deletedAt: INCLUDE_SOFT_DELETED,
        OR: [
          { purchaseExpenseId: { in: ids } },
          { paymentExpenseId: { in: ids } },
          { cashFlowEntryId: { in: history.map((row) => row.id) } },
        ],
      },
    });
    const financing = await tx.financingInstallment.findFirst({
      where: {
        tenantId,
        expenseId: { in: ids },
        deletedAt: INCLUDE_SOFT_DELETED,
      },
    });
    if (reverse || rateio || settlement || ledger || financing)
      throw conflict();

    const entries: RestoreResult["entries"] = [];
    for (const root of roots) {
      if (!root.deletedAt) throw conflict("ALREADY_ACTIVE");
      if (
        root.cardLast4 ||
        root.seriesKey ||
        root.linkedExpenseId ||
        root.plannedExpenseId ||
        root.settledByExpenseId ||
        root.settlesInvoiceKey ||
        root.recorrente ||
        root.recurrenceKey ||
        root.recorrenciaFim ||
        root.paidParcelas ||
        root.installmentDateOverrides ||
        !isSinglePaymentForm(root.formaPagamento) ||
        (root.quantidadeParcela !== null && root.quantidadeParcela !== 1) ||
        root.dataInicioParcela ||
        root.status !== "PAGO" ||
        !root.dataPagamento ||
        root.valorTotal <= 0 ||
        root.valor * root.quantidade !== root.valorTotal ||
        root.createdAt > root.deletedAt ||
        Object.entries(root).some(
          ([key, value]) => key.startsWith("invoiceUndo") && value !== null,
        )
      )
        throw conflict();
      const generations = history.filter((row) => row.expenseId === root.id);
      const cohort = generations.filter(
        (row) => row.deletedAt?.getTime() === root.deletedAt!.getTime(),
      );
      if (
        cohort.length !== 1 ||
        generations.some(
          (row) =>
            !row.deletedAt ||
            row.deletedAt > root.deletedAt! ||
            row.createdAt > row.deletedAt,
        )
      )
        throw conflict();
      const entry = cohort[0];
      if (
        entry.tipo !== "DESPESA" ||
        entry.formaPagamento === "CARTAO_CREDITO" ||
        entry.receiptId ||
        entry.budgetAllocationId ||
        entry.parcela !== null ||
        entry.valor !== root.valorTotal ||
        entry.status !== root.status ||
        entry.data.getTime() !== root.dataPagamento.getTime()
      )
        throw conflict();
      if (
        entries.some(
          (row) =>
            row.valorCents === root.valorTotal &&
            row.date.slice(0, 10) === entry.data.toISOString().slice(0, 10),
        )
      )
        throw conflict();
      await this.assertNoDuplicate(tx, scope, root);
      entries.push({
        expenseId: root.id,
        cashFlowEntryId: entry.id,
        externalId: root.externalId!,
        importId: root.importId!,
        valorCents: entry.valor,
        date: entry.data.toISOString(),
        status: entry.status,
      });
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          scope,
          externalIds,
          actor,
          owner,
          batches,
          roots,
          history,
        }),
      )
      .digest("hex");
    return {
      fingerprint,
      entries,
      roots,
      actor,
      bankCashDeltaCents: -entries.reduce(
        (sum, row) => sum + row.valorCents,
        0,
      ),
    };
  }

  private async assertNoDuplicate(
    tx: Prisma.TransactionClient,
    scope: RestoreScope,
    root: Expense,
  ): Promise<void> {
    const { tenantId, accountId } = scope;
    const identity = [
      { externalId: root.externalId },
      ...(root.dedupeKeyStrong
        ? [{ dedupeKeyStrong: root.dedupeKeyStrong }]
        : []),
    ];
    const expenseMatch = await tx.expense.findFirst({
      where: {
        tenantId,
        id: { not: root.id },
        OR: identity,
        deletedAt: INCLUDE_SOFT_DELETED,
      },
    });
    const receiptMatch = await tx.receipt.findFirst({
      where: { tenantId, OR: identity, deletedAt: INCLUDE_SOFT_DELETED },
    });
    if (expenseMatch || receiptMatch) throw missing();
    const start = new Date(root.dataPagamento!.toISOString().slice(0, 10));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const day = { gte: start, lt: end };
    const candidates = await tx.expense.findMany({
      where: {
        tenantId,
        id: { not: root.id },
        deletedAt: INCLUDE_SOFT_DELETED,
        cashFlow: {
          some: {
            tenantId,
            deletedAt: null,
            tipo: "DESPESA",
            valor: root.valorTotal,
            data: day,
          },
        },
      },
    });
    const payments = await tx.expense.findMany({
      where: {
        tenantId,
        deletedAt: null,
        OR: [{ status: "PAGO" }, { paidParcelas: { not: null } }],
      },
    });
    const today = todayLocalDateUtc();
    for (const candidate of payments) {
      const single = isSinglePaymentForm(candidate.formaPagamento);
      // Match the account's single-payment date and computeCaixaConta's installment anchors.
      const installments = buildInstallments({
        valorTotal: candidate.valorTotal,
        formaPagamento: candidate.formaPagamento,
        quantidadeParcela: candidate.quantidadeParcela,
        dataPagamento:
          candidate.dataPagamento ??
          (single ? localDateUtc(candidate.createdAt) : null),
        dataInicioParcela:
          candidate.dataInicioParcela ??
          candidate.dataPagamento ??
          candidate.createdAt,
        installmentDateOverrides: candidate.installmentDateOverrides,
      });
      const paid = new Set(
        single
          ? []
          : parsePaidParcelas(candidate.paidParcelas, installments.length),
      );
      if (
        installments.some(
          (entry, index) =>
            entry.valor === root.valorTotal &&
            entry.data >= start &&
            entry.data < end &&
            (paid.has(index) ||
              (candidate.status === "PAGO" && entry.data <= today)),
        )
      )
        candidates.push(candidate);
    }
    const unownedDebit = await tx.cashFlowEntry.findFirst({
      where: {
        tenantId,
        projectId: scope.projectId,
        expenseId: null,
        deletedAt: null,
        tipo: "DESPESA",
        valor: root.valorTotal,
        data: day,
      },
    });
    if (unownedDebit) throw conflict();
    for (const candidate of candidates) {
      const sourceId = await this.debitAccount(tx, tenantId, candidate);
      if (sourceId === accountId) throw conflict();
    }
  }

  private async debitAccount(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidate: Expense,
  ): Promise<string | null> {
    // The original bank import is authoritative, even with null accountId or duplicate finals.
    const batch = candidate.importId
      ? await tx.bankStatementImport.findFirst({
          where: {
            id: candidate.importId,
            tenantId,
            deletedAt: INCLUDE_SOFT_DELETED,
          },
        })
      : null;
    const id = batch?.accountId ?? candidate.accountId;
    if (id) {
      const account = await tx.bankAccount.findFirst({
        where: { id, tenantId, deletedAt: INCLUDE_SOFT_DELETED },
      });
      if (
        !account ||
        (candidate.accountId && candidate.accountId !== id) ||
        (candidate.bankLast4 && candidate.bankLast4 !== account.last4)
      )
        throw conflict();
      return id;
    }
    if (!candidate.bankLast4) return null;
    const accounts = await tx.bankAccount.findMany({
      where: {
        tenantId,
        projectId: candidate.projectId,
        last4: candidate.bankLast4,
        deletedAt: null,
      },
      take: 2,
    });
    const account = resolveUniqueLegacyMatch(
      accounts,
      AMBIGUOUS_ACCOUNT_MESSAGE,
    );
    if (!account) throw conflict();
    return account.id;
  }

  async restore(
    scope: RestoreScope,
    requester: RateioRequester,
    body: unknown,
  ): Promise<RestoreResult> {
    const dto = parseRequest(body);
    if (
      !scope ||
      [scope.tenantId, scope.projectId, scope.accountId, requester?.id].some(
        (value) => typeof value !== "string" || !value.trim(),
      )
    )
      throw missing();
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.mode === "apply") {
          // First statement takes SQLite's writer reservation; every authorization/evidence read follows it.
          const locked = await tx.$executeRaw`
            UPDATE bank_accounts SET id = id WHERE id = ${scope.accountId}
              AND tenant_id = ${scope.tenantId} AND project_id = ${scope.projectId} AND deleted_at IS NULL
          `;
          if (locked !== 1) throw missing();
        }
        const plan = await this.plan(tx, scope, requester, dto.externalIds);
        if (dto.mode === "apply") {
          if (dto.expectedFingerprint !== plan.fingerprint) throw conflict();
          for (const entry of plan.entries) {
            const root = plan.roots.find((row) => row.id === entry.expenseId)!;
            const expenseResult = await tx.expense.updateMany({
              where: {
                id: root.id,
                tenantId: scope.tenantId,
                projectId: scope.projectId,
                deletedAt: root.deletedAt,
              },
              data: { deletedAt: null },
            });
            const cashResult = await tx.cashFlowEntry.updateMany({
              where: {
                id: entry.cashFlowEntryId,
                expenseId: root.id,
                tenantId: scope.tenantId,
                projectId: scope.projectId,
                deletedAt: root.deletedAt,
              },
              data: { deletedAt: null },
            });
            if (expenseResult.count !== 1 || cashResult.count !== 1)
              throw conflict();
          }
          await tx.userActivityLog.create({
            data: {
              userId: plan.actor.id,
              tenantId: scope.tenantId,
              action: `${AUDIT_ACTION}:${plan.fingerprint}`,
            },
          });
        }
        return {
          fingerprint: plan.fingerprint,
          entries: plan.entries,
          bankCashDeltaCents: plan.bankCashDeltaCents,
          changed: dto.mode === "apply" ? plan.entries.length : 0,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" ||
          (error.code === "P2010" &&
            ["5", "6"].includes(String(error.meta?.code))) ||
          (error.code === "P2028" && /expired|timeout/i.test(error.message)))
      )
        throw conflict();
      throw error;
    }
  }
}
