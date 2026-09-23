import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { ExpenseService } from "./expense.service";
import { applyParcelaFunding } from "../conciliacao/additive-settlement";
import { DashboardService } from "../dashboard/dashboard.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { PaidOriginsService } from "./paid-origins.service";
import { ExpenseController } from "./expense.controller";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ValidationPipe } from "@nestjs/common";
import { request as playwrightRequest } from "@playwright/test";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { ProjectService } from "../project/project.service";
import { BankAccountService } from "../bank-account/bank-account.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import {
  resetTenant,
  seedPessoal,
  seedBankAccount,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const tenantId = "qa702-tenant";
const pessoal = "qa702-pessoal";
const reforma = "qa702-reforma";
const requester = { id: "qa702-user", role: "ADMIN" };
const db = new PrismaClient();
const prisma = new PrismaService();
const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
let sourceId: string;
let targetId: string;
let pendingId: string;
const sourceSnapshot = async () => ({
  expense: await db.expense.findUniqueOrThrow({ where: { id: sourceId } }),
  cash: await db.cashFlowEntry.findMany({
    where: { expenseId: sourceId },
    orderBy: { id: "asc" },
  }),
});

beforeEach(async () => {
  jest.useFakeTimers({
    now: new Date("2026-09-23T12:00:00Z"),
    doNotFake: [
      "nextTick",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "hrtime",
      "performance",
      "queueMicrotask",
    ],
  });
  await db.user.deleteMany({ where: { tenantId } });
  await resetTenant(db, tenantId);
  await seedPessoal(db, { tenantId, projectId: pessoal });
  await db.project.create({
    data: { id: reforma, tenantId, type: "REFORMA", name: "Synthetic target" },
  });
  await db.user.create({
    data: {
      id: requester.id,
      tenantId,
      username: requester.id,
      name: "Synthetic",
      role: "ADMIN",
    },
  });
  const account = await seedBankAccount(db, {
    tenantId,
    projectId: pessoal,
    last4: "0702",
  });
  const source = await expenses.create(tenantId, pessoal, {
    tipoDespesa: "OUTROS",
    valor: 400,
    quantidade: 1,
    formaPagamento: "A_VISTA",
    status: "PAGO",
    dataPagamento: "2026-09-10",
    bankAccountId: account.id,
  });
  sourceId = source.id;
  const target = await expenses.create(tenantId, reforma, {
    tipoDespesa: "MAO_DE_OBRA",
    valor: 800,
    quantidade: 1,
    formaPagamento: "A_VISTA",
    status: "PLANEJADO",
    dataPagamento: "2026-09-20",
  });
  targetId = target.id;
  pendingId = (
    await db.cashFlowEntry.findFirstOrThrow({ where: { expenseId: targetId } })
  ).id;
});
afterAll(async () => {
  await db.user.deleteMany({ where: { tenantId } });
  await resetTenant(db, tenantId);
  await prisma.$disconnect();
  await db.$disconnect();
});
afterEach(() => jest.useRealTimers());

it("conserves monthly/yearly bank outflow, DRE and origin totals while projecting the target remainder", async () => {
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  const dreBefore = await monthly.getDreOverview(
    tenantId,
    pessoal,
    { month: "2026-09", year: 2026 },
    requester,
  );
  const originsBefore = await monthly.getOriginItemsYearly(
    tenantId,
    pessoal,
    { year: 2026, kind: "all" },
    requester,
  );
  await applyParcelaFunding(
    prisma,
    tenantId,
    pessoal,
    sourceId,
    {
      mode: "ADDITIVE",
      targetExpenseId: targetId,
      parcelaIndex: 0,
      amountCents: 20000,
      requestId: "reader-matrix",
    },
    requester,
  );
  const month = await monthly.getAccountView(
    tenantId,
    pessoal,
    "2026-09",
    requester,
  );
  const year = await monthly.getAccountViewYearly(
    tenantId,
    pessoal,
    2026,
    requester,
  );
  expect(month.saiuMes).toBe(40000);
  expect(year.saiuMes).toBe(month.saiuMes);
  expect(year.faltaPagarMes).toBe(60000);
  expect(year.saidas.find((row) => row.id === `${targetId}#0`)?.valor).toBe(
    60000,
  );
  const dre = await monthly.getDreOverview(
    tenantId,
    pessoal,
    { month: "2026-09", year: 2026 },
    requester,
  );
  expect(dre.anual.totalSaiu).toBe(dreBefore.anual.totalSaiu);
  expect(dre.anual.totalSaiu).toBe(40000);
  expect(dre.mensal.contaCorrente).toMatchObject({
    saiuMes: 40000,
    faltaPagarMes: 60000,
    despesaTotal: 100000,
  });
  expect(
    await monthly.getOriginItemsYearly(
      tenantId,
      pessoal,
      { year: 2026, kind: "all" },
      requester,
    ),
  ).toEqual(originsBefore);
});

