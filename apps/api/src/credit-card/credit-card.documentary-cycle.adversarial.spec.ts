// Load the worktree/worker DB guard before importing Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { AgentToolsService } from "../agent/tools/agent-tools.service";
import { BankAccountService } from "../bank-account/bank-account.service";
import { rankCardCandidates } from "../bank-account/card-invoice-match";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { ExpenseService } from "../expense/expense.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantFinancialService } from "../tenant-financial/tenant-financial.service";
import { CardInvoiceSettlementService } from "./card-invoice-settlement.service";
import { CreditCardController } from "./credit-card.controller";
import { CreditCardService } from "./credit-card.service";
import { parseStatement } from "./parsers";

/**
 * #701 import contract: new positive/negative rows accept
 * decisions[].overrides.documentaryCycle without rewriting their financial dates.
 * Exercise the existing HTTP controller and REAL PrismaService; seed no proposed
 * schema fields. This fixture supplies authentication, not an ACL test double.
 */
const ID = {
  tenant: "qa701-cycle-tenant",
  project: "qa701-cycle-pessoal",
  user: "qa701-cycle-user",
  card: "qa701-cycle-card",
  account: "qa701-cycle-account",
};
const ACTOR = {
  id: ID.user,
  tenantId: ID.tenant,
  role: "USER",
  allowedProjects: [ID.project],
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: [
    "expenses",
    "receipts",
    "creditCards",
    "bankAccounts",
    "monthlyOverview",
  ],
};
const CLOCK = new Date("2026-11-05T12:00:00.000Z");
const CYCLE = {
  invoiceDueMonth: "2026-11",
  evidence: {
    documentSha256: "a".repeat(64),
    reference: "Synthetic QA statement page 1",
  },
};
const CREDITS = [
  "2026-08-14,QA REBATE AMBER,-0.07",
  "2026-09-14,QA REBATE COBALT,-3.21",
];
const PURCHASE = "2026-07-14,QA PURCHASE MAPLE,123.45";
const ALL_ROWS = [...CREDITS, PURCHASE];
type CommitResult = Awaited<ReturnType<CreditCardService["commitImport"]>>;

