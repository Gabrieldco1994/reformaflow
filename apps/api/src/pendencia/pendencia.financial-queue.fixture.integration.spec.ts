/**
 * B0 (#447) verification delta — `PendenciaController.findFinancialQueue`
 * ("pendencia financeiras") derives its entire queue from
 * `MonthlyOverviewService.getAccountView`, exactly like the finance-center
 * fixture spec (`../monthly-overview/finance-center.fixture.integration.spec.ts`).
 * It inherits whatever leak exists there — this spec proves the sibling
 * PESSOAL sentinel leak (already reproduced at `getAccountView`, see the
 * sibling spec) also reaches this DIFFERENT, requester-facing surface.
 *
 * Not certifying production data; synthetic fixture only, same limits as
 * #446 (see the sibling integration spec's header).
 */
// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  cleanupFinanceCenterFixture,
  FINANCE_CENTER_CLOCK,
  FINANCE_CENTER_IDS,
  FINANCE_CENTER_MONTH,
  persistFinanceCenterFixture,
} from "../monthly-overview/__fixtures__/finance-center.fixture";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { PendenciaService } from "./pendencia.service";

const IDS = FINANCE_CENTER_IDS;

describe("PendenciaService.findFinancialQueue — hidden/multi-PESSOAL scope delta (B0 #447)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  // Sempre classifica QUALQUER descrição — determinístico, sem depender de
  // cache real; o que este teste prova é escopo/anchor, não a heurística do
  // classificador.
  const merchantClassifierService = {
    fromCache: jest.fn().mockResolvedValue({ category: "alimentação" }),
  };
  const bankAccountService = {
    loadCardsWithEntries: jest.fn().mockResolvedValue([]),
  };
  const pendencia = new PendenciaService(
    prisma,
    monthly,
    merchantClassifierService as any,
    bankAccountService as any,
  );

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "setInterval",
        "setTimeout",
      ],
    });
    jest.setSystemTime(FINANCE_CENTER_CLOCK);
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await persistFinanceCenterFixture(setupPrisma);
  });

  afterAll(async () => {
    await cleanupFinanceCenterFixture(setupPrisma);
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
    jest.useRealTimers();
  });

  it("never lets a sibling PESSOAL's expense enter the financial pendencia queue (sentinel 101)", async () => {
    const sentinelExpenseId = "fc-a-second-pessoal-sentinel-queue";
    const sentinelEntryId = "fc-a-cfe-second-pessoal-sentinel-queue";

    await prisma.expense.create({
      data: {
        id: sentinelExpenseId,
        tenantId: IDS.tenantA,
        projectId: IDS.projects.secondPessoal,
        tipoDespesa: "OUTROS",
        titulo: "Fila sentinela segundo PESSOAL",
        fornecedor: "Fornecedor sintético",
        valor: 101,
        quantidade: 1,
        valorTotal: 101,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-08-15T12:00:00.000Z"),
        dataCompra: new Date("2026-08-15T12:00:00.000Z"),
        status: "PAGO",
        externalId: "fc-second-pessoal-sentinel-queue",
        createdAt: new Date("2026-08-15T12:00:00.000Z"),
        updatedAt: new Date("2026-08-15T12:00:00.000Z"),
      },
    });
    await prisma.cashFlowEntry.create({
      data: {
        id: sentinelEntryId,
        tenantId: IDS.tenantA,
        projectId: IDS.projects.secondPessoal,
        expenseId: sentinelExpenseId,
        valor: 101,
        tipo: "DESPESA",
        data: new Date("2026-08-15T12:00:00.000Z"),
        categoria: "OUTROS",
        formaPagamento: "A_VISTA",
        status: "PAGO",
        createdAt: new Date("2026-08-15T12:00:00.000Z"),
        updatedAt: new Date("2026-08-15T12:00:00.000Z"),
      },
    });

    try {
      const queue = await pendencia.findFinancialQueue(
        IDS.tenantA,
        IDS.projects.pessoal,
        FINANCE_CENTER_MONTH,
      );
      const allExpenseIds = queue.grupos.flatMap((group) =>
        group.itens.map((item) => item.expenseId),
      );

      expect(allExpenseIds).not.toContain(sentinelExpenseId);
      // The sentinel must not leak anywhere, in ANY group/descriptor either.
      expect(JSON.stringify(queue)).not.toContain(sentinelExpenseId);
    } finally {
      await prisma.cashFlowEntry.delete({ where: { id: sentinelEntryId } });
      await prisma.expense.delete({ where: { id: sentinelExpenseId } });
    }
  });

  it("never lets the hidden CASA rateio target enter the financial pendencia queue", async () => {
    const queue = await pendencia.findFinancialQueue(
      IDS.tenantA,
      IDS.projects.pessoal,
      FINANCE_CENTER_MONTH,
    );

    const allExpenseIds = queue.grupos.flatMap((group) =>
      group.itens.map((item) => item.expenseId),
    );
    expect(allExpenseIds).not.toContain(IDS.expenses.rateioHiddenTarget);
    expect(JSON.stringify(queue)).not.toContain(IDS.projects.hidden);
  });
});