it.each([
  { amountCents: 20000, bank: false },
  { amountCents: 80000, bank: false },
  { amountCents: 20000, bank: true },
  { amountCents: 80000, bank: true },
])(
  "does not turn another PESSOAL funding $amountCents/bank=$bank into a second debit",
  async ({ amountCents, bank }) => {
    await new ProjectService(prisma).update(tenantId, reforma, {
      type: "PESSOAL",
    });
    await expenses.update(
      tenantId,
      pessoal,
      sourceId,
      { valor: 800 },
      requester,
    );
    if (bank) {
      const account = await seedBankAccount(db, {
        tenantId,
        projectId: reforma,
        last4: "0703",
      });
      await expenses.update(
        tenantId,
        reforma,
        targetId,
        { bankAccountId: account.id },
        requester,
      );
    }
    await applyParcelaFunding(
      prisma,
      tenantId,
      pessoal,
      sourceId,
      {
        mode: "ADDITIVE",
        targetExpenseId: targetId,
        parcelaIndex: 0,
        amountCents,
        requestId: "other-pessoal",
      },
      requester,
    );
    const monthly = new MonthlyOverviewService(
      prisma,
      new CardInvoiceSettlementService(prisma),
    );
    const account = await monthly.getAccountView(
      tenantId,
      reforma,
      "2026-09",
      requester,
    );
    expect(account).toMatchObject({
      saiuMes: 0,
      carteiraHoje: 0,
      caixaHoje: 0,
      faltaPagarMes: 80000 - amountCents,
    });
    expect(await monthly.getCaixaConta(tenantId, reforma)).toMatchObject({
      hoje: 0,
      carteiraHoje: 0,
    });
    const dre = await monthly.getDreOverview(
      tenantId,
      reforma,
      { month: "2026-09", year: 2026 },
      requester,
    );
    expect(dre.anual.totalSaiu).toBe(0);
    const banks = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
    expect(await banks.listAccounts(tenantId, reforma)).toEqual(
      bank ? [expect.objectContaining({ balanceCents: 0 })] : [],
    );
    expect(
      (
        await monthly.getOriginItemsYearly(
          tenantId,
          reforma,
          { year: 2026, kind: "all" },
          requester,
        )
      ).total,
    ).toBe(80000 - amountCents);
  },
);

it("forwards the bank-link command to the same additive identity and balance calculation", async () => {
  const banks = new BankAccountService(
    prisma,
    new MerchantClassifierService(prisma),
    new ConciliacaoService(prisma),
    new CardInvoiceSettlementService(prisma),
  );
  const command = {
    mode: "ADDITIVE",
    targetExpenseId: targetId,
    parcelaIndex: 0,
    amountCents: 12345,
    requestId: "bank-forward",
  };
  const before = await sourceSnapshot();
  const result = await banks.linkToExpense(
    tenantId,
    pessoal,
    sourceId,
    targetId,
    command,
    requester,
  );
  expect(result).toMatchObject({
    amountCents: 12345,
    paidCents: 12345,
    remainingCents: 67655,
    replayed: false,
  });
  expect(
    await expenses.conciliarParcela(
      tenantId,
      pessoal,
      sourceId,
      command,
      requester,
    ),
  ).toMatchObject({ ...result, replayed: true });
  expect(await sourceSnapshot()).toEqual(before);
});

