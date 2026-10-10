import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { refundFixture } from "../expense/__tests__/refund-purpose.fixture";
import { MonthlyOverviewService } from "./monthly-overview.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { TenantFinancialService } from "../tenant-financial/tenant-financial.service";
import { DashboardService } from "../dashboard/dashboard.service";
import { CashFlowService } from "../cash-flow/cash-flow.service";
import { SimulationService } from "../simulation/simulation.service";
import { CategoryBudgetService } from "../category-budget/category-budget.service";
import { BudgetAllocationService } from "../budget-allocation/budget-allocation.service";
import { PaidOriginsService } from "../expense/paid-origins.service";

describe("#704 scope-aware signed refund readers", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  const tenant = new TenantFinancialService(prisma, monthly);
  let f: Awaited<ReturnType<typeof refundFixture>>;
  beforeEach(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "clearTimeout",
        "hrtime",
        "performance",
      ],
    });
    jest.setSystemTime(new Date("2026-09-23T12:00:00Z"));
    f = await refundFixture(db, prisma, "refund-readers");
  });
  afterEach(async () => {
    jest.useRealTimers();
    await f.cleanup();
  });
  afterAll(async () => {
    await db.$disconnect();
    await prisma.$disconnect();
  });

  it("source-only, both-visible and target-only category totals each retain the credit exactly once", async () => {
    await db.expense.update({
      where: { id: f.source.id },
      data: { fornecedor: "Synthetic supplier" },
    });
    await f.apply();
    for (const scope of [
      [f.projectId],
      [f.targetProjectId],
      [f.projectId, f.targetProjectId],
      null,
    ]) {
      expect(await tenant.getByCategory(f.tenantId, scope)).toEqual([
        {
          key: "MATERIAL_CONSTRUCAO",
          label: "Material p/ Construção",
          total: -12345,
        },
      ]);
      expect(await tenant.getOverview(f.tenantId, scope)).toMatchObject({
        pagoTotal: -12345,
        pagoMesAtual: -12345,
      });
      expect(
        (await tenant.getByProject(f.tenantId, scope)).reduce(
          (sum, row) => sum + row.gastoTotal,
          0,
        ),
      ).toBe(-12345);
      expect(await tenant.getCashFlow(f.tenantId, 12, scope)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ mes: "2026-09", pago: -12345 }),
        ]),
      );
      expect(await tenant.getTopSuppliers(f.tenantId, 10, scope)).toEqual([
        expect.objectContaining({
          fornecedor: "Synthetic supplier",
          total: -12345,
          count: 1,
        }),
      ]);
    }
  });

  it("never invents a wallet movement even when the target is another PESSOAL", async () => {
    await db.project.update({
      where: { id: f.targetProjectId },
      data: { type: "PESSOAL" },
    });
    const before = await monthly.getAccountView(
      f.tenantId,
      f.targetProjectId,
      "2026-09",
      f.requester,
    );
    await f.apply();
    const after = await monthly.getAccountView(
      f.tenantId,
      f.targetProjectId,
      "2026-09",
      f.requester,
    );
    expect(after.saidas).toEqual(before.saidas);
    expect(after.carteiraHoje).toBe(before.carteiraHoje);
    expect(
      await monthly.getCaixaConta(f.tenantId, f.targetProjectId),
    ).toMatchObject({ carteiraHoje: 0 });
  });

  it("50000 purchase minus 12345 credit stays 37655 in monthly/yearly invoice after purpose association", async () => {
    const purchase = await db.expense.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.projectId,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: 50000,
        valorTotal: 50000,
        formaPagamento: "A_VISTA",
        status: "PAGO",
        cardLast4: f.card.last4,
        importId: f.batch.id,
        externalId: "independent-purchase",
        dataPagamento: f.cfe.data,
      },
    });
    await db.cashFlowEntry.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.projectId,
        expenseId: purchase.id,
        valor: 50000,
        tipo: "DESPESA",
        categoria: "MATERIAL_CONSTRUCAO",
        status: "PAGO",
        data: f.cfe.data,
      },
    });
    const beforeYear = await monthly.getCardInvoicesYearly(
      f.tenantId,
      f.projectId,
      2026,
      f.requester,
    );
    await f.apply();
    const account = await monthly.getAccountView(
      f.tenantId,
      f.projectId,
      "2026-09",
      f.requester,
    );
    expect(account.cartoes[0].faturaAtual).toBe(37655);
    expect(
      await monthly.getCardInvoicesYearly(
        f.tenantId,
        f.projectId,
        2026,
        f.requester,
      ),
    ).toEqual(beforeYear);
    expect((await tenant.getOverview(f.tenantId, null)).pagoTotal).toBe(37655);
  });

  it("paid-origin uses the original import card and redacts hidden source scopes", async () => {
    await db.creditCard.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.projectId,
        last4: f.card.last4,
        nickname: "Wrong duplicate",
        institution: "OUTROS",
        createdAt: new Date("2020-01-01"),
      },
    });
    const applied = await f.apply();
    const origins = new PaidOriginsService(prisma);
    const visible = await origins.findForProject(
      f.tenantId,
      f.targetProjectId,
      f.requester,
    );
    expect(visible.items).toEqual([
      expect.objectContaining({
        expenseId: applied.targetExpenseId,
        origins: [
          expect.objectContaining({ nickname: `Cartão ${f.card.last4}` }),
        ],
      }),
    ]);
    expect(
      await origins.findForProject(f.tenantId, f.targetProjectId, {
        ...f.requester,
        role: "USER",
        allowedProjects: [f.targetProjectId],
        allowedModules: ["expenses"],
        allowedProjectTypes: ["REFORMA"],
      }),
    ).toEqual({ items: [] });
  });

  it("PESSOAL budget commitment does not disappear after association", async () => {
    const budgets = new BudgetAllocationService(prisma);
    const before = await budgets.calculateAvailableBudget(
      f.projectId,
      f.tenantId,
    );
    await f.apply();
    expect(
      await budgets.calculateAvailableBudget(f.projectId, f.tenantId),
    ).toBe(before);
    expect(before).toBe(12345);
    const summary = await budgets.getSummary(f.targetProjectId, f.tenantId);
    expect(summary).toMatchObject({ totalSpent: -12345 });
  });

  it("project dashboard, simulation and cashflow retain negative-only categories", async () => {
    await f.apply();
    for (const projectId of [f.projectId, f.targetProjectId]) {
      const dashboard = await new DashboardService(prisma).getDashboard(
        f.tenantId,
        projectId,
      );
      expect(dashboard.kpis.jaPaguei).toBe(-12345);
      expect(dashboard.resumoPorTipoDespesa).toEqual([
        expect.objectContaining({ total: -12345 }),
      ]);
      const cashflow = await new CashFlowService(prisma).findAll(
        f.tenantId,
        projectId,
      );
      expect(cashflow.map((row) => row.valor)).toEqual([-12345]);
      const simulation = await new SimulationService(prisma).getData(
        f.tenantId,
        projectId,
      );
      expect(simulation.porTipo).toEqual(
        expect.arrayContaining([expect.objectContaining({ total: -12345 })]),
      );
    }
  });

  it("category budgets preserve a signed refund-only category", async () => {
    await db.categoryBudget.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.projectId,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valorLimiteCents: 50000,
      },
    });
    const budgets = new CategoryBudgetService(prisma);
    const before = await budgets.progress(f.tenantId, f.projectId, "2026-09");
    await f.apply();
    expect(await budgets.progress(f.tenantId, f.projectId, "2026-09")).toEqual(
      before,
    );
    expect(before).toEqual([
      expect.objectContaining({
        gastoCents: -12345,
        comprometidoCents: -12345,
      }),
    ]);
  });

  it("account/invoice/bank remain unchanged, consolidated dedupe uses the actual authorized scope", async () => {
    const before = await monthly.getAccountView(
      f.tenantId,
      f.projectId,
      "2026-09",
      f.requester,
    );
    const result = await f.apply();
    const after = await monthly.getAccountView(
      f.tenantId,
      f.projectId,
      "2026-09",
      f.requester,
    );
    expect(after.caixaHoje).toBe(before.caixaHoje);
    expect(after.saiuMes).toBe(before.saiuMes);
    expect(after.cartoes.map((row) => row.faturaAtual)).toEqual(
      before.cartoes.map((row) => row.faturaAtual),
    );
    expect(
      after.saidas.some((row) => row.expenseId === result.targetExpenseId),
    ).toBe(false);
    const all = await monthly.getOverview(
      f.tenantId,
      f.projectId,
      "2026-09",
      f.requester,
    );
    expect(
      all.entries.filter((row) => !row.isEspelho).map((row) => row.valor),
    ).toEqual([-12345]);
    const personalOnly = {
      ...f.requester,
      role: "USER",
      allowedProjects: [f.projectId],
      allowedModules: [
        "monthlyOverview",
        "expenses",
        "creditCards",
        "bankAccounts",
      ],
      allowedProjectTypes: ["PESSOAL"],
    };
    const scoped = await monthly.getOverview(
      f.tenantId,
      f.projectId,
      "2026-09",
      personalOnly,
    );
    expect(
      scoped.entries.filter((row) => !row.isEspelho).map((row) => row.valor),
    ).toEqual([-12345]);
    expect(JSON.stringify(scoped)).not.toContain(result.targetExpenseId);
    const dre = await monthly.getDreOverview(
      f.tenantId,
      f.projectId,
      { month: "2026-09" },
      f.requester,
    );
    expect(dre.mensal.despesaTotal).toBe(-12345);
  });
});
