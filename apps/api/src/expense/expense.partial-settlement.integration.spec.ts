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
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import {
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";
import { PendenciaController } from "../pendencia/pendencia.controller";
import {
  PendenciaService,
  type FinancialQueueResponse,
} from "../pendencia/pendencia.service";
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
  seedProject,
  seedBankAccount,
  seedCardWithClosingDue,
  seedStatementImport,
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
const tenantState = async () => ({
  expenses: await db.expense.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
  cash: await db.cashFlowEntry.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
  funding: await db.crossProjectSettlement.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  }),
  imports: await db.bankStatementImport.findMany({
    where: { tenantId },
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

describe("Pendencia partial-funding HTTP contract", () => {
  let app: INestApplication;
  let http: APIRequestContext;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ExpenseController, PendenciaController],
      providers: [
        ExpenseService,
        ConciliacaoService,
        PaidOriginsService,
        PendenciaService,
        MonthlyOverviewService,
        MerchantClassifierService,
        BankAccountService,
        CardInvoiceSettlementService,
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    app = module.createNestApplication();
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
    http = await playwrightRequest.newContext({ baseURL: await app.getUrl() });
    const jwt = new JwtService({
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
    });
    headers = {
      Authorization: `Bearer ${jwt.sign({ sub: requester.id, tenantId, sv: 0 })}`,
    };
  });

  afterAll(async () => {
    await http.dispose();
    await app.close();
  });

  async function queue(month = "2026-09"): Promise<FinancialQueueResponse> {
    const response = await http.get(
      `/projects/${pessoal}/pendencias/financeiras?month=${month}`,
      { headers },
    );
    expect(response.status()).toBe(200);
    return response.json();
  }

  it("carries canonical 80000/40000/40000 totals without a legacy payment action, then restores UNPAID after undo", async () => {
    expect(
      (
        await http.get(
          `/projects/${pessoal}/pendencias/financeiras?month=2026-09`,
        )
      ).status(),
    ).toBe(401);
    const beforeSource = await sourceSnapshot();
    const path = `/projects/${pessoal}/expenses/${sourceId}/conciliar-parcela`;
    const applied = await http.post(path, {
      headers,
      data: command("queue-first"),
    });
    expect(applied.status()).toBe(201);
    const first: { settlementId: string } = await applied.json();
    const beforeRead = await tenantState();
    const response = await queue();
    const group = response.grupos.find(
      (g) => g.tipo === "PARCELA_FOREIGN_PENDENTE",
    );
    expect(group).toMatchObject({
      count: 1,
      valorTotal: 40000,
      itens: [
        {
          foreignExpenseId: targetId,
          parcelaIndex: 0,
          valor: 40000,
          installmentSettlement: {
            contractedCents: 80000,
            paidCents: 40000,
            remainingCents: 40000,
            settlementStatus: "PARTIAL",
          },
          canExecuteAction: false,
          label: "Parcela parcialmente paga",
        },
      ],
    });
    const serialized = JSON.stringify(response);
    for (const hidden of [
      sourceId,
      first.settlementId,
      '"contributions"',
      '"sourceId"',
    ]) {
      expect(serialized).not.toContain(hidden);
    }
    expect(await tenantState()).toEqual(beforeRead);
    const rejected = await http.post(path, {
      headers,
      data: { targetExpenseId: targetId, parcelaIndex: 0, realValor: 40000 },
    });
    expect(rejected.status()).toBe(409);
    expect(await tenantState()).toEqual(beforeRead);

    const second = await secondSource();
    const secondPath = `/projects/${pessoal}/expenses/${second.id}/conciliar-parcela`;
    const completed = await http.post(secondPath, {
      headers,
      data: command("queue-second"),
    });
    expect(completed.status()).toBe(201);
    const last: { settlementId: string } = await completed.json();
    expect(
      (await queue()).grupos
        .flatMap((g) => g.itens)
        .filter((item) => item.foreignExpenseId === targetId),
    ).toEqual([]);
    expect(
      (
        await http.delete(`${secondPath}/${last.settlementId}`, { headers })
      ).status(),
    ).toBe(200);
    expect(
      (await queue()).grupos.find((g) => g.tipo === "PARCELA_FOREIGN_PENDENTE")
        ?.itens[0],
    ).toMatchObject({
      valor: 40000,
      installmentSettlement: { settlementStatus: "PARTIAL" },
      canExecuteAction: false,
    });
    expect(
      (
        await http.delete(`${path}/${first.settlementId}`, { headers })
      ).status(),
    ).toBe(200);
    const unpaid = (await queue()).grupos.find(
      (g) => g.tipo === "PARCELA_FOREIGN_PENDENTE",
    )?.itens[0];
    expect(unpaid).toMatchObject({
      valor: 80000,
      installmentSettlement: {
        contractedCents: 80000,
        paidCents: 0,
        remainingCents: 80000,
        settlementStatus: "UNPAID",
      },
      canExecuteAction: true,
      label: "Quitar parcela",
    });
    expect(unpaid).not.toHaveProperty("actions");
    expect(await sourceSnapshot()).toEqual(beforeSource);
    expect(
      await prisma.cashFlowEntry.findFirst({ where: { id: pendingId } }),
    ).toMatchObject({ valor: 80000, status: "PLANEJADO" });
  });

  it("also blocks the SEM_CONTA copy while keeping an untouched sibling's legacy action", async () => {
    await expenses.update(
      tenantId,
      reforma,
      targetId,
      {
        valor: 2400,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 3,
        dataInicioParcela: "2026-09-20",
      },
      requester,
    );
    const legacy = await secondSource();
    await expenses.conciliarParcela(
      tenantId,
      pessoal,
      legacy.id,
      {
        targetExpenseId: targetId,
        parcelaIndex: 2,
        realValor: 40000,
      },
      requester,
    );
    await apply("queue-mixed");
    const groups = (await queue()).grupos;
    for (const tipo of ["SEM_CONTA", "PARCELA_FOREIGN_PENDENTE"]) {
      const item = groups
        .find((g) => g.tipo === tipo)
        ?.itens.find((item) => item.foreignExpenseId === targetId);
      expect(item).toMatchObject({
        parcelaIndex: 0,
        valor: 40000,
        canExecuteAction: false,
        label: "Parcela parcialmente paga",
      });
      expect(item).toHaveProperty("installmentSettlement", {
        contractedCents: 80000,
        paidCents: 40000,
        remainingCents: 40000,
        settlementStatus: "PARTIAL",
      });
      for (const removed of [
        "actions",
        "contractedCents",
        "paidCents",
        "remainingCents",
        "settlementStatus",
      ]) {
        expect(item).not.toHaveProperty(removed);
      }
    }
    const sibling = (await queue("2026-10")).grupos.find(
      (g) => g.tipo === "PARCELA_FOREIGN_PENDENTE",
    )?.itens[0];
    expect(sibling).toMatchObject({
      parcelaIndex: 1,
      valor: 80000,
      label: "Quitar parcela",
    });
    expect(sibling).not.toHaveProperty("actions");
    expect(sibling).not.toHaveProperty("installmentSettlement");
    expect(sibling).not.toHaveProperty("canExecuteAction");
  });

  it("exposes only target-owned totals with a hidden contributor and rechecks queue visibility", async () => {
    const hiddenProject = `${pessoal}-hidden`;
    await seedProject(db, {
      tenantId,
      projectId: hiddenProject,
      type: "PESSOAL",
      name: "Synthetic private source",
    });
    const account = await seedBankAccount(db, {
      tenantId,
      projectId: hiddenProject,
      last4: "7777",
    });
    const hiddenSource = await expenses.create(tenantId, hiddenProject, {
      tipoDespesa: "OUTROS",
      valor: 400,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PAGO",
      dataPagamento: "2026-09-10",
      bankAccountId: account.id,
    });
    const funding = await applyParcelaFunding(
      prisma,
      tenantId,
      hiddenProject,
      hiddenSource.id,
      command("queue-private"),
      requester,
    );
    await db.user.update({
      where: { id: requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([pessoal, reforma]),
        allowedModules: JSON.stringify([
          "pendencias",
          "monthlyOverview",
          "expenses",
          "bankAccounts",
        ]),
        allowedProjectTypes: JSON.stringify(["PESSOAL", "REFORMA"]),
      },
    });
    const response = await queue();
    expect(
      response.grupos.find((g) => g.tipo === "PARCELA_FOREIGN_PENDENTE")
        ?.itens[0],
    ).toMatchObject({
      valor: 40000,
      installmentSettlement: {
        contractedCents: 80000,
        paidCents: 40000,
        remainingCents: 40000,
        settlementStatus: "PARTIAL",
      },
      canExecuteAction: false,
    });
    for (const hidden of [
      hiddenProject,
      hiddenSource.id,
      funding.settlementId,
      account.id,
      '"contributions"',
      '"sourceId"',
    ]) {
      expect(JSON.stringify(response)).not.toContain(hidden);
    }
    await db.user.update({
      where: { id: requester.id },
      data: { allowedProjects: JSON.stringify([pessoal]) },
    });
    expect(JSON.stringify(await queue())).not.toContain(targetId);
  });
});

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

it.each([20000, 80000])(
  "X1: PESSOAL monthly/yearly counts only the bank source for funding %i, including full payment",
  async (amountCents) => {
    await expenses.update(
      tenantId,
      pessoal,
      sourceId,
      { valor: 800 },
      requester,
    );
    const before = await sourceSnapshot();
    const funding = await apply("pessoal-lens", amountCents);
    const monthly = new MonthlyOverviewService(
      prisma,
      new CardInvoiceSettlementService(prisma),
    );
    const month = await monthly.getAccountView(
      tenantId,
      pessoal,
      "2026-09",
      requester,
    );
    expect(month).toMatchObject({
      saiuMes: 80000,
      saidaTotal: 160000 - amountCents,
      faltaPagarMes: 80000 - amountCents,
      caixaHoje: -80000,
      carteiraHoje: 0,
    });
    expect(month.saidas.filter((row) => row.realizado)).toEqual([
      expect.objectContaining({
        id: sourceId,
        valor: 80000,
        bankLast4: "0702",
        foreignExpenseId: null,
        projetoOrigem: null,
      }),
    ]);
    const year = await monthly.getAccountViewYearly(
      tenantId,
      pessoal,
      2026,
      requester,
    );
    expect(year).toMatchObject({
      saiuMes: 80000,
      faltaPagarMes: 80000 - amountCents,
      caixaHoje: -80000,
    });
    expect(year.saidas.reduce((sum, row) => sum + row.valor, 0)).toBe(
      160000 - amountCents,
    );
    expect(
      year.saidas.filter((row) => row.realizado).map((row) => row.id),
    ).toEqual([sourceId]);
    const dre = await monthly.getDreOverview(
      tenantId,
      pessoal,
      { month: "2026-09", year: 2026 },
      requester,
    );
    expect(dre.anual.totalSaiu).toBe(80000);
    expect(dre.mensal.contaCorrente).toMatchObject({
      saiuMes: 80000,
      faltaPagarMes: 80000 - amountCents,
      despesaTotal: 160000 - amountCents,
    });
    const sourceOnly = await monthly.getAccountView(
      tenantId,
      pessoal,
      "2026-09",
      {
        ...requester,
        role: "USER",
        allowedProjects: [pessoal],
        allowedProjectTypes: ["PESSOAL"],
        allowedModules: ["monthlyOverview"],
      },
    );
    expect(sourceOnly).toMatchObject({
      saiuMes: 80000,
      saidaTotal: 80000,
      faltaPagarMes: 0,
    });
    expect(JSON.stringify(sourceOnly)).not.toContain(targetId);
    expect(await sourceSnapshot()).toEqual(before);
    await expenses.undoParcelaFunding(
      tenantId,
      pessoal,
      sourceId,
      funding.settlementId,
      requester,
    );
    expect(
      await monthly.getAccountView(tenantId, pessoal, "2026-09", requester),
    ).toMatchObject({
      saiuMes: 80000,
      saidaTotal: 160000,
      faltaPagarMes: 80000,
    });
  },
);

it("X1: a paid foreign root retains its legitimate wallet occurrence, not its bank-funded sibling", async () => {
  await expenses.update(tenantId, pessoal, sourceId, { valor: 800 }, requester);
  await expenses.update(
    tenantId,
    reforma,
    targetId,
    {
      valor: 1600,
      formaPagamento: "PARCELADO",
      quantidadeParcela: 2,
      dataInicioParcela: "2026-08-20",
    },
    requester,
  );
  await expenses.setParcelaStatus(tenantId, reforma, targetId, 0, true);
  const walletCash = await prisma.cashFlowEntry.findFirstOrThrow({
    where: { expenseId: targetId, parcela: "1/2", deletedAt: null },
  });
  const before = await sourceSnapshot();
  const funding = await applyParcelaFunding(
    prisma,
    tenantId,
    pessoal,
    sourceId,
    {
      ...command("pessoal-mixed", 80000),
      parcelaIndex: 1,
    },
    requester,
  );
  expect(
    await db.expense.findUniqueOrThrow({ where: { id: targetId } }),
  ).toMatchObject({ status: "PAGO", valorTotal: 160000 });
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  const august = await monthly.getAccountView(
    tenantId,
    pessoal,
    "2026-08",
    requester,
  );
  expect(august).toMatchObject({
    saiuMes: 80000,
    saidaTotal: 80000,
    faltaPagarMes: 0,
  });
  expect(august.saidas).toEqual([
    expect.objectContaining({
      foreignExpenseId: targetId,
      parcelaIndex: 0,
      valor: 80000,
      data: "2026-08-20T00:00:00.000Z",
      realizado: true,
      origem: { tipo: "carteira" },
    }),
  ]);
  const september = await monthly.getAccountView(
    tenantId,
    pessoal,
    "2026-09",
    requester,
  );
  expect(september).toMatchObject({
    saiuMes: 80000,
    saidaTotal: 80000,
    faltaPagarMes: 0,
    caixaHoje: -80000,
  });
  expect(september.saidas).toEqual([
    expect.objectContaining({
      id: sourceId,
      bankLast4: "0702",
      valor: 80000,
      realizado: true,
    }),
  ]);
  const year = await monthly.getAccountViewYearly(
    tenantId,
    pessoal,
    2026,
    requester,
  );
  expect(year).toMatchObject({ saiuMes: 160000, faltaPagarMes: 0 });
  expect(year.saidas).toHaveLength(2);
  expect(year.saidas.reduce((sum, row) => sum + row.valor, 0)).toBe(160000);
  expect(
    await prisma.cashFlowEntry.findUniqueOrThrow({
      where: { id: walletCash.id },
    }),
  ).toEqual(walletCash);
  expect(await sourceSnapshot()).toEqual(before);
  await expenses.undoParcelaFunding(
    tenantId,
    pessoal,
    sourceId,
    funding.settlementId,
    requester,
  );
  expect(
    (await monthly.getAccountView(tenantId, pessoal, "2026-08", requester))
      .saidas,
  ).toEqual(august.saidas);
  expect(
    await monthly.getAccountView(tenantId, pessoal, "2026-09", requester),
  ).toMatchObject({ saiuMes: 80000, saidaTotal: 160000, faltaPagarMes: 80000 });
});

it("X1: a bankless PESSOAL keeps actual local/foreign wallet payments without inventing funded wallet cash", async () => {
  await expenses.update(tenantId, pessoal, sourceId, { valor: 800 }, requester);
  await apply("bankless-lens", 80000);
  const walletProject = `${pessoal}-wallet`;
  await seedProject(db, {
    tenantId,
    projectId: walletProject,
    type: "PESSOAL",
    name: "Synthetic wallet",
  });
  const payment = {
    tipoDespesa: "OUTROS",
    valor: 123.45,
    quantidade: 1,
    formaPagamento: "A_VISTA",
    status: "PAGO",
    dataPagamento: "2026-09-10",
  };
  const localWallet = await expenses.create(tenantId, walletProject, payment);
  const foreignWallet = await expenses.create(tenantId, reforma, payment);
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  const month = await monthly.getAccountView(
    tenantId,
    walletProject,
    "2026-09",
    requester,
  );
  expect(month).toMatchObject({
    contas: [],
    caixaHoje: 0,
    carteiraHoje: -12345,
    saiuMes: 24690,
    saidaTotal: 24690,
    faltaPagarMes: 0,
  });
  expect(month.saidas.map((row) => row.id).sort()).toEqual(
    [localWallet.id, foreignWallet.id].sort(),
  );
  expect(
    month.saidas.every(
      (row) => row.realizado && row.origem?.tipo === "carteira",
    ),
  ).toBe(true);
  const year = await monthly.getAccountViewYearly(
    tenantId,
    walletProject,
    2026,
    requester,
  );
  expect(year).toMatchObject({
    saiuMes: 24690,
    faltaPagarMes: 0,
    caixaHoje: 0,
    carteiraHoje: -12345,
  });
  expect(year.saidas).toHaveLength(2);
  for (const hidden of [targetId, sourceId, '"contributions"']) {
    expect(JSON.stringify(month)).not.toContain(hidden);
  }
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

it.each(["authorized", "revoked target"])(
  "SEC1: preflights adopted import sources before any batch write (%s)",
  async (access) => {
    const source = await db.expense.findUniqueOrThrow({
      where: { id: sourceId },
    });
    const importId = await seedStatementImport(db, {
      tenantId,
      accountId: source.accountId!,
      id: "qa702-adopted-batch",
    });
    await db.bankStatementImport.update({
      where: { id: importId },
      data: {
        status: "COMPLETED",
        createdAt: new Date("2026-09-15"),
        inlineExpenseCreations: null,
      },
    });
    const created = await secondSource();
    await db.expense.update({
      where: { id: sourceId },
      data: {
        importId,
        externalId: "synthetic-adopted-12345",
        accountId: null,
        origin: "none",
        createdAt: new Date("2026-09-01"),
      },
    });
    await db.expense.update({
      where: { id: created.id },
      data: { importId, createdAt: new Date("2026-09-16") },
    });
    const claim = await apply();
    if (access === "revoked target") {
      await db.user.update({
        where: { id: requester.id },
        data: {
          role: "USER",
          allowedProjects: JSON.stringify([pessoal]),
          allowedProjectTypes: '["PESSOAL","REFORMA"]',
          allowedModules: '["expenses","bankAccounts"]',
        },
      });
    }
    const before = await tenantState();
    const banks = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
    await expect(
      banks.undoImport(
        tenantId,
        pessoal,
        source.accountId!,
        importId,
        requester,
      ),
    ).rejects.toMatchObject({ status: access === "authorized" ? 409 : 404 });
    expect(await tenantState()).toEqual(before);
    if (access === "authorized") {
      await expenses.undoParcelaFunding(
        tenantId,
        pessoal,
        sourceId,
        claim.settlementId,
        requester,
      );
      expect(
        await banks.undoImport(
          tenantId,
          pessoal,
          source.accountId!,
          importId,
          requester,
        ),
      ).toMatchObject({ removedExpenses: 1, unstamped: 1 });
      expect(
        await db.cashFlowEntry.findMany({
          where: { expenseId: sourceId },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before.cash.filter((entry) => entry.expenseId === sourceId));
      expect(
        await db.expense.findUniqueOrThrow({ where: { id: sourceId } }),
      ).toMatchObject({
        valorTotal: 40000,
        status: "PAGO",
        dataPagamento: new Date("2026-09-10"),
        importId: null,
        externalId: null,
        accountId: null,
        deletedAt: null,
      });
      expect(
        await db.crossProjectSettlement.findUniqueOrThrow({
          where: { id: claim.settlementId },
        }),
      ).toMatchObject({
        reversedAt: expect.any(Date),
        reversedByUserId: requester.id,
      });
    }
  },
);

it.each(["expense", "account", "project"])(
  "SEC2: a reversed source's deleted %s cannot trap another contribution",
  async (deleted) => {
    const otherProject = "qa702-independent-bank";
    await seedProject(db, {
      tenantId,
      projectId: otherProject,
      type: "PESSOAL",
      name: "Synthetic independent bank",
    });
    const account = await seedBankAccount(db, {
      tenantId,
      projectId: otherProject,
      last4: "1702",
    });
    const b = await expenses.create(tenantId, otherProject, {
      tipoDespesa: "OUTROS",
      valor: 400,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PAGO",
      dataPagamento: "2026-09-10",
      bankAccountId: account.id,
    });
    const bBefore = await db.expense.findUniqueOrThrow({ where: { id: b.id } });
    const bCash = await db.cashFlowEntry.findMany({
      where: { expenseId: b.id },
    });
    const aClaim = await apply();
    const bClaim = await applyParcelaFunding(
      prisma,
      tenantId,
      otherProject,
      b.id,
      command("independent-b"),
      requester,
    );
    await expenses.undoParcelaFunding(
      tenantId,
      pessoal,
      sourceId,
      aClaim.settlementId,
      requester,
    );
    const aSource = await db.expense.findUniqueOrThrow({
      where: { id: sourceId },
    });
    if (deleted === "expense") {
      await expenses.remove(tenantId, pessoal, sourceId, requester);
    } else if (deleted === "account") {
      const banks = new BankAccountService(
        prisma,
        new MerchantClassifierService(prisma),
        new ConciliacaoService(prisma),
        new CardInvoiceSettlementService(prisma),
      );
      await banks.deleteAccount(tenantId, pessoal, aSource.accountId!);
    } else {
      await new ProjectService(prisma).remove(tenantId, pessoal);
    }
    const before = await tenantState();
    await expect(
      expenses.undoParcelaFunding(
        tenantId,
        pessoal,
        sourceId,
        aClaim.settlementId,
        requester,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await tenantState()).toEqual(before);
    expect(
      await expenses.undoParcelaFunding(
        tenantId,
        otherProject,
        b.id,
        bClaim.settlementId,
        requester,
      ),
    ).toMatchObject({
      state: "REVERSED",
      paidCents: 0,
      remainingCents: 80000,
      sourceAvailableCents: 40000,
    });
    expect(await db.expense.findUniqueOrThrow({ where: { id: b.id } })).toEqual(
      bBefore,
    );
    expect(
      await db.cashFlowEntry.findMany({ where: { expenseId: b.id } }),
    ).toEqual(bCash);
    expect(
      await db.cashFlowEntry.findUniqueOrThrow({ where: { id: pendingId } }),
    ).toMatchObject({ valor: 80000, status: "PLANEJADO", deletedAt: null });
    expect(
      await db.crossProjectSettlement.findMany({ where: { tenantId } }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: aClaim.settlementId,
          reversedAt: expect.any(Date),
          reversedByUserId: requester.id,
        }),
        expect.objectContaining({
          id: bClaim.settlementId,
          reversedAt: expect.any(Date),
          reversedByUserId: requester.id,
        }),
      ]),
    );
  },
);

it("SEC2: a fresh request uses the current plan after all funding is reversed and finance edited", async () => {
  const before = await sourceSnapshot();
  const old = await apply();
  await expenses.undoParcelaFunding(
    tenantId,
    pessoal,
    sourceId,
    old.settlementId,
    requester,
  );
  await expenses.update(
    tenantId,
    reforma,
    targetId,
    { valor: 900, dataPagamento: "2026-09-22" },
    requester,
  );
  const pending = await db.cashFlowEntry.findFirstOrThrow({
    where: { expenseId: targetId, deletedAt: null },
  });
  expect(pending.id).not.toBe(pendingId);
  const next = await apply("new-plan");
  expect(next).toMatchObject({
    contractedCents: 90000,
    paidCents: 40000,
    remainingCents: 50000,
  });
  expect(await apply()).toMatchObject({
    settlementId: old.settlementId,
    state: "REVERSED",
    replayed: true,
    contractedCents: 90000,
    paidCents: 40000,
    remainingCents: 50000,
    sourceAvailableCents: 0,
  });
  await expect(apply("qa702-first", 12345)).rejects.toMatchObject({
    status: 409,
  });
  await expenses.undoParcelaFunding(
    tenantId,
    pessoal,
    sourceId,
    next.settlementId,
    requester,
  );
  expect(
    await db.cashFlowEntry.findUniqueOrThrow({ where: { id: pending.id } }),
  ).toMatchObject({
    valor: 90000,
    data: new Date("2026-09-22"),
    deletedAt: null,
  });
  expect(await sourceSnapshot()).toEqual(before);
});

it.each([
  ["source", { dataCompra: "2026-09-12" }],
  ["target", { dataCompra: "2026-09-12" }],
  ["source", { tipoDespesa: "INVESTIMENTOS" }],
  ["target", { tipoDespesa: "INVESTIMENTOS" }],
] as const)(
  "SEC3: rejects undo-breaking %s metadata %j atomically",
  async (participant, dto) => {
    const claim = await apply();
    const before = await tenantState();
    await expect(
      expenses.update(
        tenantId,
        participant === "source" ? pessoal : reforma,
        participant === "source" ? sourceId : targetId,
        dto,
        requester,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await tenantState()).toEqual(before);
    expect(
      await expenses.undoParcelaFunding(
        tenantId,
        pessoal,
        sourceId,
        claim.settlementId,
        requester,
      ),
    ).toMatchObject({ state: "REVERSED", remainingCents: 80000 });
  },
);

it("SEC3: equivalent financial fields and genuine category/title metadata keep undo valid", async () => {
  await expenses.update(
    tenantId,
    pessoal,
    sourceId,
    { dataCompra: "2026-09-10" },
    requester,
  );
  const claim = await apply();
  await expenses.update(
    tenantId,
    pessoal,
    sourceId,
    {
      dataCompra: "2026-09-10T00:00:00.000Z",
      tipoDespesa: "MAO_DE_OBRA",
      titulo: "Synthetic renamed",
    },
    requester,
  );
  await expenses.update(
    tenantId,
    reforma,
    targetId,
    { tipoDespesa: "OUTROS", fornecedor: "Synthetic supplier" },
    requester,
  );
  expect(
    await expenses.undoParcelaFunding(
      tenantId,
      pessoal,
      sourceId,
      claim.settlementId,
      requester,
    ),
  ).toMatchObject({ state: "REVERSED", remainingCents: 80000 });
});

it("SEC4: a legacy replacement after additive undo creates its actual paid cashflow", async () => {
  const old = await apply();
  await expenses.undoParcelaFunding(
    tenantId,
    pessoal,
    sourceId,
    old.settlementId,
    requester,
  );
  const b = await secondSource();
  await expenses.conciliarParcela(
    tenantId,
    pessoal,
    b.id,
    { targetExpenseId: targetId, parcelaIndex: 0 },
    requester,
  );
  expect(
    await db.cashFlowEntry.findMany({
      where: { expenseId: targetId, deletedAt: null },
    }),
  ).toEqual([expect.objectContaining({ status: "PAGO", valor: 40000 })]);
  expect(
    await db.expense.findUniqueOrThrow({ where: { id: targetId } }),
  ).toMatchObject({ status: "PAGO", valorTotal: 80000 });
  expect(
    await db.crossProjectSettlement.findUniqueOrThrow({
      where: { id: old.settlementId },
    }),
  ).toMatchObject({
    mode: "ADDITIVE",
    reversedAt: expect.any(Date),
    reversedByUserId: requester.id,
  });
  expect(
    (await expenses.findById(tenantId, reforma, targetId, requester))
      .installmentSettlements,
  ).toBeUndefined();
  expect(
    (await new DashboardService(prisma).getDashboard(tenantId, reforma)).kpis,
  ).toMatchObject({ jaPaguei: 40000, previsaoGastos: 0 });
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  expect(await monthly.getCaixaConta(tenantId, pessoal)).toMatchObject({
    hoje: -80000,
  });
});

it.each([
  "manual paid",
  "card origin",
  "missing pending",
  "ambiguous pending",
  "money drift",
  "card claim",
])(
  "does not offer a first contribution that the writer rejects: %s",
  async (reason) => {
    const pending = await db.cashFlowEntry.findUniqueOrThrow({
      where: { id: pendingId },
    });
    if (reason === "manual paid") {
      await expenses.update(
        tenantId,
        reforma,
        targetId,
        { status: "PAGO" },
        requester,
      );
    } else if (reason === "card origin") {
      await db.expense.update({
        where: { id: targetId },
        data: { cardLast4: "0702" },
      });
    } else if (reason === "missing pending") {
      await db.cashFlowEntry.delete({ where: { id: pendingId } });
    } else if (reason === "ambiguous pending") {
      await db.cashFlowEntry.create({
        data: { ...pending, id: "qa702-duplicate-pending" },
      });
    } else if (reason === "money drift") {
      await db.cashFlowEntry.update({
        where: { id: pendingId },
        data: { valor: 79999 },
      });
    } else {
      const source = await db.expense.findUniqueOrThrow({
        where: { id: sourceId },
      });
      const card = await seedCardWithClosingDue(db, {
        tenantId,
        projectId: pessoal,
        last4: "0702",
      });
      const importId = await seedStatementImport(db, {
        tenantId,
        accountId: source.accountId!,
        id: "qa702-claimed-import",
      });
      await db.importedInvoiceLiquidation.create({
        data: {
          tenantId,
          paymentExpenseId: sourceId,
          purchaseExpenseId: targetId,
          cashFlowEntryId: pendingId,
          cardId: card.id,
          importId,
          prevStatus: "PLANEJADO",
          entryValorCents: 80000,
          dueMonth: "2026-09",
        },
      });
    }
    const before = await sourceSnapshot();
    const rows = await expenses.findCrossProject(
      tenantId,
      pessoal,
      {},
      requester,
    );
    expect(rows.find((row) => row.id === targetId)).not.toHaveProperty(
      "installmentSettlements",
    );
    await expect(apply()).rejects.toMatchObject({ status: 409 });
    expect(await sourceSnapshot()).toEqual(before);
    expect(await db.crossProjectSettlement.count({ where: { tenantId } })).toBe(
      0,
    );
  },
);

it.each(["manual", "legacy"])(
  "offers the untouched canonical index, not its %s-paid sibling",
  async (kind) => {
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
    await expenses.updateInstallmentDate(
      tenantId,
      reforma,
      targetId,
      1,
      "2026-10-23",
      requester,
    );
    const source = await secondSource();
    if (kind === "legacy") {
      await expenses.conciliarParcela(
        tenantId,
        pessoal,
        sourceId,
        { targetExpenseId: targetId, parcelaIndex: 0 },
        requester,
      );
    } else {
      await expenses.setParcelaStatus(tenantId, reforma, targetId, 0, true);
    }
    const rows = await expenses.findCrossProject(
      tenantId,
      pessoal,
      {},
      requester,
    );
    expect(
      rows.find((row) => row.id === targetId)?.installmentSettlements,
    ).toEqual([
      {
        parcelaIndex: 1,
        dueDate: "2026-10-23T00:00:00.000Z",
        contractedCents: 80000,
        paidCents: 0,
        remainingCents: 80000,
        settlementStatus: "UNPAID",
        contributions: [],
      },
    ]);
    await expect(
      applyParcelaFunding(
        prisma,
        tenantId,
        pessoal,
        source.id,
        command("paid-sibling"),
        requester,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await applyParcelaFunding(
        prisma,
        tenantId,
        pessoal,
        source.id,
        {
          ...command("initial-sibling"),
          parcelaIndex: 1,
        },
        requester,
      ),
    ).toMatchObject({
      parcelaIndex: 1,
      contractedCents: 80000,
      remainingCents: 40000,
    });
  },
);

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