it.each([
  "account identity",
  "account deletion",
  "source project type",
  "target project deletion",
])("blocks %s without orphaning active claims", async (operation) => {
  await applyParcelaFunding(
    prisma,
    tenantId,
    pessoal,
    sourceId,
    {
      mode: "ADDITIVE",
      targetExpenseId: targetId,
      parcelaIndex: 0,
      amountCents: 12345,
      requestId: "lifecycle",
    },
    requester,
  );
  const account = await db.bankAccount.findFirstOrThrow({
    where: { tenantId, projectId: pessoal },
  });
  const projects = new ProjectService(prisma);
  const banks = new BankAccountService(
    prisma,
    new MerchantClassifierService(prisma),
    new ConciliacaoService(prisma),
    new CardInvoiceSettlementService(prisma),
  );
  const read = async () => ({
    projects: await db.project.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    account: await db.bankAccount.findUniqueOrThrow({
      where: { id: account.id },
    }),
    source: await sourceSnapshot(),
    claims: await db.crossProjectSettlement.findMany({ where: { tenantId } }),
  });
  const before = await read();
  const result =
    operation === "account identity"
      ? banks.updateAccount(tenantId, pessoal, account.id, { last4: "0703" })
      : operation === "account deletion"
        ? banks.deleteAccount(tenantId, pessoal, account.id)
        : operation === "source project type"
          ? projects.update(tenantId, pessoal, { type: "CASA" })
          : projects.remove(tenantId, reforma);
  await expect(result).rejects.toMatchObject({ status: 409 });
  expect(await read()).toEqual(before);
});

it("keeps 80000 contracted after applying an existing 40000 debit", async () => {
  const before = await sourceSnapshot();
  const command = {
    mode: "ADDITIVE" as const,
    targetExpenseId: targetId,
    parcelaIndex: 0,
    amountCents: 40000,
    requestId: "qa702-first",
  };
  await expenses.conciliarParcela(
    tenantId,
    pessoal,
    sourceId,
    command,
    requester,
  );
  expect(
    await db.expense.findUniqueOrThrow({ where: { id: targetId } }),
  ).toMatchObject({
    valorTotal: 80000,
    status: "PLANEJADO",
    paidParcelas: null,
  });
  const entries = await prisma.cashFlowEntry.findMany({
    where: { tenantId, expenseId: targetId },
  });
  expect(
    entries.filter((row) => row.status === "PAGO").map((row) => row.valor),
  ).toEqual([40000]);
  expect(entries.find((row) => row.id === pendingId)).toMatchObject({
    valor: 40000,
    status: "PLANEJADO",
  });
  expect(await sourceSnapshot()).toEqual(before);
});

const command = (requestId = "qa702-first", amountCents = 40000) => ({
  mode: "ADDITIVE" as const,
  targetExpenseId: targetId,
  parcelaIndex: 0,
  amountCents,
  requestId,
});
const apply = (requestId = "qa702-first", amountCents = 40000) =>
  applyParcelaFunding(
    prisma,
    tenantId,
    pessoal,
    sourceId,
    command(requestId, amountCents),
    requester,
  );
async function secondSource(value = 400) {
  const accountId = (
    await db.expense.findUniqueOrThrow({ where: { id: sourceId } })
  ).accountId!;
  return expenses.create(tenantId, pessoal, {
    tipoDespesa: "OUTROS",
    valor: value,
    formaPagamento: "A_VISTA",
    quantidade: 1,
    status: "PAGO",
    dataPagamento: "2026-09-11",
    bankAccountId: accountId,
  });
}

