import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { TenantFinancialService } from "../tenant-financial/tenant-financial.service";
import { DashboardService } from "../dashboard/dashboard.service";
import { CashFlowService } from "../cash-flow/cash-flow.service";
import { parseStoredExpenseSchedule } from "./documented-schedule";

/**
 * #704 QA: negative-root credit carrying a legal #701 documented schedule,
 * read through every reader under every visibility lens. The oracle is the
 * pre-association read of the same reader (association must not move a total)
 * plus the literal synthetic credit, never the composition code itself.
 */
describe("#704 QA: documented-schedule credit x visibility lenses x readers", () => {
  const CREDIT = -12345;
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  const tenant = new TenantFinancialService(prisma, monthly);
  const dashboard = new DashboardService(prisma);
  const cashFlow = new CashFlowService(prisma);
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
    f = await refundFixture(db, prisma, "refund-qa-composition");
  });
  afterEach(async () => {
    jest.useRealTimers();
    await f.cleanup();
  });
  afterAll(async () => {
    await db.$disconnect();
    await prisma.$disconnect();
  });

  const scheduleJson = () =>
    JSON.stringify({
      version: 1,
      kind: "source",
      tenantId: f.tenantId,
      sourceExpenseId: f.source.id,
      sourceProjectId: f.projectId,
      cardId: f.card.id,
      recordedByUserId: f.requester.id,
      recordedAt: "2026-09-01T12:00:00.000Z",
      importId: f.batch.id,
      externalId: f.source.externalId,
      occurrences: [
        {
          index: 0,
          parcela: "1/1",
          valor: CREDIT,
          data: "2026-09-10",
          invoiceDueMonth: null,
          amountEvidence: null,
          cycleEvidence: null,
        },
      ],
      projections: [],
      lastOperation: null,
    });

  const lenses = () => [
    { name: "source-only", ids: [f.projectId] },
    { name: "target-only", ids: [f.targetProjectId] },
    { name: "both", ids: [f.projectId, f.targetProjectId] },
    { name: "tenant-wide", ids: null },
  ];

  /** One numeric row per reader/lens: the data contract, no markup. */
  const readAll = async () => {
    const rows: Record<string, unknown> = {};
    for (const lens of lenses()) {
      const byProject = await tenant.getByProject(f.tenantId, lens.ids);
      const cash = await tenant.getCashFlow(f.tenantId, 12, lens.ids);
      const suppliers = await tenant.getTopSuppliers(f.tenantId, 10, lens.ids);
      const overview = await tenant.getOverview(f.tenantId, lens.ids);
      rows[lens.name] = {
        categoryTotal: (
          await tenant.getByCategory(f.tenantId, lens.ids)
        ).reduce((sum, r) => sum + r.total, 0),
        pagoTotal: overview.pagoTotal,
        projectSum: byProject.reduce((sum, r) => sum + r.gastoTotal, 0),
        cashPagoSeptember: cash
          .filter((r) => r.mes === "2026-09")
          .reduce((sum, r) => sum + r.pago, 0),
        supplierCounts: suppliers.map((r) => r.count).sort(),
        supplierTotal: suppliers.reduce((sum, r) => sum + r.total, 0),
      };
    }
    for (const [name, projectId] of [
      ["dashboard-source", f.projectId],
      ["dashboard-target", f.targetProjectId],
    ] as const) {
      rows[name] = (
        await dashboard.getDashboard(f.tenantId, projectId)
      ).kpis.jaPaguei;
    }
    for (const [name, projectId] of [
      ["cashflow-source", f.projectId],
      ["cashflow-target", f.targetProjectId],
    ] as const) {
      rows[name] = (await cashFlow.findAll(f.tenantId, projectId)).map(
        (r) => r.valor,
      );
    }
    // the consolidated monthly view exists only for the PESSOAL anchor
    rows["monthly-source"] = (
      await monthly.getOverview(f.tenantId, f.projectId, "2026-09", f.requester)
    ).entries
      .filter((r) => !r.isEspelho)
      .map((r) => r.valor);
    return rows;
  };

  const ledger = async () => {
    const where = { tenantId: f.tenantId };
    const orderBy = { id: "asc" as const };
    return {
      expenses: await db.expense.findMany({ where, orderBy }),
      cash: await db.cashFlowEntry.findMany({ where, orderBy }),
      allocations: await db.rateioAllocation.findMany({ where, orderBy }),
      externalIds: (await db.expense.findMany({ where, orderBy })).map((r) => [
        r.id,
        r.externalId,
        r.importId,
        r.cardLast4,
      ]),
    };
  };

  it("the schedule is legal for both schema and parser, and the credit is a single documented occurrence", async () => {
    const json = scheduleJson();
    const parsed = parseStoredExpenseSchedule(json);
    expect(parsed?.kind).toBe("source");
    expect(parsed?.occurrences).toHaveLength(1);
    expect(parsed?.occurrences[0]).toMatchObject({
      valor: CREDIT,
      parcela: "1/1",
      data: "2026-09-10",
    });
    await expect(
      db.expense.update({
        where: { id: f.source.id },
        data: { documentedSchedule: json },
      }),
    ).resolves.toMatchObject({ documentedSchedule: json, valor: CREDIT });
  });

  it("apply, idempotent retry and undo keep the schedule byte-identical and every reader counts the credit exactly once in every lens", async () => {
    const json = scheduleJson();
    await db.expense.update({
      where: { id: f.source.id },
      data: { documentedSchedule: json, fornecedor: "Synthetic supplier" },
    });
    const beforeLedger = await ledger();
    const beforeRead = await readAll();
    // oracle 1 (literal): before association the credit is already counted once
    for (const lens of ["source-only", "both", "tenant-wide"]) {
      expect(beforeRead[lens]).toMatchObject({
        categoryTotal: CREDIT,
        pagoTotal: CREDIT,
        projectSum: CREDIT,
      });
    }

    const body = await f.request();
    const applied = await f.apply(body);
    const applyLedger = await ledger();
    const applyRead = await readAll();

    // graph delta: exactly one target, one CFE, one refund-credit allocation
    expect(applyLedger.expenses).toHaveLength(beforeLedger.expenses.length + 1);
    expect(applyLedger.cash).toHaveLength(beforeLedger.cash.length + 1);
    expect(applyLedger.allocations).toHaveLength(1);
    expect(applyLedger.allocations[0]).toMatchObject({
      sourceExpenseId: f.source.id,
      isRefundCredit: true,
    });
    // source: schedule byte-for-byte, only link/revision/updatedAt may move
    const sourceBefore = beforeLedger.expenses.find(
      (r) => r.id === f.source.id,
    )!;
    const sourceAfter = applyLedger.expenses.find((r) => r.id === f.source.id)!;
    expect(sourceAfter.documentedSchedule).toBe(json);
    const { linkedExpenseId, refundPurposeRevision, updatedAt, ...restAfter } =
      sourceAfter;
    const {
      linkedExpenseId: _l,
      refundPurposeRevision: _r,
      updatedAt: _u,
      ...restBefore
    } = sourceBefore;
    expect(restAfter).toEqual(restBefore);
    expect(linkedExpenseId).toBe(applied.targetExpenseId);
    expect(refundPurposeRevision).toBe(sourceBefore.refundPurposeRevision + 1);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(_u.getTime());
    // every other pre-existing row and the identity columns did not move
    expect(applyLedger.cash.filter((r) => r.expenseId === f.source.id)).toEqual(
      beforeLedger.cash.filter((r) => r.expenseId === f.source.id),
    );
    expect(
      applyLedger.externalIds.filter(([id]) => id === f.source.id),
    ).toEqual(beforeLedger.externalIds.filter(([id]) => id === f.source.id));
    const target = applyLedger.expenses.find(
      (r) => r.id === applied.targetExpenseId,
    )!;
    expect(target).toMatchObject({
      valor: CREDIT,
      documentedSchedule: null,
      cardLast4: null,
      importId: null,
      externalId: null,
      status: "PAGO",
      projectId: f.targetProjectId,
    });

    // reader oracle: association never moves a total in any lens where the
    // source was visible, and a target-only lens sees the credit exactly once
    for (const lens of ["source-only", "both", "tenant-wide"]) {
      expect(applyRead[lens]).toEqual(beforeRead[lens]);
    }
    expect(applyRead["target-only"]).toMatchObject({
      categoryTotal: CREDIT,
      pagoTotal: CREDIT,
      projectSum: CREDIT,
      supplierCounts: [1],
    });
    for (const lens of ["source-only", "both", "tenant-wide"])
      expect(applyRead[lens]).toMatchObject({ supplierCounts: [1] });
    expect(applyRead["dashboard-source"]).toBe(CREDIT);
    expect(applyRead["dashboard-target"]).toBe(CREDIT);
    expect(applyRead["cashflow-source"]).toEqual([CREDIT]);
    expect(applyRead["cashflow-target"]).toEqual([CREDIT]);
    expect(applyRead["monthly-source"]).toEqual([CREDIT]);

    // an identical retry is idempotent: same target, no second graph
    const replay = await f.apply(body);
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.targetExpenseId).toBe(applied.targetExpenseId);
    expect(await ledger()).toEqual(applyLedger);
    expect(await readAll()).toEqual(applyRead);

    // undo returns to the pre-apply ledger and readers (revision aside)
    await f.service.undo(f.tenantId, f.projectId, f.source.id, f.requester, {
      expectedRevision: applied.revision,
    });
    const undoneLedger = await ledger();
    expect(undoneLedger.allocations).toEqual([]);
    // the owned target and its CFE are retired (soft-deleted), never resurrected
    const liveCash = undoneLedger.cash.filter((r) => r.deletedAt === null);
    expect(liveCash).toEqual(beforeLedger.cash);
    expect(
      undoneLedger.cash
        .filter((r) => r.deletedAt !== null)
        .map((r) => r.expenseId),
    ).toEqual([applied.targetExpenseId]);
    expect(
      undoneLedger.expenses.find((r) => r.id === applied.targetExpenseId)
        ?.deletedAt,
    ).not.toBeNull();
    expect(
      undoneLedger.expenses
        .filter((r) => r.deletedAt === null)
        .map((r) => r.id),
    ).toEqual(beforeLedger.expenses.map((r) => r.id));
    const sourceUndone = undoneLedger.expenses.find(
      (r) => r.id === f.source.id,
    )!;
    expect(sourceUndone.documentedSchedule).toBe(json);
    expect(sourceUndone.linkedExpenseId).toBeNull();
    expect(await readAll()).toEqual(beforeRead);
  });

  it("the paid target never enters the PESSOAL Conta, yearly Conta or yearly invoice readers", async () => {
    const yearly = async () => ({
      source: await monthly.getAccountViewYearly(
        f.tenantId,
        f.projectId,
        "2026",
        f.requester,
      ),
      invoices: await monthly.getCardInvoicesYearly(
        f.tenantId,
        f.projectId,
        "2026",
        f.requester,
      ),
    });
    const before = await yearly();
    const applied = await f.apply();
    const after = await yearly();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(applied.targetExpenseId);
    const account = await monthly.getAccountView(
      f.tenantId,
      f.projectId,
      "2026-09",
      f.requester,
    );
    expect(JSON.stringify(account)).not.toContain(applied.targetExpenseId);
  });
});
