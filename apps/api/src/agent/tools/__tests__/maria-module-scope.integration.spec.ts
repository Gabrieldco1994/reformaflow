// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../../scripts/test-db-env.cjs");

// #483 SEC-5 — prova observacional das tools financeiras da Maria com banco REAL:
// um requisitante que alcança o projeto por um módulo NÃO relacionado
// (`creditCards` numa REFORMA) tem que receber, em TODA tool financeira, o mesmo
// payload que receberia se as linhas de despesa/recebimento não existissem —
// serializado, para que nenhum `titulo`/`descricao`/valor vaze num campo aninhado.
import { PrismaClient } from "@prisma/client";
import { AgentToolsService, type ToolContext } from "../agent-tools.service";
import { TenantFinancialService } from "../../../tenant-financial/tenant-financial.service";
import { PrismaService } from "../../../prisma/prisma.service";
import * as accessRules from "../../../common/access-rules";

const CLOCK = new Date("2026-08-19T15:00:00.000Z");
const PAST = new Date("2026-08-10T12:00:00.000Z");
const FUTURE = new Date("2026-09-05T12:00:00.000Z");

const IDS = {
  tenant: "qa483-agent-tenant",
  reforma: "qa483-agent-reforma",
  paidExpense: "qa483-agent-expense-paid",
  plannedExpense: "qa483-agent-expense-planned",
  cashedReceipt: "qa483-agent-receipt-cashed",
  expectedReceipt: "qa483-agent-receipt-expected",
  card: "qa483-agent-card",
} as const;

/** Valores exatos (centavos) — as asserções são por centavo, não por "menor que antes". */
const CENTS = {
  paidExpense: 12_345,
  plannedExpense: 50_000,
  cashedReceipt: 77_777,
  expectedReceipt: 9_900,
} as const;

const EXPENSE_SENTINELS = [
  "Despesa Maria SENTINELA",
  "FORNECEDOR SENTINELA",
  "Despesa Maria planejada SENTINELA",
  String(CENTS.paidExpense),
  String(CENTS.plannedExpense),
] as const;

const RECEIPT_SENTINELS = [
  "Recebimento Maria SENTINELA",
  "Recebimento Maria previsto SENTINELA",
  String(CENTS.cashedReceipt),
  String(CENTS.expectedReceipt),
] as const;

/** Identificadores do cartão semeado — nenhum pode vazar numa ENUMERAÇÃO. */
const CARD_SENTINELS = ["Cartão QA 483", "4830", IDS.card] as const;

/** Tools de leitura financeira citadas na #483. */
const READ_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["get_financial_overview", {}],
  ["get_by_project", {}],
  ["get_expenses_by_category", {}],
  ["get_upcoming", {}],
  ["get_top_suppliers", {}],
  ["get_cashflow_history", {}],
  ["find_expenses", {}],
  [
    "update_expense",
    { expenseId: IDS.paidExpense, titulo: "não deve alterar" },
  ],
];

interface Requester {
  role: string;
  allowedProjects: string[];
  allowedProjectTypes: string[];
  allowedModules: string[];
}

/** Alcança a REFORMA só por `creditCards` — módulo NÃO dono de despesa/recebimento. */
const cardOnly: Requester = {
  role: "USER",
  allowedProjects: [IDS.reforma],
  allowedProjectTypes: ["REFORMA"],
  allowedModules: ["creditCards"],
};

const expensesOnly: Requester = {
  role: "USER",
  allowedProjects: [IDS.reforma],
  allowedProjectTypes: ["REFORMA"],
  allowedModules: ["expenses"],
};

const receiptsOnly: Requester = {
  role: "USER",
  allowedProjects: [IDS.reforma],
  allowedProjectTypes: ["REFORMA"],
  allowedModules: ["receipts"],
};