it("adds two contributions, replays current balances, and reverses individually without changing either source", async () => {
  const sourceBefore = await sourceSnapshot();
  const sourceB = await secondSource();
  const bBefore = await db.expense.findUniqueOrThrow({
    where: { id: sourceB.id },
  });
  const a = await apply();
  expect(a).toMatchObject({
    paidCents: 40000,
    remainingCents: 40000,
    sourceAvailableCents: 0,
    settlementStatus: "PARTIAL",
    replayed: false,
  });
  const b = await applyParcelaFunding(
    prisma,
    tenantId,
    pessoal,
    sourceB.id,
    command("qa702-b"),
    requester,
  );
  expect(b).toMatchObject({
    paidCents: 80000,
    remainingCents: 0,
    settlementStatus: "PAID",
  });
  expect(
    (await db.cashFlowEntry.findUniqueOrThrow({ where: { id: pendingId } }))
      .deletedAt,
  ).not.toBeNull();
  expect(await apply()).toMatchObject({
    settlementId: a.settlementId,
    paidCents: 80000,
    replayed: true,
  });
  const undone = await expenses.undoParcelaFunding(
    tenantId,
    pessoal,
    sourceId,
    a.settlementId,
    requester,
  );
  expect(undone).toMatchObject({
    state: "REVERSED",
    paidCents: 40000,
    remainingCents: 40000,
    sourceAvailableCents: 40000,
  });
  const pending = await db.cashFlowEntry.findUniqueOrThrow({
    where: { id: pendingId },
  });
  expect(pending).toMatchObject({ deletedAt: null, valor: 40000 });
  const snapshot = await db.cashFlowEntry.findMany({
    where: { expenseId: targetId },
    orderBy: { id: "asc" },
  });
  expect(
    await expenses.undoParcelaFunding(
      tenantId,
      pessoal,
      sourceId,
      a.settlementId,
      requester,
    ),
  ).toMatchObject({ replayed: true });
  expect(await apply()).toMatchObject({ state: "REVERSED", replayed: true });
  expect(
    await db.cashFlowEntry.findMany({
      where: { expenseId: targetId },
      orderBy: { id: "asc" },
    }),
  ).toEqual(snapshot);
  await expenses.undoParcelaFunding(
    tenantId,
    pessoal,
    sourceB.id,
    b.settlementId,
    requester,
  );
  expect(
    await expenses.findById(tenantId, reforma, targetId, requester),
  ).toMatchObject({
    valorTotal: 80000,
    status: "PLANEJADO",
    installmentSettlements: [
      {
        parcelaIndex: 0,
        contractedCents: 80000,
        paidCents: 0,
        remainingCents: 80000,
        settlementStatus: "UNPAID",
        contributions: [],
      },
    ],
  });
  expect(await sourceSnapshot()).toEqual(sourceBefore);
  expect(
    await db.expense.findUniqueOrThrow({ where: { id: sourceB.id } }),
  ).toEqual(bBefore);
});

