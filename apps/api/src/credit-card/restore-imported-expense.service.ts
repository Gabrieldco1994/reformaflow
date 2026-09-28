import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  buildInstallments,
  isNeutralExpenseType,
  parseInstallmentDateOverrides,
} from "@reformaflow/domain";
import { INCLUDE_SOFT_DELETED, PrismaService } from "../prisma/prisma.service";
import { RateioRequester } from "../expense/rateio.types";
import {
  assertInlineProject,
  currentInlineRequester,
} from "../bank-account/inline-expenses";
import {
  ACL_NOT_FOUND_MESSAGE,
  projectTypeHasModule,
} from "../common/access-rules";
import { detectInstallment } from "./parsers/types";
import {
  inspectCardPurchaseCompanions,
  parseCardSeries,
} from "./card-purchase-identity";

interface RestoreScope {
  tenantId: string;
  projectId: string;
  cardId: string;
  importId: string;
  expenseId: string;
}
export interface CardRestoreResult {
  expenseId: string;
  importId: string;
  fingerprint: string;
  cohortDeletedAt: string;
  entries: Array<{
    cashFlowEntryId: string;
    valorCents: number;
    date: string;
    status: string;
    parcela: string;
  }>;
  bankCashDeltaCents: 0;
  changedExpenses: number;
  changedCashFlowEntries: number;
}
const missing = () => new NotFoundException(ACL_NOT_FOUND_MESSAGE);
const conflict = (code = "CARD_RESTORE_CONFLICT") =>
  new ConflictException({
    code,
    message: "Historico de compra indisponivel ou divergente",
  });

function parseRequest(
  body: unknown,
): { mode: "preview" } | { mode: "apply"; expectedFingerprint: string } {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  )
    throw new BadRequestException("Solicitacao de restauracao invalida");
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
  )
    return { mode: "apply", expectedFingerprint: body.expectedFingerprint };
  throw new BadRequestException("Solicitacao de restauracao invalida");
}

@Injectable()
export class RestoreImportedExpenseService {
  constructor(private readonly prisma: PrismaService) {}