describe("#701 documentary cycle — adversarial real import", () => {
  const setup = new PrismaClient(); // Physical fixture cleanup/inspection only.
  const prisma = new PrismaService(); // ALL application reads/writes use middleware.
  const classifier = new MerchantClassifierService(prisma);
  const conciliacao = new ConciliacaoService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  const settlement = new CardInvoiceSettlementService(prisma);
  const cards = new CreditCardService(prisma, conciliacao, classifier);
  const banks = new BankAccountService(
    prisma,
    classifier,
    conciliacao,
    settlement,
  );
  const monthly = new MonthlyOverviewService(prisma, settlement);
  const maria = new AgentToolsService(
    prisma,
    new TenantFinancialService(prisma, monthly),
    expenses,
    {} as never, // Unused write services must not participate in this reader.
    cards,
    classifier,
    {} as never,
    monthly,
  );
  let app: INestApplication | undefined;
  let url: string;
  let failCashWrite = false;
  let rejectedCashWrites = 0;

  prisma.$use(async (params, next) => {
    if (
      failCashWrite &&
      params.model === "CashFlowEntry" &&
      (params.action === "create" || params.action === "createMany")
    ) {
      rejectedCashWrites++;
      throw new Error("QA synthetic cash write failure");
    }
    return next(params);
  });

  async function cleanup() {
    const where = { tenantId: ID.tenant };
    await setup.importedInvoiceLiquidation.deleteMany({ where });
    await setup.rateioAllocation.deleteMany({ where });
    await setup.crossProjectSettlement.deleteMany({ where });
    await setup.cashFlowEntry.deleteMany({ where });
    await setup.expense.deleteMany({ where });
    await setup.receipt.deleteMany({ where });
    await setup.invoiceAdjustment.deleteMany({ where });
    await setup.creditCardStatementImport.deleteMany({ where });
    await setup.bankStatementImport.deleteMany({ where });
    await setup.creditCard.deleteMany({ where });
    await setup.bankAccount.deleteMany({ where });
    await setup.merchantCategory.deleteMany({ where });
    await setup.project.deleteMany({ where });
    await setup.user.deleteMany({ where });
    await setup.tenant.deleteMany({ where: { id: ID.tenant } });
  }

  async function financialState() {
    const args = {
      where: { tenantId: ID.tenant },
      orderBy: { id: "asc" as const },
    };
    return {
      expenses: await setup.expense.findMany(args),
      cash: await setup.cashFlowEntry.findMany(args),
      receipts: await setup.receipt.findMany(args),
      settlements: await setup.crossProjectSettlement.findMany(args),
      allocations: await setup.rateioAllocation.findMany(args),
      ledger: await setup.importedInvoiceLiquidation.findMany(args),
      adjustments: await setup.invoiceAdjustment.findMany(args),
      bankImports: await setup.bankStatementImport.findMany(args),
      accounts: await setup.bankAccount.findMany(args),
      cards: await setup.creditCard.findMany(args),
    };
  }

  async function upload(
    rows = ALL_ROWS,
    extraOverrides: Record<string, unknown> = {},
    periodLabel?: string,
  ) {
    const csv = ["date,title,amount", ...rows, ""].join("\n");
    // Reuse the real parser solely for external IDs, never as a money/cycle oracle.
    const parsed = parseStatement(csv, ID.card, "CSV_GENERIC", "qa-cycle.csv");
    const decisions = parsed.transactions.map(({ externalId }) => ({
      externalId,
      action: "create",
      overrides: { documentaryCycle: CYCLE, ...extraOverrides },
    }));
    const form = new FormData();
    form.append("files", new Blob([csv], { type: "text/csv" }), "qa-cycle.csv");
    form.append("decisions", JSON.stringify(decisions));
    const query = new URLSearchParams({
      mode: "commit",
      source: "CSV_GENERIC",
    });
    if (periodLabel !== undefined) query.set("periodLabel", periodLabel);
    const response = await fetch(
      `${url}/projects/${ID.project}/credit-cards/${ID.card}/import-statement?${query}`,
      { method: "POST", body: form },
    );
    return {
      status: response.status,
      body: (await response.json()) as CommitResult,
    };
  }

  async function imported(rows = ALL_ROWS) {
    const result = await upload(rows);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      inserted: rows.length,
      duplicated: 0,
      skipped: 0,
      settled: 0,
      linked: 0,
    });
    return result.body;
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      now: CLOCK,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    await setup.$connect();
    await prisma.onModuleInit();
    const module = await Test.createTestingModule({
      controllers: [CreditCardController],
      providers: [{ provide: CreditCardService, useValue: cards }],
    }).compile();
    app = module.createNestApplication();
    app.use(
      (
        request: Request & { user?: typeof ACTOR },
        _response: Response,
        next: NextFunction,
      ) => {
        request.user = ACTOR;
        next();
      },
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
  });

  beforeEach(async () => {
    failCashWrite = false;
    rejectedCashWrites = 0;
    await cleanup();
    await setup.tenant.create({
      data: { id: ID.tenant, name: "Synthetic cycle QA" },
    });
    await setup.project.create({
      data: {
        id: ID.project,
        tenantId: ID.tenant,
        type: "PESSOAL",
        name: "QA cycle project",
      },
    });
    await setup.user.create({
      data: {
        id: ID.user,
        tenantId: ID.tenant,
        username: "qa701-cycle",
        name: "Synthetic QA actor",
        role: ACTOR.role,
        allowedProjects: JSON.stringify(ACTOR.allowedProjects),
        allowedProjectTypes: JSON.stringify(ACTOR.allowedProjectTypes),
        allowedModules: JSON.stringify(ACTOR.allowedModules),
      },
    });
    await setup.creditCard.create({
      data: {
        id: ID.card,
        tenantId: ID.tenant,
        projectId: ID.project,
        institution: "OUTROS",
        nickname: "QA card",
        last4: "0701",
        closingDay: 20,
        dueDay: 10,
        limitTotalCents: 50000,
      },
    });
    await setup.bankAccount.create({
      data: {
        id: ID.account,
        tenantId: ID.tenant,
        projectId: ID.project,
        institution: "OUTROS",
        nickname: "QA bank",
        last4: "0702",
        openingBalanceCents: 90000,
        openingBalanceDate: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
      await cleanup();
    } finally {
      await prisma.onModuleDestroy();
      await setup.$disconnect();
      jest.useRealTimers();
    }
  });

  it.each([
    { name: "credits from two original months", rows: CREDITS, net: -328 },
    { name: "a positive purchase", rows: [PURCHASE], net: 12345 },
    { name: "purchase minus both credits", rows: ALL_ROWS, net: 12017 },
    {
      name: "one positive cent",
      rows: ["2026-07-14,QA ONE CENT,0.01"],
      net: 1,
    },
    {
      name: "one negative cent",
      rows: ["2026-07-14,QA CENT REBATE,-0.01"],
      net: -1,
    },
    {
      name: "credits without configured card days",
      rows: CREDITS,
      net: -328,
      noDays: true,
    },
    {
      name: "mixed signs without configured card days",
      rows: ALL_ROWS,
      net: 12017,
      noDays: true,
    },
  ])(
    "$name: November only, not derived cycles",
    async ({ rows, net, noDays }) => {
      if (noDays) {
        await setup.creditCard.update({
          where: { id: ID.card },
          data: { closingDay: null, dueDay: null },
        });
      }
      await imported(rows);
      const result = await monthly.getCardInvoicesYearly(
        ID.tenant,
        ID.project,
        2026,
        ACTOR,
      );
      expect(
        result.months.map(({ mes, total, porOrigem }) => ({
          mes,
          total,
          card: porOrigem["card:0701"],
        })),
      ).toEqual(
        Array.from({ length: 12 }, (_, index) => ({
          mes: `2026-${String(index + 1).padStart(2, "0")}`,
          total: index === 10 ? net : 0,
          card: index === 10 ? net : 0,
        })),
      );
      expect(result.totalAno).toBe(net);
      expect(result.transferenciasAno).toBe(0);
    },
  );

  it("periodLabel alone is not documentary evidence", async () => {
    const result = await upload(
      ALL_ROWS,
      { documentaryCycle: undefined },
      "2026-11",
    );
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ inserted: 3, periodLabel: "2026-11" });
    const annual = await monthly.getCardInvoicesYearly(
      ID.tenant,
      ID.project,
      2026,
      ACTOR,
    );
    expect(
      annual.months
        .filter(({ total }) => total !== 0)
        .map(({ mes, total }) => ({
          mes,
          total,
        })),
    ).toEqual([
      { mes: "2026-08", total: 12345 },
      { mes: "2026-09", total: -7 },
      { mes: "2026-10", total: -321 },
    ]);
    expect(annual.totalAno).toBe(12017);
  });

  describe.each([
    { sign: "positive", row: PURCHASE },
    { sign: "negative", row: CREDITS[0] },
  ])("$sign documentary input validation", ({ row }) => {
    it.each(["", "2026-00", "2026-13", "2026-11-01", null])(
      "rejects invalid month %p without financial writes",
      async (invoiceDueMonth) => {
        const before = await financialState();
        const result = await upload([row], {
          documentaryCycle: { ...CYCLE, invoiceDueMonth },
        });
        expect([201, 400, 422]).toContain(result.status);
        if (result.status === 201) {
          expect(result.body).toMatchObject({
            inserted: 0,
            skipped: 1,
            settled: 0,
            linked: 0,
          });
        }
        expect(await financialState()).toEqual(before);
      },
    );
  });

  it("does not infer exceptional cycles for future printed installments", async () => {
    await imported(["2026-07-14,QA SERIAL MAPLE 2/3,123.45"]);
    const source = await setup.expense.findFirstOrThrow({
      where: { tenantId: ID.tenant },
      include: { cashFlow: { orderBy: { data: "asc" } } },
    });
    expect(source.valorTotal).toBe(24690);
    expect(
      source.cashFlow.map(({ valor, data, parcela, status }) => ({
        valor,
        data,
        parcela,
        status,
      })),
    ).toEqual([
      {
        valor: 12345,
        data: new Date("2026-07-14T00:00:00.000Z"),
        parcela: "2/3",
        status: "PLANEJADO",
      },
      {
        valor: 12345,
        data: new Date("2026-08-14T00:00:00.000Z"),
        parcela: "3/3",
        status: "PLANEJADO",
      },
    ]);
    const annual = await monthly.getCardInvoicesYearly(
      ID.tenant,
      ID.project,
      2026,
      ACTOR,
    );
    expect(
      annual.months
        .filter(({ total }) => total !== 0)
        .map(({ mes, total }) => ({
          mes,
          total,
        })),
    ).toEqual([
      { mes: "2026-09", total: 12345 },
      { mes: "2026-11", total: 12345 },
    ]);
    expect(annual.totalAno).toBe(24690);
  });

  it("preserves signed cents, original Expense/CFE dates and statuses", async () => {
    const result = await imported();
    const expenses = await setup.expense.findMany({
      where: { tenantId: ID.tenant },
      include: { cashFlow: true },
      orderBy: { dataPagamento: "asc" },
    });
    expect(
      expenses.map((expense) => ({
        valor: expense.valor,
        total: expense.valorTotal,
        data: expense.dataPagamento?.toISOString(),
        status: expense.status,
        card: expense.cardLast4,
        bank: expense.bankLast4,
        account: expense.accountId,
        importId: expense.importId,
        cash: expense.cashFlow.map((entry) => ({
          expenseId: entry.expenseId,
          valor: entry.valor,
          data: entry.data.toISOString(),
          status: entry.status,
          payment: entry.formaPagamento,
          parcela: entry.parcela,
        })),
      })),
    ).toEqual(
      [
        { amount: 12345, date: "2026-07-14", status: "PLANEJADO" },
        { amount: -7, date: "2026-08-14", status: "PAGO" },
        { amount: -321, date: "2026-09-14", status: "PAGO" },
      ].map(({ amount, date, status }, index) => ({
        valor: amount,
        total: amount,
        data: `${date}T00:00:00.000Z`,
        status,
        card: "0701",
        bank: null,
        account: null,
        importId: result.importId,
        cash: [
          {
            expenseId: expenses[index].id,
            valor: amount,
            data: `${date}T00:00:00.000Z`,
            status,
            payment: "CARTAO_CREDITO",
            parcela: null,
          },
        ],
      })),
    );
  });

  it("account view uses 12017 net in November and zero in every old cycle", async () => {
    await imported();
    const views = await Promise.all(
      ["2026-08", "2026-09", "2026-10", "2026-11"].map((month) =>
        monthly.getAccountView(ID.tenant, ID.project, month, ACTOR),
      ),
    );
    expect(
      views.map((view) => ({
        month: view.mesSelecionado,
        invoices: view.cartoes.map((card) => ({
          total: card.faturaAtual,
          paid: card.faturaPaga,
          adjustment: card.ajusteManualTotal,
        })),
        bankBalance: view.caixaHoje,
      })),
    ).toEqual(
      ["2026-08", "2026-09", "2026-10", "2026-11"].map((month) => ({
        month,
        invoices: [
          { total: month === "2026-11" ? 12017 : 0, paid: 0, adjustment: 0 },
        ],
        bankBalance: 90000,
      })),
    );
  });

  it.each(["card", "all"])(
    "origin reader (%s) reports November without changing dates",
    async (kind) => {
      await imported();
      const result = await monthly.getOriginItemsYearly(
        ID.tenant,
        ID.project,
        { year: 2026, kind, last4: "0701" },
        ACTOR,
      );
      expect(
        result.items
          .map(({ mes, data, valor, status }) => ({
            mes,
            data,
            valor,
            status,
          }))
          .sort((a, b) => a.valor - b.valor),
      ).toEqual([
        {
          mes: "2026-11",
          data: "2026-09-14T00:00:00.000Z",
          valor: -321,
          status: "PAGO",
        },
        {
          mes: "2026-11",
          data: "2026-08-14T00:00:00.000Z",
          valor: -7,
          status: "PAGO",
        },
        {
          mes: "2026-11",
          data: "2026-07-14T00:00:00.000Z",
          valor: 12345,
          status: "PLANEJADO",
        },
      ]);
      expect(result.total).toBe(12017);
    },
  );

  it("open invoice and computed limit consume the documented signed total", async () => {
    await imported();
    const [open, limits] = await Promise.all([
      cards.listOpenInvoices(ID.tenant, ID.project),
      cards.listCards(ID.tenant, ID.project),
    ]);
    expect({ open, limits }).toMatchObject({
      open: [
        {
          id: ID.card,
          openInvoiceMonth: "2026-11",
          openInvoiceUsedCents: 12017,
        },
      ],
      limits: [
        {
          id: ID.card,
          currentOpenInvoiceMonth: "2026-11",
          limitUsedCents: 12017,
          limitAvailableComputedCents: 37983,
        },
      ],
    });
  });

  it("Maria reads the same November debt without inventing bank funding", async () => {
    await imported();
    expect(
      await maria.execute(
        "get_account_balances",
        {
          ...ACTOR,
          userId: ID.user,
          projectScope: [ID.project],
        },
        {},
      ),
    ).toMatchObject({
      contas: [{ saldoCentavos: 90000 }],
      cartoes: [{ faturaAbertaCentavos: 12017 }],
      totais: {
        saldoBancarioTotalCentavos: 90000,
        dividaCartoesTotalCentavos: 12017,
        patrimonioParcialCentavos: 77983,
      },
    });
  });

  it("cash projection uses the signed November obligation, not purchase dates", async () => {
    await imported();
    const overview = await monthly.getOverview(
      ID.tenant,
      ID.project,
      "2026-11",
      ACTOR,
    );
    expect(overview.projecao).toMatchObject({
      mes: "2026-11",
      caixaHoje: 90000,
      saiuMes: 0,
      faltaPagarMes: 12017,
      saidaTotal: 12017,
      sobraPrevista: 77983,
    });
  });

  it("bank candidate SQL window includes old purchases documented in November", async () => {
    await imported();
    const before = await financialState();
    const candidates = await banks.loadCardsWithEntries(
      ID.tenant,
      new Date("2026-10-01T00:00:00.000Z"),
      new Date("2026-12-31T00:00:00.000Z"),
      ACTOR,
    );
    expect(rankCardCandidates(candidates, 12017, CLOCK)).toEqual([
      {
        cardLast4: "0701",
        nickname: "QA card",
        dueMonth: "2026-11",
        invoiceTotalCents: 12017,
        deltaCents: 0,
        windowState: "WITHIN_SETTLEMENT_WINDOW",
      },
    ]);
    expect(await financialState()).toEqual(before);
  });

  it.each([
    { amount: 12017, matches: true },
    { amount: 12345, matches: false },
  ])(
    "settlement preflight matches $amount against net obligation, without funding",
    async ({ amount, matches }) => {
      // A coincidentally matching import-batch total must not prove cycle matching.
      await imported([PURCHASE]);
      await imported(CREDITS);
      const before = await financialState();
      const purchase = before.expenses.find(
        ({ valorTotal }) => valorTotal === 12345,
      )!;
      const purchaseEntry = before.cash.find(
        ({ expenseId }) => expenseId === purchase.id,
      )!;
      const card = await prisma.creditCard.findUniqueOrThrow({
        where: { id: ID.card },
      });
      const prepared = await prisma.$transaction((tx) =>
        settlement.prepareSettleInvoice({
          tenantId: ID.tenant,
          card,
          amountCents: amount,
          paymentDate: CLOCK,
          tx,
          requester: ACTOR,
        }),
      );
      expect(
        prepared.purchases.map(({ expense, entries }) => ({
          id: expense.id,
          entries: entries.map(({ id, valor, data, status }) => ({
            id,
            valor,
            data,
            status,
          })),
        })),
      ).toEqual(
        matches
          ? [
              {
                id: purchase.id,
                entries: [
                  {
                    id: purchaseEntry.id,
                    valor: 12345,
                    data: new Date("2026-07-14T00:00:00.000Z"),
                    status: "PLANEJADO",
                  },
                ],
              },
            ]
          : [],
      );
      expect(await financialState()).toEqual(before);
    },
  );

  it("metadata edits and subsequent reimport preserve financial rows and November", async () => {
    await imported();
    const before = await financialState();
    for (const expense of before.expenses) {
      await expenses.update(
        ID.tenant,
        ID.project,
        expense.id,
        {
          titulo: "QA verified title",
          fornecedor: "QA verified supplier",
        },
        ACTOR,
      );
    }
    const edited = await financialState();
    expect(edited.expenses).toEqual(
      before.expenses.map((expense) => ({
        ...expense,
        titulo: "QA verified title",
        fornecedor: "QA verified supplier",
        updatedAt: expect.any(Date),
      })),
    );
    expect({ ...edited, expenses: [] }).toEqual({ ...before, expenses: [] });
    const replay = await upload();
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ inserted: 0, duplicated: 3 });
    expect(await financialState()).toEqual(edited);
    const annual = await monthly.getCardInvoicesYearly(
      ID.tenant,
      ID.project,
      2026,
      ACTOR,
    );
    expect(
      annual.months
        .filter(({ total }) => total !== 0)
        .map(({ mes, total }) => ({
          mes,
          total,
        })),
    ).toEqual([{ mes: "2026-11", total: 12017 }]);
  });

  it.each([
    { sign: "positive", row: PURCHASE },
    { sign: "negative", row: CREDITS[0] },
  ])(
    "rolls back the $sign Expense when its CFE write fails",
    async ({ row }) => {
      const before = await financialState();
      failCashWrite = true;
      const result = await upload([row]);
      expect(rejectedCashWrites).toBe(1);
      expect([201, 500]).toContain(result.status);
      if (result.status === 201) {
        expect(result.body).toMatchObject({
          inserted: 0,
          skipped: 1,
          settled: 0,
          linked: 0,
        });
      }
      expect(await financialState()).toEqual(before);
    },
  );

  it("creates no payment/settlement/funding and reimports zero financial rows", async () => {
    const before = await financialState();
    await imported();
    const after = await financialState();
    expect(after.expenses).toHaveLength(3);
    expect(after.cash).toHaveLength(3);
    expect(after.expenses).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({
          bankLast4: null,
          accountId: null,
          settlesInvoiceKey: null,
          invoiceUndoState: null,
          settledByExpenseId: null,
          plannedExpenseId: null,
          tipoDespesa: expect.not.stringMatching(/^PAGAMENTO_FATURA_CARTAO$/),
        }),
      ),
    );
    expect({ ...after, expenses: [], cash: [] }).toEqual(before);
    const replay = await upload();
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({
      inserted: 0,
      duplicated: 3,
      settled: 0,
      linked: 0,
      skipped: 0,
    });
    expect(replay.body.duplicatedItems).toHaveLength(3);
    expect(await financialState()).toEqual(after);
  });

  it("zero override is not made valid by documentary evidence", async () => {
    const before = await financialState();
    const result = await upload([PURCHASE], { valorCents: 0 });
    // Existing importer reports invalid rows as skipped; a fail-fast 4xx is also safe.
    expect([201, 400, 422]).toContain(result.status);
    if (result.status === 201) {
      expect(result.body).toMatchObject({
        inserted: 0,
        settled: 0,
        linked: 0,
        skipped: 1,
      });
    }
    expect(await financialState()).toEqual(before);
  });

  it.each([
    { name: "documentary cycle alone", overrides: {} },
    { name: "renamed merchant", overrides: { titulo: "QA REBATE RENAMED" } },
    { name: "positive override", overrides: { valorCents: 12345 } },
    {
      name: "renamed and positive",
      overrides: { titulo: "QA REBATE RENAMED", valorCents: 12345 },
    },
  ])(
    "cannot bypass payment-line filtering via $name",
    async ({ overrides }) => {
      const before = await financialState();
      const result = await upload(
        ["2026-09-14,PAGAMENTO EFETUADO,-123.45"],
        overrides,
      );
      expect([201, 400, 422]).toContain(result.status);
      if (result.status === 201) {
        expect(result.body).toMatchObject({
          inserted: 0,
          settled: 0,
          linked: 0,
        });
      }
      expect(await financialState()).toEqual(before);
    },
  );
});
