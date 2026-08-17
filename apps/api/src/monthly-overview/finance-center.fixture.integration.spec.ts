/**
 * Synthetic deterministic contract coverage for #446.
 *
 * This fixture is not production inventory, production representativeness,
 * production migration-deployment evidence, or certification of B0/#445.
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
  FINANCE_CENTER_PERSONA_GRANTS,
  FINANCE_CENTER_PLANNING_LOCAL,
  persistFinanceCenterFixture,
} from "./__fixtures__/finance-center.fixture";
import { MonthlyOverviewService } from "./monthly-overview.service";

const IDS = FINANCE_CENTER_IDS;

describe("synthetic deterministic finance-center persisted contract", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
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

  it("persists the literal two-tenant project/persona/grant matrix with no OWNER", async () => {
    expect(Date.now()).toBe(FINANCE_CENTER_CLOCK.getTime());

    const projects = await prisma.project.findMany({
      where: { tenantId: IDS.tenantA },
      select: { id: true, type: true },
      orderBy: { id: "asc" },
    });
    expect(projects).toEqual([
      { id: IDS.projects.allowed, type: "REFORMA" },
      { id: IDS.projects.hidden, type: "CASA" },
      { id: IDS.projects.pessoal, type: "PESSOAL" },
      { id: IDS.projects.secondPessoal, type: "PESSOAL" },
    ]);

    const personas = await prisma.user.findMany({
      where: { tenantId: IDS.tenantA },
      select: {
        id: true,
        role: true,
        isGuest: true,
        createdByUserId: true,
        allowedModules: true,
        allowedProjects: true,
        allowedProjectTypes: true,
        lastLoginAt: true,
        lastActivityAt: true,
      },
      orderBy: { id: "asc" },
    });

    expect(personas).toHaveLength(7);
    expect(personas.every((persona) => persona.role !== "OWNER")).toBe(true);
    expect(
      personas.find((persona) => persona.id === IDS.users.signup),
    ).toMatchObject({
      createdByUserId: null,
      ...FINANCE_CENTER_PERSONA_GRANTS.signup,
    });
    expect(
      personas.find((persona) => persona.id === IDS.users.managed),
    ).toMatchObject({
      createdByUserId: IDS.users.admin,
      ...FINANCE_CENTER_PERSONA_GRANTS.managed,
    });
    expect(
      personas.find((persona) => persona.id === IDS.users.admin),
    ).toMatchObject(FINANCE_CENTER_PERSONA_GRANTS.admin);
    expect(
      personas.find((persona) => persona.id === IDS.users.guest),
    ).toMatchObject({
      createdByUserId: IDS.users.admin,
      lastLoginAt: new Date("2026-08-16T12:00:00.000Z"),
      lastActivityAt: new Date("2026-08-17T12:00:00.000Z"),
      ...FINANCE_CENTER_PERSONA_GRANTS.guest,
    });
    expect(
      personas.find((persona) => persona.id === IDS.users.invalid),
    ).toMatchObject(FINANCE_CENTER_PERSONA_GRANTS.invalid);
    expect(
      personas.find((persona) => persona.id === IDS.users.nonArray),
    ).toMatchObject(FINANCE_CENTER_PERSONA_GRANTS.nonArray);
    expect(
      personas.find((persona) => persona.id === IDS.users.mixed),
    ).toMatchObject(FINANCE_CENTER_PERSONA_GRANTS.mixed);
  });

  it("persists exact rateio, mirror, neutral/card-pays-card and tenant collision relationships", async () => {
    const [
      rateio,
      mirror,
      cardPaysCard,
      tenantAReceipt,
      tenantBReceipt,
      rateioSource,
      mirrorSource,
      mirrorTarget,
      tenantScopedExpense,
      tenantBExpense,
    ] = await Promise.all([
      prisma.rateioAllocation.findMany({
        where: {
          tenantId: IDS.tenantA,
          sourceExpenseId: IDS.expenses.rateioSource,
        },
        select: {
          sourceExpenseId: true,
          targetExpenseId: true,
          allocation: true,
        },
        orderBy: { allocation: "asc" },
      }),
      prisma.crossProjectSettlement.findMany({
        where: { tenantId: IDS.tenantA },
        select: {
          sourceExpenseId: true,
          targetExpenseId: true,
          parcelaIndex: true,
          realValor: true,
          plannedValor: true,
          plannedStatus: true,
        },
      }),
      prisma.expense.findFirst({
        where: { id: IDS.expenses.cardPaysCard, tenantId: IDS.tenantA },
        select: {
          tipoDespesa: true,
          cardLast4: true,
          bankLast4: true,
          settlesInvoiceKey: true,
          valorTotal: true,
        },
      }),
      prisma.receipt.findFirst({
        where: { id: IDS.receipts.bank, tenantId: IDS.tenantA },
        select: { externalId: true, bankLast4: true, valor: true, data: true },
      }),
      prisma.receipt.findFirst({
        where: { id: IDS.receipts.tenantBCollision, tenantId: IDS.tenantB },
        select: { externalId: true, bankLast4: true, valor: true, data: true },
      }),
      prisma.expense.findFirst({
        where: { id: IDS.expenses.rateioSource, tenantId: IDS.tenantA },
        select: { linkedExpenseId: true },
      }),
      prisma.expense.findFirst({
        where: { id: IDS.expenses.mirrorSource, tenantId: IDS.tenantA },
        select: {
          externalId: true,
          cardLast4: true,
          valorTotal: true,
          dataPagamento: true,
          linkedExpenseId: true,
        },
      }),
      prisma.expense.findFirst({
        where: { id: IDS.expenses.mirrorTarget, tenantId: IDS.tenantA },
        select: { linkedExpenseId: true },
      }),
      prisma.expense.findFirst({
        where: {
          id: IDS.expenses.tenantScopedForeign,
          tenantId: IDS.tenantA,
        },
        select: {
          externalId: true,
          cardLast4: true,
          valorTotal: true,
          dataPagamento: true,
        },
      }),
      prisma.expense.findFirst({
        where: { id: IDS.expenses.tenantBCollision, tenantId: IDS.tenantB },
        select: {
          externalId: true,
          cardLast4: true,
          valorTotal: true,
          dataPagamento: true,
        },
      }),
    ]);

    expect(rateio).toEqual([
      {
        sourceExpenseId: IDS.expenses.rateioSource,
        targetExpenseId: IDS.expenses.rateioAllowedTarget,
        allocation: 12_007,
      },
      {
        sourceExpenseId: IDS.expenses.rateioSource,
        targetExpenseId: IDS.expenses.rateioHiddenTarget,
        allocation: 18_022,
      },
    ]);
    expect(
      rateio.reduce((sum, allocation) => sum + allocation.allocation, 0),
    ).toBe(30_029);
    expect(mirror).toEqual([
      {
        sourceExpenseId: IDS.expenses.mirrorSource,
        targetExpenseId: IDS.expenses.mirrorTarget,
        parcelaIndex: 0,
        realValor: 90_040,
        plannedValor: 90_040,
        plannedStatus: "PLANEJADO",
      },
    ]);
    expect(cardPaysCard).toEqual({
      tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
      cardLast4: "1111",
      bankLast4: null,
      settlesInvoiceKey: "2222:2026-08",
      valorTotal: 10_010,
    });
    expect(tenantAReceipt).toEqual({
      externalId: "fc-collision-receipt",
      bankLast4: "4242",
      valor: 83_978,
      data: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(tenantBReceipt).toEqual(tenantAReceipt);
    expect(rateioSource).toEqual({
      linkedExpenseId: IDS.expenses.rateioAllowedTarget,
    });
    expect(mirrorSource).toEqual({
      externalId: "fc-collision-expense",
      cardLast4: "1111",
      valorTotal: 90_040,
      dataPagamento: new Date("2026-07-05T12:00:00.000Z"),
      linkedExpenseId: IDS.expenses.mirrorTarget,
    });
    expect(mirrorTarget).toEqual({ linkedExpenseId: null });
    const collidingExpense = {
      externalId: "fc-tenant-scope-collision",
      cardLast4: "1111",
      valorTotal: 4_006,
      dataPagamento: new Date("2026-08-14T12:00:00.000Z"),
    };
    expect(tenantScopedExpense).toEqual(collidingExpense);
    expect(tenantBExpense).toEqual(collidingExpense);
  });

  it("marks the persisted PESSOAL mirror and deduplicates it from canonical monthly totals", async () => {
    const overview = await monthly.getOverview(
      IDS.tenantA,
      IDS.projects.pessoal,
      FINANCE_CENTER_MONTH,
    );
    const mirrorSource = overview.entries.find(
      (entry) => entry.expenseId === IDS.expenses.mirrorSource,
    );
    const mirrorTarget = overview.entries.find(
      (entry) => entry.expenseId === IDS.expenses.mirrorTarget,
    );

    expect(mirrorSource).toMatchObject({
      expenseId: IDS.expenses.mirrorSource,
      projectId: IDS.projects.pessoal,
      valor: 90_040,
      isEspelho: true,
    });
    expect(mirrorTarget).toMatchObject({
      expenseId: IDS.expenses.mirrorTarget,
      projectId: IDS.projects.allowed,
      valor: 90_040,
      isEspelho: false,
    });
    expect(
      overview.meses.find((row) => row.mes === "2026-07")?.totalDespesas,
    ).toBe(117_063);
  });

  it("returns literal §10, Carteira, rateio and invoice oracles through the real monthly service", async () => {
    const caixa = await monthly.getCaixaConta(
      IDS.tenantA,
      IDS.projects.pessoal,
    );
    const fingerprint = await authorizedFingerprint();

    expect(caixa).toEqual({
      hoje: 983_928,
      saldoInicial: 1_000_000,
      temSaldoInicial: true,
      porMes: [{ mes: "2026-08", caixa: 983_928 }],
    });
    // §10 is deliberately self-evident: opening + bank credit - C1 payment.
    expect(1_000_000 + 83_978 - 100_050).toBe(983_928);
    // Carteira is deliberately independent of the bank: receipt - rateio source.
    expect(33_023 - (12_007 + 18_022)).toBe(2_994);

    expect(fingerprint).toEqual({
      caixaHoje: 983_928,
      carteiraHoje: 2_994,
      rateioSource: {
        id: IDS.expenses.rateioSource,
        valor: 30_029,
        status: "PAGO",
        cardLast4: null,
        bankLast4: null,
      },
      invoices: [
        {
          last4: "1111",
          total: 100_050,
          paid: 100_050,
          pending: 0,
          status: "paga",
        },
        {
          last4: "2222",
          total: 10_010,
          paid: 10_010,
          pending: 0,
          status: "paga",
        },
        {
          last4: "3333",
          total: 7_003,
          paid: 0,
          pending: 7_003,
          status: "a pagar",
        },
      ],
    });
  });

  it("keeps local Planning payload and persisted server Planejador scenario independent", async () => {
    const server = await prisma.purchaseScenario.findFirst({
      where: { id: IDS.serverScenario, tenantId: IDS.tenantA },
      select: {
        id: true,
        nome: true,
        horizonteMeses: true,
        itens: {
          select: {
            id: true,
            nome: true,
            tipo: true,
            valorCents: true,
            parcelas: true,
            mesInicio: true,
            incluido: true,
          },
        },
      },
    });

    expect(FINANCE_CENTER_PLANNING_LOCAL.storageKey).toBe(
      `personal-planning:${IDS.projects.pessoal}`,
    );
    expect(FINANCE_CENTER_PLANNING_LOCAL.payload).toMatchObject({
      version: 2,
      activeScenarioId: "fc-local-planning-main",
      scenarios: [
        {
          id: "fc-local-planning-main",
          assumptions: {
            monthlyIncomeCents: 450_000,
            monthlyExpenseCents: 125_000,
          },
        },
      ],
    });
    expect(server).toEqual({
      id: IDS.serverScenario,
      nome: "Planejador server sintético",
      horizonteMeses: 6,
      itens: [
        {
          id: IDS.serverScenarioItem,
          nome: "Item server sintético",
          tipo: "PARCELADO",
          valorCents: 206_960,
          parcelas: 6,
          mesInicio: "2026-09",
          incluido: true,
        },
      ],
    });
    expect(JSON.stringify(FINANCE_CENTER_PLANNING_LOCAL.payload)).not.toContain(
      IDS.serverScenario,
    );
    expect(
      server?.itens.some((item) => item.id === "fc-local-planning-main"),
    ).toBe(false);
  });

  it("changes the tenant-only foreign oracle for tenant A but ignores the colliding tenant-B mutation", async () => {
    const baseline = await tenantScopeFingerprint();
    expect(baseline).toEqual({ faltaPagarMes: 11_009 });

    try {
      await prisma.expense.update({
        where: { id: IDS.expenses.tenantScopedForeign },
        data: { valor: 4_007, valorTotal: 4_007 },
      });
      const authorizedMutation = await tenantScopeFingerprint();
      expect(authorizedMutation).not.toEqual(baseline);
      expect(authorizedMutation).toEqual({ faltaPagarMes: 11_010 });
    } finally {
      await prisma.expense.update({
        where: { id: IDS.expenses.tenantScopedForeign },
        data: { valor: 4_006, valorTotal: 4_006 },
      });
    }

    try {
      await prisma.expense.update({
        where: { id: IDS.expenses.tenantBCollision },
        data: { valor: 999_999, valorTotal: 999_999 },
      });
      expect(await tenantScopeFingerprint()).toEqual(baseline);
    } finally {
      await prisma.expense.update({
        where: { id: IDS.expenses.tenantBCollision },
        data: { valor: 4_006, valorTotal: 4_006 },
      });
    }
  });

  it("runs on exactly the 63 committed disposable-test migrations through 20260810234344", async () => {
    const migrations = await prisma.$queryRaw<
      Array<{
        migration_name: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>
    >`SELECT migration_name, finished_at, rolled_back_at
      FROM _prisma_migrations
      ORDER BY migration_name ASC`;

    expect(migrations).toHaveLength(63);
    expect(migrations.at(-1)?.migration_name).toBe(
      "20260810234344_add_installment_date_overrides",
    );
    expect(
      migrations.every(
        (migration) =>
          migration.finished_at !== null && migration.rolled_back_at === null,
      ),
    ).toBe(true);
  });

  async function authorizedFingerprint() {
    const view = await monthly.getAccountView(
      IDS.tenantA,
      IDS.projects.pessoal,
      FINANCE_CENTER_MONTH,
    );
    const rateioSource = view.saidas.find(
      (item) => item.id === IDS.expenses.rateioSource,
    );

    return {
      caixaHoje: view.caixaHoje,
      carteiraHoje: view.carteiraHoje,
      rateioSource: rateioSource
        ? {
            id: rateioSource.id,
            valor: rateioSource.valor,
            status: rateioSource.status,
            cardLast4: rateioSource.cardLast4,
            bankLast4: rateioSource.bankLast4,
          }
        : null,
      invoices: view.cartoes
        .map((card) => ({
          last4: card.last4,
          total: card.faturaAtual,
          paid: card.faturaPaga,
          pending: card.faturaPendente,
          status: card.status,
        }))
        .sort((a, b) => a.last4.localeCompare(b.last4)),
    };
  }

  async function tenantScopeFingerprint() {
    const view = await monthly.getAccountView(
      IDS.tenantA,
      IDS.projects.pessoal,
      FINANCE_CENTER_MONTH,
    );
    return { faltaPagarMes: view.faltaPagarMes };
  }
});
