import { randomUUID } from "node:crypto";
import {
  ExpenseStatus,
  ExpenseType,
  ProjectType,
  PaymentForm,
  type ExpenseScheduleV1,
} from "@reformaflow/domain";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { ExpenseService } from "./expense.service";
import { parseStoredExpenseSchedule } from "./documented-schedule";
import type { RateioRequester } from "./rateio.types";
import {
  MonthlyOverviewService,
  buildCardInvoiceAggregates,
} from "../monthly-overview/monthly-overview.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { aggregateInvoiceTotals } from "../bank-account/card-invoice-match";
import { CategoryBudgetService } from "../category-budget/category-budget.service";

describe("CSV native planned card writer (guarded persisted DB)", () => {
  const prisma = new PrismaService();
  const service = new ExpenseService(prisma, new ConciliacaoService(prisma));
  let tenantId: string;
  let projectId: string;
  let cardId: string;
  let actor: RateioRequester & { id: string };
  const schedule: ExpenseScheduleV1 = {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: "2/4",
        valor: 101,
        data: "2026-10-20",
        invoiceDueMonth: "2026-10",
      },
      {
        index: 1,
        parcela: "3/4",
        valor: 207,
        data: "2026-12-03",
        invoiceDueMonth: "2026-12",
      },
      {
        index: 2,
        parcela: "4/4",
        valor: 301,
        data: "2027-04-29",
        invoiceDueMonth: "2027-05",
      },
    ],
  };
  const input = () => ({
    cardId,
    titulo: "Documented purchase",
    fornecedor: "Fixture supplier",
    tipoDespesa: ExpenseType.OUTROS,
    categoriaMaoDeObra: null,
    dataCompra: "2026-09-01",
    totalCents: 609,
    schedule,
    evidence: { documentSha256: "a".repeat(64), reference: "csv:row:2" },
    reason: "Confirmed CSV line",
  });

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    expect(process.env.DATABASE_URL).not.toContain("dev.db");
    await prisma.$connect();
    const tenant = await prisma.tenant.create({
      data: { name: "CSV writer fixture" },
    });
    tenantId = tenant.id;
    const user = await prisma.user.create({
      data: {
        tenantId,
        username: randomUUID(),
        name: "Fixture",
        role: "ADMIN",
      },
    });
    actor = {
      id: user.id,
      role: user.role,
      allowedProjects: [],
      allowedProjectTypes: [],
      allowedModules: [],
    };
    const project = await prisma.project.create({
      data: { tenantId, name: "CSV fixture", type: ProjectType.PESSOAL },
    });
    projectId = project.id;
    const card = await prisma.creditCard.create({
      data: {
        tenantId,
        projectId,
        nickname: "Fixture",
        institution: "Fixture",
        last4: "1234",
        closingDay: 5,
        dueDay: 10,
      },
    });
    cardId = card.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("preserves irregular cents, labels, dates and invoice cycles without realized bank cash", async () => {
    const source = await prisma.$transaction((tx) =>
      service.createPlannedCardPurchaseInTx(
        tx,
        tenantId,
        projectId,
        input(),
        actor.id,
        actor,
      ),
    );
    expect(source).toMatchObject({
      valorTotal: 609,
      status: ExpenseStatus.PLANEJADO,
      accountId: null,
      bankLast4: null,
      cardLast4: "1234",
    });
    const stored = parseStoredExpenseSchedule(source.documentedSchedule)!;
    expect(stored.cardId).toBe(cardId);
    expect(
      stored.occurrences.map(
        ({ index, parcela, valor, data, invoiceDueMonth }) => ({
          index,
          parcela,
          valor,
          data,
          invoiceDueMonth,
        }),
      ),
    ).toEqual(schedule.occurrences);
    const entries = await prisma.cashFlowEntry.findMany({
      where: { tenantId, expenseId: source.id, deletedAt: null },
      orderBy: { data: "asc" },
    });
    expect(
      entries.map((entry) => ({
        parcela: entry.parcela,
        valor: entry.valor,
        data: entry.data.toISOString().slice(0, 10),
        invoiceDueMonth: entry.invoiceDueMonth,
        status: entry.status,
      })),
    ).toEqual(
      schedule.occurrences.map(({ parcela, valor, data, invoiceDueMonth }) => ({
        parcela,
        valor,
        data,
        invoiceDueMonth,
        status: ExpenseStatus.PLANEJADO,
      })),
    );
    expect(await prisma.receipt.count({ where: { tenantId } })).toBe(0);
    const card = await prisma.creditCard.findUniqueOrThrow({
      where: { id: cardId },
    });
    const invoiceRows = entries.map((entry) => ({
      ...entry,
      expense: {
        cardLast4: source.cardLast4,
        bankLast4: source.bankLast4,
        tipoDespesa: source.tipoDespesa,
      },
    }));
    const invoices = buildCardInvoiceAggregates(invoiceRows, [card], []);
    expect(
      [...invoices.values()].map((invoice) => ({
        dueMonth: invoice.dueMonth,
        total: invoice.total,
      })),
    ).toEqual([
      { dueMonth: "2026-10", total: 101 },
      { dueMonth: "2026-12", total: 207 },
      { dueMonth: "2027-05", total: 301 },
    ]);
    expect([...aggregateInvoiceTotals({ ...card, entries })]).toEqual([
      ["2026-10", 101],
      ["2026-12", 207],
      ["2027-05", 301],
    ]);
    const monthly = new MonthlyOverviewService(
      prisma,
      new CardInvoiceSettlementService(prisma),
    );
    const origins = await monthly.getOriginItemsYearly(
      tenantId,
      projectId,
      { year: 2026, kind: "card", last4: "1234" },
      actor,
    );
    expect(
      origins.items
        .map((entry) => ({ mes: entry.mes, valor: entry.valor }))
        .sort((a, b) => a.mes.localeCompare(b.mes)),
    ).toEqual([
      { mes: "2026-10", valor: 101 },
      { mes: "2026-12", valor: 207 },
    ]);
    const budgets = new CategoryBudgetService(prisma);
    await budgets.upsert(tenantId, projectId, {
      tipoDespesa: ExpenseType.OUTROS,
      valorLimiteCents: 10000,
    });
    expect(
      (await budgets.progress(tenantId, projectId, "2026-10"))[0],
    ).toMatchObject({ gastoCents: 0, comprometidoCents: 101 });
    expect(
      (await budgets.progress(tenantId, projectId, "2026-11"))[0],
    ).toMatchObject({ gastoCents: 0, comprometidoCents: 0 });
  });

  it("rejects mismatched totals and cross-tenant cards without partial expense or cash-flow writes", async () => {
    const before = await prisma.expense.count({ where: { tenantId } });
    await expect(
      prisma.$transaction((tx) =>
        service.createPlannedCardPurchaseInTx(
          tx,
          tenantId,
          projectId,
          { ...input(), totalCents: 610 },
          actor.id,
          actor,
        ),
      ),
    ).rejects.toThrow();
    const foreignTenant = await prisma.tenant.create({
      data: { name: "Other tenant fixture" },
    });
    const foreignProject = await prisma.project.create({
      data: {
        tenantId: foreignTenant.id,
        name: "Other project",
        type: ProjectType.PESSOAL,
      },
    });
    const foreignCard = await prisma.creditCard.create({
      data: {
        tenantId: foreignTenant.id,
        projectId: foreignProject.id,
        nickname: "Other",
        institution: "Fixture",
        last4: "1234",
      },
    });
    await expect(
      prisma.$transaction((tx) =>
        service.createPlannedCardPurchaseInTx(
          tx,
          tenantId,
          projectId,
          { ...input(), cardId: foreignCard.id },
          actor.id,
          actor,
        ),
      ),
    ).rejects.toThrow();
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(before);
    expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(3);
  });

  it("rolls back all native effects if a later workflow phase fails", async () => {
    const before = await prisma.expense.count({ where: { tenantId } });
    await expect(
      prisma.$transaction(async (tx) => {
        await service.createPlannedCardPurchaseInTx(
          tx,
          tenantId,
          projectId,
          input(),
          actor.id,
          actor,
        );
        throw new Error("Later workflow failure");
      }),
    ).rejects.toThrow("Later workflow failure");
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(before);
    expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(3);
  });

  it.each([0, -1])(
    "rejects a nonpositive occurrence (%i cents) even when the purchase total remains positive",
    async (valor: number) => {
      const before = {
        expenses: await prisma.expense.count({ where: { tenantId } }),
        cash: await prisma.cashFlowEntry.count({ where: { tenantId } }),
        receipts: await prisma.receipt.count({ where: { tenantId } }),
      };
      const invalid = {
        ...input(),
        schedule: {
          ...schedule,
          occurrences: schedule.occurrences.map((item, index) => ({
            ...item,
            valor: index === 0 ? valor : index === 1 ? 308 - valor : item.valor,
          })),
        },
      };
      expect(
        invalid.schedule.occurrences.reduce((sum, item) => sum + item.valor, 0),
      ).toBe(invalid.totalCents);
      await expect(
        prisma.$transaction((tx) =>
          service.createPlannedCardPurchaseInTx(
            tx,
            tenantId,
            projectId,
            invalid,
            actor.id,
            actor,
          ),
        ),
      ).rejects.toThrow();
      expect({
        expenses: await prisma.expense.count({ where: { tenantId } }),
        cash: await prisma.cashFlowEntry.count({ where: { tenantId } }),
        receipts: await prisma.receipt.count({ where: { tenantId } }),
      }).toEqual(before);
    },
  );

  it("preserves main's legacy rateio paid projection instead of restoring the donor baseline reset", async () => {
    const source = await service.create(
      tenantId,
      projectId,
      {
        tipoDespesa: ExpenseType.OUTROS,
        valor: 2,
        quantidade: 1,
        formaPagamento: PaymentForm.PARCELADO,
        quantidadeParcela: 2,
        dataInicioParcela: "2026-10-10",
        status: ExpenseStatus.PLANEJADO,
      },
      actor.id,
      undefined,
      actor,
    );
    await service.setParcelaStatus(tenantId, projectId, source.id, 0, true);
    const partial = await prisma.expense.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(partial.paidParcelas).toBe("[0]");
    const targetProject = await prisma.project.create({
      data: {
        tenantId,
        name: "Legacy rateio target fixture",
        type: ProjectType.REFORMA,
      },
    });
    const target = await service.create(
      tenantId,
      targetProject.id,
      {
        tipoDespesa: ExpenseType.OUTROS,
        valor: 2,
        quantidade: 1,
        formaPagamento: PaymentForm.A_VISTA,
        dataPagamento: "2026-10-10",
        status: ExpenseStatus.PLANEJADO,
      },
      actor.id,
      undefined,
      actor,
    );
    const conciliacao = new ConciliacaoService(prisma);
    await prisma.$transaction((tx) =>
      conciliacao.ratearSource(
        tx,
        {
          tenantId,
          sourceExpenseId: source.id,
          allocations: [{ targetExpenseId: target.id, allocation: 200 }],
        },
        actor,
      ),
    );
    expect(
      (await prisma.expense.findUniqueOrThrow({ where: { id: target.id } }))
        .paidParcelas,
    ).toBe("[0]");
  });
});