  private async plan(
    tx: Prisma.TransactionClient,
    scope: RestoreScope,
    requester: RateioRequester,
  ) {
    const { tenantId, projectId, cardId, importId, expenseId } = scope;
    const actor = await currentInlineRequester(tx, tenantId, requester).catch(
      (error: unknown) => {
        if (error instanceof UnauthorizedException) throw missing();
        throw error;
      },
    );
    const project = await assertInlineProject(
      tx,
      tenantId,
      projectId,
      actor,
      "creditCards",
    );
    await assertInlineProject(tx, tenantId, projectId, actor);
    if (
      !["creditCards", "expenses"].every((module) =>
        projectTypeHasModule(project.type, module),
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
    const root = await tx.expense.findFirst({
      where: {
        id: expenseId,
        tenantId,
        projectId,
        importId,
        deletedAt: INCLUDE_SOFT_DELETED,
      },
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
            markers: true,
            importedInvoiceLiquidationsAsPayment: {
              where: { tenantId: { not: tenantId } },
            },
            importedInvoiceLiquidationsAsPurchase: {
              where: { tenantId: { not: tenantId } },
            },
            rateioAsSource: { where: { tenantId: { not: tenantId } } },
            rateioAsTarget: { where: { tenantId: { not: tenantId } } },
            settlementsAsSource: { where: { tenantId: { not: tenantId } } },
            settlementsAsTarget: { where: { tenantId: { not: tenantId } } },
          },
        },
      },
    });
    if (
      !card ||
      !batch ||
      !root ||
      root.cardLast4 !== card.last4 ||
      Object.entries(root._count).some(
        ([key, count]) => key !== "markers" && count > 0,
      )
    )
      throw missing();
    if (!root.deletedAt) throw conflict("ALREADY_ACTIVE");
    const series = parseCardSeries(root.seriesKey);
    const q = root.quantidadeParcela;
    if (
      !series ||
      series.cardId !== cardId ||
      !q ||
      q < 2 ||
      q > 60 ||
      series.total !== q ||
      root.valorTotal <= 0 ||
      root.valor * root.quantidade !== root.valorTotal ||
      series.amount * q !== root.valorTotal ||
      root._count.markers ||
      root.formaPagamento !== "PARCELADO" ||
      root.status !== "PLANEJADO" ||
      !root.dataInicioParcela ||
      isNeutralExpenseType(root.tipoDespesa) ||
      root.bankLast4 ||
      root.accountId ||
      root.recorrente ||
      root.recurrenceKey ||
      root.recorrenciaFim ||
      root.linkedExpenseId ||
      root.plannedExpenseId ||
      root.settledByExpenseId ||
      root.settlesInvoiceKey ||
      root.documentedSchedule ||
      (root.paidParcelas !== null && root.paidParcelas !== "[]") ||
      root.createdAt > root.deletedAt ||
      batch.createdAt > root.createdAt ||
      Object.entries(root).some(
        ([key, value]) => key.startsWith("invoiceUndo") && value !== null,
      )
    )
      throw conflict();
    if (root.installmentDateOverrides !== null) {
      let overrides: unknown;
      try {
        overrides = JSON.parse(root.installmentDateOverrides);
      } catch (error) {
        if (error instanceof SyntaxError) throw conflict();
        throw error;
      }
      if (
        !overrides ||
        typeof overrides !== "object" ||
        Array.isArray(overrides) ||
        Object.keys(overrides).length !==
          parseInstallmentDateOverrides(root.installmentDateOverrides, q).size
      )
        throw conflict();
    }
    const history = await tx.cashFlowEntry.findMany({
      where: {
        tenantId,
        projectId,
        expenseId,
        deletedAt: INCLUDE_SOFT_DELETED,
      },
      orderBy: { id: "asc" },
      include: { _count: { select: { importedInvoiceLiquidations: true } } },
    });
    if (
      history.some(
        (row) =>
          row._count.importedInvoiceLiquidations ||
          !row.deletedAt ||
          row.deletedAt > root.deletedAt! ||
          row.createdAt < root.createdAt ||
          row.createdAt > row.deletedAt,
      )
    )
      throw conflict();
    const cohort = history.filter(
      (row) => row.deletedAt!.getTime() === root.deletedAt!.getTime(),
    );
    const schedule = buildInstallments(root);
    if (
      cohort.length !== q ||
      new Set(cohort.map((row) => row.parcela)).size !== q ||
      cohort.reduce((sum, row) => sum + row.valor, 0) !== root.valorTotal
    )
      throw conflict();
    for (const expected of schedule) {
      const row = cohort.find((entry) => entry.parcela === expected.parcela);
      const label = detectInstallment(`(${row?.parcela ?? ""})`);
      if (
        !row ||
        label.total !== q ||
        label.current !== expected.index + 1 ||
        row.valor <= 0 ||
        row.valor !== expected.valor ||
        row.data.getTime() !== expected.data.getTime() ||
        row.status !== "PLANEJADO" ||
        row.tipo !== "DESPESA" ||
        row.formaPagamento !== "CARTAO_CREDITO" ||
        row.receiptId ||
        row.budgetAllocationId ||
        row.invoiceDueMonth
      )
        throw conflict();
    }
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
    });
    const rateio = await tx.rateioAllocation.findFirst({
      where: {
        tenantId,
        OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }],
      },
    });
    const settlement = await tx.crossProjectSettlement.findFirst({
      where: {
        tenantId,
        OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }],
      },
    });
    const claims = await tx.importedInvoiceLiquidation.findFirst({
      where: {
        tenantId,
        deletedAt: INCLUDE_SOFT_DELETED,
        OR: [
          { purchaseExpenseId: expenseId },
          { paymentExpenseId: expenseId },
          { cashFlowEntryId: { in: history.map((row) => row.id) } },
        ],
      },
    });
    const financing = await tx.financingInstallment.findFirst({
      where: {
        tenantId,
        expenseId,
        deletedAt: INCLUDE_SOFT_DELETED,
      },
    });
    if (reverse || rateio || settlement || claims || financing)
      throw conflict();
    const exclusions = await inspectCardPurchaseCompanions(tx, tenantId, {
      id: expenseId,
      projectId,
      cardId,
      merchant: series.merchant,
      total: q,
      seriesKey: root.seriesKey,
      externalId: root.externalId,
      dedupeKeyStrong: root.dedupeKeyStrong,
    });
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          scope,
          actor,
          project,
          card,
          batch,
          root,
          history,
          cohortIds: cohort.map((row) => row.id),
          exclusions,
        }),
      )
      .digest("hex");
    return { root, cohort, fingerprint, actor };
  }

  async restore(
    scope: RestoreScope,
    requester: RateioRequester,
    body: unknown,
  ): Promise<CardRestoreResult> {
    const dto = parseRequest(body);
    if (
      !scope ||
      [
        scope.tenantId,
        scope.projectId,
        scope.cardId,
        scope.importId,
        scope.expenseId,
        requester?.id,
      ].some((value) => typeof value !== "string" || !value.trim())
    )
      throw missing();
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.mode === "apply") {
          const locked = await tx.$executeRaw`
            UPDATE credit_cards SET id = id WHERE id = ${scope.cardId}
              AND tenant_id = ${scope.tenantId} AND project_id = ${scope.projectId} AND deleted_at IS NULL
          `;
          if (locked !== 1) throw missing();
        }
        const plan = await this.plan(tx, scope, requester);
        if (dto.mode === "apply") {
          if (dto.expectedFingerprint !== plan.fingerprint) throw conflict();
          const restored = await tx.expense.updateMany({
            where: {
              id: scope.expenseId,
              tenantId: scope.tenantId,
              projectId: scope.projectId,
              importId: scope.importId,
              deletedAt: plan.root.deletedAt,
            },
            data: { deletedAt: null },
          });
          if (restored.count !== 1) throw conflict();
          for (const row of plan.cohort) {
            const result = await tx.cashFlowEntry.updateMany({
              where: {
                id: row.id,
                expenseId: scope.expenseId,
                tenantId: scope.tenantId,
                projectId: scope.projectId,
                deletedAt: row.deletedAt,
              },
              data: { deletedAt: null },
            });
            if (result.count !== 1) throw conflict();
          }
          await tx.userActivityLog.create({
            data: {
              userId: plan.actor.id,
              tenantId: scope.tenantId,
              action: `creditCards.restoreImportedExpense:${plan.fingerprint}`,
            },
          });
        }
        return {
          expenseId: scope.expenseId,
          importId: scope.importId,
          fingerprint: plan.fingerprint,
          cohortDeletedAt: plan.root.deletedAt!.toISOString(),
          entries: plan.cohort.map((row) => ({
            cashFlowEntryId: row.id,
            valorCents: row.valor,
            date: row.data.toISOString(),
            status: row.status,
            parcela: row.parcela!,
          })),
          bankCashDeltaCents: 0,
          changedExpenses: dto.mode === "apply" ? 1 : 0,
          changedCashFlowEntries: dto.mode === "apply" ? plan.cohort.length : 0,
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