const owner: Requester = {
  role: "OWNER",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

describe("Maria — escopo por recurso nas tools financeiras (#483, banco real)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const monthly = { getCaixaConta: jest.fn(async () => ({ hoje: 0 })) } as any;
  const financial = new TenantFinancialService(prisma, monthly);
  const service = new AgentToolsService(
    prisma,
    financial,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  /** Reproduz o agent.controller: escopo AMPLO de projeto + ACL bruta no contexto. */
  async function contextFor(requester: Requester): Promise<ToolContext> {
    const projectScope = await accessRules.resolveAccessibleProjectScope(
      prisma,
      IDS.tenant,
      requester.role,
      requester.allowedProjects,
      requester.allowedProjectTypes,
      requester.allowedModules,
    );
    return {
      tenantId: IDS.tenant,
      projectId: null,
      projectScope,
      role: requester.role,
      allowedProjects: requester.allowedProjects,
      allowedProjectTypes: requester.allowedProjectTypes,
      allowedModules: requester.allowedModules,
      userId: "qa483-user",
    };
  }

  async function runTool(
    requester: Requester,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    return service.execute(tool, await contextFor(requester), args);
  }

  async function setExpensesActive(active: boolean) {
    await setup.expense.updateMany({
      where: { tenantId: IDS.tenant },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  async function setReceiptsActive(active: boolean) {
    await setup.receipt.updateMany({
      where: { tenantId: IDS.tenant },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  /** Mundo de controle: as linhas do recurso genuinamente NÃO existem. */
  async function withoutRows<T>(
    resources: Array<"expenses" | "receipts">,
    run: () => Promise<T>,
  ): Promise<T> {
    if (resources.includes("expenses")) await setExpensesActive(false);
    if (resources.includes("receipts")) await setReceiptsActive(false);
    try {
      return await run();
    } finally {
      if (resources.includes("expenses")) await setExpensesActive(true);
      if (resources.includes("receipts")) await setReceiptsActive(true);
    }
  }

  /** Mundo de controle: o CARTÃO genuinamente não existe. */
  async function withoutCard<T>(run: () => Promise<T>): Promise<T> {
    await setup.creditCard.updateMany({
      where: { tenantId: IDS.tenant },
      data: { deletedAt: CLOCK },
    });
    try {
      return await run();
    } finally {
      await setup.creditCard.updateMany({
        where: { tenantId: IDS.tenant },
        data: { deletedAt: null },
      });
    }
  }

  async function cleanupAll() {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.expense.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.receipt.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.creditCard.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.project.deleteMany({ where: { tenantId: IDS.tenant } });
    await setup.tenant.deleteMany({ where: { id: IDS.tenant } });
  }

  async function seed() {
    await setup.tenant.create({
      data: { id: IDS.tenant, name: "QA 483 agent tenant" },
    });
    await setup.project.create({
      data: {
        id: IDS.reforma,
        tenantId: IDS.tenant,
        type: "REFORMA",
        name: "Reforma QA 483",
      },
    });
    await setup.creditCard.create({
      data: {
        id: IDS.card,
        tenantId: IDS.tenant,
        projectId: IDS.reforma,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão QA 483",
        last4: "4830",
        closingDay: 5,
        dueDay: 10,
      },
    });
    await setup.expense.createMany({
      data: [
        {
          id: IDS.paidExpense,
          tenantId: IDS.tenant,
          projectId: IDS.reforma,
          tipoDespesa: "MATERIAL_CONSTRUCAO",
          titulo: "Despesa Maria SENTINELA",
          fornecedor: "FORNECEDOR SENTINELA",
          valor: CENTS.paidExpense,
          quantidade: 1,
          valorTotal: CENTS.paidExpense,
          formaPagamento: "A_VISTA",
          dataPagamento: PAST,
          status: "PAGO",
          createdAt: PAST,
          updatedAt: PAST,
        },
        {
          id: IDS.plannedExpense,
          tenantId: IDS.tenant,
          projectId: IDS.reforma,
          tipoDespesa: "MATERIAL_CONSTRUCAO",
          titulo: "Despesa Maria planejada SENTINELA",
          fornecedor: "FORNECEDOR SENTINELA",
          valor: CENTS.plannedExpense,
          quantidade: 1,
          valorTotal: CENTS.plannedExpense,
          formaPagamento: "A_VISTA",
          dataPagamento: FUTURE,
          status: "PLANEJADO",
          createdAt: PAST,
          updatedAt: PAST,
        },
      ],
    });
    await setup.receipt.createMany({
      data: [
        {
          id: IDS.cashedReceipt,
          tenantId: IDS.tenant,
          projectId: IDS.reforma,
          tipo: "PAGAMENTO",
          descricao: "Recebimento Maria SENTINELA",
          valor: CENTS.cashedReceipt,
          data: PAST,
          status: "EM_CAIXA",
          createdAt: PAST,
          updatedAt: PAST,
        },
        {
          id: IDS.expectedReceipt,
          tenantId: IDS.tenant,
          projectId: IDS.reforma,
          tipo: "PAGAMENTO",
          descricao: "Recebimento Maria previsto SENTINELA",
          valor: CENTS.expectedReceipt,
          data: FUTURE,
          status: "PREVISTO",
          createdAt: PAST,
          updatedAt: PAST,
        },
      ],
    });
    await setup.cashFlowEntry.createMany({
      data: [
        {
          id: "qa483-cf-expense-paid",
          tenantId: IDS.tenant,
          projectId: IDS.reforma,
          expenseId: IDS.paidExpense,
          valor: CENTS.paidExpense,
          tipo: "DESPESA",
          data: PAST,
          categoria: "MATERIAL_CONSTRUCAO",
          status: "PAGO",
        },
        {
          id: "qa483-cf-expense-planned",
          tenantId: IDS.tenant,
          projectId: IDS.reforma,
          expenseId: IDS.plannedExpense,
          valor: CENTS.plannedExpense,
          tipo: "DESPESA",
          data: FUTURE,
          categoria: "MATERIAL_CONSTRUCAO",
          status: "PLANEJADO",
        },
        {
          id: "qa483-cf-receipt-cashed",
          tenantId: IDS.tenant,
          projectId: IDS.reforma,
          receiptId: IDS.cashedReceipt,
          valor: CENTS.cashedReceipt,
          tipo: "RECEBIMENTO",
          data: PAST,
          categoria: "PAGAMENTO",
          status: "EM_CAIXA",
        },
        {
          id: "qa483-cf-receipt-expected",
          tenantId: IDS.tenant,
          projectId: IDS.reforma,
          receiptId: IDS.expectedReceipt,
          valor: CENTS.expectedReceipt,
          tipo: "RECEBIMENTO",
          data: FUTURE,
          categoria: "PAGAMENTO",
          status: "PREVISTO",
        },
      ],
    });
  }

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
    jest.setSystemTime(CLOCK);
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await seed();
  });

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  it.each(READ_TOOLS)(
    "%s: com só creditCards, presença e ausência das despesas são indistinguíveis",
    async (tool, args) => {
      const withRows = await runTool(cardOnly, tool, args);
      const withoutExpenses = await withoutRows(["expenses"], () =>
        runTool(cardOnly, tool, args),
      );

      expect(JSON.stringify(withRows)).toEqual(JSON.stringify(withoutExpenses));
      for (const sentinel of EXPENSE_SENTINELS) {
        expect(JSON.stringify(withRows)).not.toContain(sentinel);
      }
    },
  );

  it.each(READ_TOOLS)(
    "%s: com só creditCards, o payload é idêntico ao mundo SEM dado financeiro algum",
    async (tool, args) => {
      const withRows = await runTool(cardOnly, tool, args);
      const withoutAny = await withoutRows(["expenses", "receipts"], () =>
        runTool(cardOnly, tool, args),
      );

      expect(JSON.stringify(withRows)).toEqual(JSON.stringify(withoutAny));
      for (const sentinel of [...EXPENSE_SENTINELS, ...RECEIPT_SENTINELS]) {
        expect(JSON.stringify(withRows)).not.toContain(sentinel);
      }
    },
  );

  it("com expenses, as MESMAS tools devolvem as despesas (não é negação em bloco)", async () => {
    const categorias: any = await runTool(
      expensesOnly,
      "get_expenses_by_category",
      {},
    );
    const fornecedores: any = await runTool(
      expensesOnly,
      "get_top_suppliers",
      {},
    );
    const encontradas: any = await runTool(expensesOnly, "find_expenses", {});
    const overview: any = await runTool(
      expensesOnly,
      "get_financial_overview",
      {},
    );

    expect(categorias.categorias).toEqual([
      expect.objectContaining({
        key: "MATERIAL_CONSTRUCAO",
        total: CENTS.paidExpense + CENTS.plannedExpense,
      }),
    ]);
    expect(fornecedores.fornecedores).toEqual([
      expect.objectContaining({
        fornecedor: "FORNECEDOR SENTINELA",
        total: CENTS.paidExpense + CENTS.plannedExpense,
        count: 2,
      }),
    ]);
    expect(encontradas.despesas).toHaveLength(2);
    expect(overview.pagoTotal).toBe(CENTS.paidExpense);
    expect(overview.previsao30d).toBe(CENTS.plannedExpense);
    // Sem o módulo `receipts`, a contribuição de recebimento é exatamente zero.
    expect(overview.recebimento30d).toBe(0);
    expect(overview.recebimento90d).toBe(0);
  });

  it("agregado misto: com receipts e sem expenses, recebimento exato e despesa exatamente zero", async () => {
    const overview: any = await runTool(
      receiptsOnly,
      "get_financial_overview",
      {},
    );
    const porProjeto: any = await runTool(receiptsOnly, "get_by_project", {});
    const serie: any = await runTool(receiptsOnly, "get_cashflow_history", {});
    const categorias: any = await runTool(
      receiptsOnly,
      "get_expenses_by_category",
      {},
    );
    const proximos: any = await runTool(receiptsOnly, "get_upcoming", {});

    expect(overview.recebimento30d).toBe(CENTS.expectedReceipt);
    expect(overview.recebimento90d).toBe(CENTS.expectedReceipt);
    expect(overview.pagoTotal).toBe(0);
    expect(overview.pagoMesAtual).toBe(0);
    expect(overview.pagoYTD).toBe(0);
    expect(overview.previsao30d).toBe(0);
    expect(overview.previsao90d).toBe(0);

    expect(porProjeto.projects).toEqual([
      expect.objectContaining({
        projectId: IDS.reforma,
        gastoTotal: 0,
        planejadoRestante: 0,
        recebimentoTotal: CENTS.cashedReceipt,
        recebimentoPrevisto: CENTS.expectedReceipt,
        saldo: CENTS.cashedReceipt,
      }),
    ]);

    expect(serie.resumo.totalPago).toBe(0);
    expect(serie.resumo.totalRecebido).toBe(CENTS.cashedReceipt);
    expect(categorias.categorias).toEqual([]);
    expect(proximos.itens).toEqual([
      expect.objectContaining({
        tipo: "RECEBIMENTO",
        valor: CENTS.expectedReceipt,
      }),
    ]);

    const serialized = JSON.stringify({
      overview,
      porProjeto,
      serie,
      categorias,
      proximos,
    });
    for (const sentinel of EXPENSE_SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("OWNER mantém o comportamento same-tenant (vê despesa e recebimento)", async () => {
    const overview: any = await runTool(owner, "get_financial_overview", {});
    const porProjeto: any = await runTool(owner, "get_by_project", {});
    const categorias: any = await runTool(
      owner,
      "get_expenses_by_category",
      {},
    );

    expect(overview.pagoTotal).toBe(CENTS.paidExpense);
    expect(overview.previsao30d).toBe(CENTS.plannedExpense);
    expect(overview.recebimento30d).toBe(CENTS.expectedReceipt);
    expect(overview.totalProjetos).toBe(1);
    expect(porProjeto.projects).toEqual([
      expect.objectContaining({
        gastoTotal: CENTS.paidExpense,
        planejadoRestante: CENTS.plannedExpense,
        recebimentoTotal: CENTS.cashedReceipt,
        recebimentoPrevisto: CENTS.expectedReceipt,
      }),
    ]);
    expect(categorias.categorias).toEqual([
      expect.objectContaining({
        total: CENTS.paidExpense + CENTS.plannedExpense,
      }),
    ]);
  });

  // As duas metades ficam TRAVADAS uma na outra de propósito: quem "endurecer"
  // a escrita quebra a metade (a); quem "afrouxar" a enumeração quebra a (b).
  it("com expenses e sem creditCards: anexa o cartão NOMEADO numa despesa (a), mas nunca ENUMERA cartões (b)", async () => {
    const cardWriterOnly: Requester = {
      role: "USER",
      allowedProjects: [IDS.reforma],
      allowedProjectTypes: ["REFORMA"],
      allowedModules: ["expenses"],
    };

    // (a) ESCRITA — o módulo é o do CHAMADOR (`expenses`), igual ao
    // ExpenseController: `creditCardId` é campo da despesa, não recurso lido.
    // Maria mais restrita que a tela seria regressão funcional, não segurança.
    const writes: any = { create: jest.fn() };
    writes.create.mockResolvedValue({
      id: "qa483-expense-com-cartao",
      titulo: "Compra no cartão QA 483",
      fornecedor: null,
      valorTotal: 1_000,
      cardLast4: "4830",
    });
    const writer = new AgentToolsService(
      prisma,
      financial,
      writes,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const criada: any = await writer.execute(
      "create_expense",
      await contextFor(cardWriterOnly),
      {
        projectId: IDS.reforma,
        valor: "10,00",
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        titulo: "Compra no cartão QA 483",
        data: "2026-08-19",
        creditCardId: IDS.card,
      },
    );

    expect(criada.error).toBeUndefined();
    expect(criada.ok).toBe(true);
    expect(writes.create).toHaveBeenCalledTimes(1);
    expect(writes.create.mock.calls[0][2]).toEqual(
      expect.objectContaining({ creditCardId: IDS.card }),
    );
    expect(criada.despesa.cardLast4).toBe("4830");

    // (b) LEITURA/ENUMERAÇÃO — segue no módulo `creditCards`: listar cartões
    // revelaria a existência de cartões que o requisitante não pode conhecer.
    const meios: any = await runTool(cardWriterOnly, "list_payment_methods");
    const primer = await service.buildPrimer(await contextFor(cardWriterOnly));
    const [meiosSemCartao, primerSemCartao] = await withoutCard(async () => [
      await runTool(cardWriterOnly, "list_payment_methods"),
      await service.buildPrimer(await contextFor(cardWriterOnly)),
    ]);

    expect(meios.cartoes).toEqual([]);
    expect(JSON.stringify(meios)).toEqual(JSON.stringify(meiosSemCartao));
    expect(primer).toEqual(primerSemCartao);
    for (const sentinel of CARD_SENTINELS) {
      expect(JSON.stringify(meios)).not.toContain(sentinel);
      expect(primer).not.toContain(sentinel);
    }
  });

  it("um turno com várias tools resolve o escopo de cada módulo uma única vez", async () => {
    const ctx = await contextFor(expensesOnly);
    const resolver = jest.spyOn(accessRules, "resolveAccessibleProjectScope");

    await service.execute("get_financial_overview", ctx, {});
    await service.execute("get_by_project", ctx, {});
    await service.execute("get_top_suppliers", ctx, {});
    await service.execute("find_expenses", ctx, {});

    const modulesResolved = resolver.mock.calls.map((call) => call[6]).sort();
    expect(modulesResolved).toEqual(["expenses", "receipts"]);
    resolver.mockRestore();
  });
});