it.each([
  { amountCents: 0 },
  { amountCents: -1 },
  { amountCents: 1.5 },
  { amountCents: 2147483648 },
  { parcelaIndex: -1 },
  { parcelaIndex: 0.5 },
  { parcelaIndex: undefined },
  { realValor: 40000 },
  { requestId: "" },
  { requestId: null },
  { unknown: true },
])("rejects invalid additive input atomically: %j", async (patch) => {
  const before = await sourceSnapshot();
  await expect(
    applyParcelaFunding(
      prisma,
      tenantId,
      pessoal,
      sourceId,
      { ...command(), ...patch },
      requester,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(await db.crossProjectSettlement.count({ where: { tenantId } })).toBe(
    0,
  );
  expect(await sourceSnapshot()).toEqual(before);
});

it("rejects duplicate tuples, reused keys and source/target overconsumption", async () => {
  await apply("qa702-a", 20000);
  await expect(apply("qa702-a", 10000)).rejects.toMatchObject({ status: 409 });
  await expect(apply("qa702-b", 10000)).rejects.toMatchObject({ status: 409 });
  const b = await secondSource(700);
  await expect(
    applyParcelaFunding(
      prisma,
      tenantId,
      pessoal,
      b.id,
      command("qa702-c", 70000),
      requester,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await db.crossProjectSettlement.count({ where: { tenantId } })).toBe(
    1,
  );
});

it("resolves original bank import first despite null FK, legacy origin and duplicated last4", async () => {
  const old = await db.expense.findUniqueOrThrow({ where: { id: sourceId } });
  await db.bankStatementImport.create({
    data: {
      id: "qa702-import",
      tenantId,
      accountId: old.accountId!,
      periodLabel: "2026-09",
      source: "OFX",
    },
  });
  await seedBankAccount(db, {
    tenantId,
    projectId: pessoal,
    last4: old.bankLast4!,
  });
  await db.expense.update({
    where: { id: sourceId },
    data: {
      accountId: null,
      origin: "none",
      importId: "qa702-import",
      formaPagamento: "TRANSFERENCIA_TED",
      externalId: "synthetic-12345",
    },
  });
  await db.cashFlowEntry.updateMany({
    where: { expenseId: sourceId },
    data: { formaPagamento: "TRANSFERENCIA_TED" },
  });
  const before = await sourceSnapshot();
  const result = await apply();
  expect(result.remainingCents).toBe(40000);
  expect(await sourceSnapshot()).toEqual(before);
  await db.bankStatementImport.update({
    where: { id: "qa702-import" },
    data: { deletedAt: new Date() },
  });
  await expect(
    expenses.undoParcelaFunding(
      tenantId,
      pessoal,
      sourceId,
      result.settlementId,
      requester,
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it("rechecks persisted grants before replay and undo", async () => {
  const a = await apply();
  await db.user.update({
    where: { id: requester.id },
    data: {
      role: "USER",
      allowedProjects: JSON.stringify([pessoal]),
      allowedProjectTypes: '["PESSOAL"]',
      allowedModules: '["expenses","bankAccounts"]',
    },
  });
  await expect(apply()).rejects.toMatchObject({ status: 404 });
  await expect(
    expenses.undoParcelaFunding(
      tenantId,
      pessoal,
      sourceId,
      a.settlementId,
      requester,
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (
      await db.crossProjectSettlement.findUniqueOrThrow({
        where: { id: a.settlementId },
      })
    ).reversedAt,
  ).toBeNull();
});

it("preserves metadata edits, blocks financial edits/deletion/manual payment, and rolls back drifted undo", async () => {
  const a = await apply();
  const ids = (
    await prisma.cashFlowEntry.findMany({ where: { expenseId: targetId } })
  )
    .map((c) => c.id)
    .sort();
  await expenses.update(
    tenantId,
    reforma,
    targetId,
    { titulo: "Changed label", tipoDespesa: "OUTROS" },
    requester,
  );
  expect(
    (await prisma.cashFlowEntry.findMany({ where: { expenseId: targetId } }))
      .map((c) => c.id)
      .sort(),
  ).toEqual(ids);
  await expect(
    expenses.update(tenantId, reforma, targetId, { valor: 900 }, requester),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    expenses.remove(tenantId, pessoal, sourceId, requester),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    expenses.payPlanned(tenantId, reforma, targetId, {}),
  ).rejects.toMatchObject({ status: 409 });
  const row = await db.crossProjectSettlement.findUniqueOrThrow({
    where: { id: a.settlementId },
  });
  await db.cashFlowEntry.update({
    where: { id: row.targetPaidCashFlowEntryId! },
    data: { valor: 1 },
  });
  await expect(
    expenses.undoParcelaFunding(tenantId, pessoal, sourceId, row.id, requester),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await db.crossProjectSettlement.findUniqueOrThrow({
      where: { id: row.id },
    }),
  ).toEqual(row);
});

it("serializes independent clients without overpaying or consuming twice", async () => {
  const b = await secondSource(500);
  await expenses.update(tenantId, pessoal, sourceId, { valor: 500 }, requester);
  const client = new PrismaService();
  try {
    const results = await Promise.allSettled([
      apply("qa702-race-a", 50000),
      applyParcelaFunding(
        client,
        tenantId,
        pessoal,
        b.id,
        command("qa702-race-b", 50000),
        requester,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (await db.crossProjectSettlement.findMany({ where: { tenantId } })).map(
        (r) => r.realValor,
      ),
    ).toEqual([50000]);
    expect(
      (await db.cashFlowEntry.findUniqueOrThrow({ where: { id: pendingId } }))
        .valor,
    ).toBe(30000);
  } finally {
    await client.$disconnect();
  }
});

it("conserves target budget and consolidated bank cash while account projections show only remainder", async () => {
  await apply();
  const dashboard = await new DashboardService(prisma).getDashboard(
    tenantId,
    reforma,
  );
  expect(dashboard.kpis).toMatchObject({
    jaPaguei: 40000,
    previsaoGastos: 40000,
  });
  expect(dashboard.resumoPorAmbiente).toEqual([
    { roomName: "Sem Ambiente", planned: 40000, actual: 40000 },
  ]);
  const summary = await expenses.findAll(tenantId, reforma, {}, requester);
  expect(summary.items[0].installmentSettlements?.[0]).toMatchObject({
    dueDate: "2026-09-20T00:00:00.000Z",
    paidCents: 40000,
    remainingCents: 40000,
  });
  expect(
    (await expenses.findById(tenantId, pessoal, sourceId, requester))
      .sourceAvailableCents,
  ).toBe(0);
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  const overview = await monthly.getOverview(
    tenantId,
    pessoal,
    "2026-09",
    requester,
  );
  expect(overview.entries.filter((e) => e.isSettlementProjection)).toHaveLength(
    1,
  );
  const account = await monthly.getAccountView(
    tenantId,
    pessoal,
    "2026-09",
    requester,
  );
  expect(account.saidas.find((e) => e.id === `${targetId}#0`)).toMatchObject({
    valor: 40000,
    realizado: false,
  });
  expect(account.saidas.filter((e) => e.id === sourceId)).toHaveLength(1);
});

it("keeps additive CFE identities through a legacy sibling settlement and undo", async () => {
  await expenses.update(
    tenantId,
    reforma,
    targetId,
    {
      valor: 1600,
      formaPagamento: "PARCELADO",
      quantidadeParcela: 2,
      dataInicioParcela: "2026-09-20",
    },
    requester,
  );
  pendingId = (
    await prisma.cashFlowEntry.findFirstOrThrow({
      where: { expenseId: targetId, parcela: "1/2", deletedAt: null },
    })
  ).id;
  const a = await apply();
  const protectedCash = await db.cashFlowEntry.findMany({
    where: { expenseId: targetId, parcela: "1/2" },
    orderBy: { id: "asc" },
  });
  const b = await secondSource();
  await expenses.conciliarParcela(
    tenantId,
    pessoal,
    b.id,
    { targetExpenseId: targetId, parcelaIndex: 1 },
    requester,
  );
  expect(
    await db.cashFlowEntry.findMany({
      where: { expenseId: targetId, parcela: "1/2" },
      orderBy: { id: "asc" },
    }),
  ).toEqual(protectedCash);
  const sibling = await prisma.cashFlowEntry.findFirstOrThrow({
    where: { expenseId: targetId, parcela: "2/2", deletedAt: null },
  });
  expect(sibling).toMatchObject({ valor: 40000, status: "PAGO" });
  await expenses.undoParcelaFunding(
    tenantId,
    pessoal,
    sourceId,
    a.settlementId,
    requester,
  );
  expect(
    await db.cashFlowEntry.findUniqueOrThrow({ where: { id: sibling.id } }),
  ).toEqual(sibling);
  expect(
    await db.expense.findUniqueOrThrow({ where: { id: targetId } }),
  ).toMatchObject({ valorTotal: 160000, paidParcelas: "[1]" });
});

it("omits every contribution identity if any active source is inaccessible", async () => {
  await apply();
  const b = await secondSource();
  const hidden = "qa702-hidden";
  await db.project.create({
    data: {
      id: hidden,
      tenantId,
      type: "PESSOAL",
      name: "Synthetic hidden source",
    },
  });
  const account = await seedBankAccount(db, {
    tenantId,
    projectId: hidden,
    last4: "1702",
  });
  await db.expense.update({
    where: { id: b.id },
    data: {
      projectId: hidden,
      accountId: account.id,
      bankLast4: account.last4,
    },
  });
  await db.cashFlowEntry.updateMany({
    where: { expenseId: b.id },
    data: { projectId: hidden },
  });
  await applyParcelaFunding(
    prisma,
    tenantId,
    hidden,
    b.id,
    command("qa702-b"),
    requester,
  );
  const reader = {
    id: requester.id,
    role: "USER",
    allowedProjects: [pessoal, reforma],
    allowedProjectTypes: ["PESSOAL", "REFORMA"],
    allowedModules: ["expenses", "bankAccounts"],
  };
  const origin = new PaidOriginsService(prisma);
  expect(
    (await origin.findForProject(tenantId, reforma, requester)).items[0]
      .contributions,
  ).toHaveLength(2);
  expect(
    (await origin.findForProject(tenantId, reforma, reader)).items,
  ).toEqual([]);
  const view = await expenses.findById(tenantId, reforma, targetId, reader);
  expect(view.installmentSettlements?.[0]).toMatchObject({
    paidCents: 80000,
    remainingCents: 0,
  });
  expect(view.installmentSettlements?.[0]).not.toHaveProperty("contributions");
  const crossProject = await expenses.findCrossProject(
    tenantId,
    pessoal,
    { projectId: reforma, status: "PAGO" },
    reader,
  );
  expect(
    crossProject.find((row) => row.id === targetId)
      ?.installmentSettlements?.[0],
  ).not.toHaveProperty("contributions");
  expect(JSON.stringify(crossProject)).not.toContain(b.id);
  const authorized = await expenses.findById(
    tenantId,
    reforma,
    targetId,
    requester,
  );
  expect(authorized.installmentSettlements?.[0]?.contributions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceId }),
      expect.objectContaining({ sourceId: b.id }),
    ]),
  );
});

it("rolls back a projection and claim when the conditional target write fails", async () => {
  const client = new PrismaService();
  client.$use(async (params, next) => {
    if (
      params.model === "Expense" &&
      params.action === "updateMany" &&
      params.args.where.id === targetId
    ) {
      throw new Error("qa702 injected write failure");
    }
    return next(params);
  });
  const before = await sourceSnapshot();
  try {
    await expect(
      applyParcelaFunding(
        client,
        tenantId,
        pessoal,
        sourceId,
        command(),
        requester,
      ),
    ).rejects.toThrow("qa702 injected write failure");
    expect(await db.crossProjectSettlement.count({ where: { tenantId } })).toBe(
      0,
    );
    expect(
      await db.cashFlowEntry.count({ where: { expenseId: targetId } }),
    ).toBe(1);
    expect(await sourceSnapshot()).toEqual(before);
  } finally {
    await client.$disconnect();
  }
});

it("routes additive POST and individual DELETE through real HTTP JWT/module/project guards", async () => {
  const module = await Test.createTestingModule({
    controllers: [ExpenseController],
    providers: [
      ExpenseService,
      ConciliacaoService,
      PaidOriginsService,
      JwtStrategy,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  const app = module.createNestApplication();
  const reflector = new Reflector();
  app.useGlobalGuards(
    new JwtAuthGuard(reflector),
    new RolesGuard(reflector),
    new ModulesGuard(reflector, prisma),
    new ProjectAccessGuard(prisma),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, "127.0.0.1");
  const http = await playwrightRequest.newContext({
    baseURL: await app.getUrl(),
  });
  const jwt = new JwtService({
    secret: process.env.JWT_SECRET || "dev-secret-change-me",
  });
  const headers = {
    Authorization: `Bearer ${jwt.sign({ sub: requester.id, tenantId, sv: 0 })}`,
  };
  const path = `/projects/${pessoal}/expenses/${sourceId}/conciliar-parcela`;
  try {
    expect((await http.post(path, { data: command() })).status()).toBe(401);
    expect(
      (
        await http.post(path, {
          headers,
          data: { ...command(), realValor: 40000 },
        })
      ).status(),
    ).toBe(400);
    const response = await http.post(path, { headers, data: command() });
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      state: "ACTIVE",
      paidCents: 40000,
      remainingCents: 40000,
    });
    const planned = await expenses.findPlanned(tenantId, reforma, requester);
    const listed = await expenses.findAll(tenantId, reforma, {}, requester);
    for (const item of [
      planned.find((row) => row.id === targetId),
      listed.items.find((row) => row.id === targetId),
    ]) {
      expect(item?.installmentSettlements?.[0]?.contributions).toEqual([
        {
          settlementId: body.settlementId,
          sourceId,
          amountCents: 40000,
          paymentDate: "2026-09-10T00:00:00.000Z",
        },
      ]);
    }
    const second = await secondSource();
    await expenses.update(
      tenantId,
      pessoal,
      second.id,
      { dataPagamento: "2026-09-10" },
      requester,
    );
    const secondPath = `/projects/${pessoal}/expenses/${second.id}/conciliar-parcela`;
    const secondResponse = await http.post(secondPath, {
      headers,
      data: command("http-second"),
    });
    expect(secondResponse.status()).toBe(201);
    const secondBody = await secondResponse.json();
    const expectedContributions = [
      {
        settlementId: body.settlementId,
        sourceId,
        amountCents: 40000,
        paymentDate: "2026-09-10T00:00:00.000Z",
      },
      {
        settlementId: secondBody.settlementId,
        sourceId: second.id,
        amountCents: 40000,
        paymentDate: "2026-09-10T00:00:00.000Z",
      },
    ].sort((a, b) => a.settlementId.localeCompare(b.settlementId));
    const crossPath = `/projects/${pessoal}/expenses/cross-project?targetProjectId=${reforma}`;
    const reopened = await http.get(`${crossPath}&status=PAGO`, { headers });
    expect(reopened.status()).toBe(200);
    expect(await reopened.json()).toEqual([
      expect.objectContaining({
        id: targetId,
        status: "PAGO",
        installmentSettlements: [
          expect.objectContaining({
            settlementStatus: "PAID",
            paidCents: 80000,
            remainingCents: 0,
            contributions: expectedContributions,
          }),
        ],
      }),
    ]);
    const sources = await http.get(
      `/projects/${reforma}/expenses/cross-project?targetProjectId=${pessoal}&status=PAGO`,
      { headers },
    );
    expect(sources.status()).toBe(200);
    expect(await sources.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sourceId, sourceAvailableCents: 0 }),
        expect.objectContaining({ id: second.id, sourceAvailableCents: 0 }),
      ]),
    );
    await db.user.update({
      where: { id: requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([pessoal]),
        allowedModules: '["expenses","bankAccounts"]',
        allowedProjectTypes: '["PESSOAL","REFORMA"]',
      },
    });
    expect(
      (await http.delete(`${path}/${body.settlementId}`, { headers })).status(),
    ).toBe(404);
    await db.user.update({
      where: { id: requester.id },
      data: { allowedProjects: JSON.stringify([pessoal, reforma]) },
    });
    const undo = await http.delete(`${path}/${body.settlementId}`, { headers });
    expect(undo.status()).toBe(200);
    expect(await undo.json()).toMatchObject({
      state: "REVERSED",
      remainingCents: 40000,
    });
    expect(
      (
        await http.delete(`${secondPath}/${secondBody.settlementId}`, {
          headers,
        })
      ).status(),
    ).toBe(200);
    const afterUndo = await http.get(crossPath, { headers });
    expect(afterUndo.status()).toBe(200);
    expect(await afterUndo.json()).toEqual([
      expect.objectContaining({
        id: targetId,
        status: "PLANEJADO",
        installmentSettlements: [
          expect.objectContaining({
            settlementStatus: "UNPAID",
            paidCents: 0,
            remainingCents: 80000,
            contributions: [],
          }),
        ],
      }),
    ]);
    expect(
      await (
        await http.get(`/projects/${pessoal}/expenses/${sourceId}`, { headers })
      ).json(),
    ).toMatchObject({
      sourceAvailableCents: 40000,
    });
    expect(
      await (
        await http.delete(`${path}/${body.settlementId}`, { headers })
      ).json(),
    ).toMatchObject({
      state: "REVERSED",
      replayed: true,
      remainingCents: 80000,
    });
  } finally {
    await http.dispose();
    await app.close();
  }
});
