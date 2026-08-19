import { AgentToolsService, type ToolContext } from "./agent-tools.service";
import { AgentService } from "../agent.service";
import type { LlmProvider } from "../llm/llm.types";

type Row = Record<string, any>;

const TENANT_ID = "tenant-scope";
const ALLOWED_PROJECT_ID = "project-allowed";
const HIDDEN_PROJECT_ID = "project-hidden";

const projects: Row[] = [
  {
    id: ALLOWED_PROJECT_ID,
    tenantId: TENANT_ID,
    deletedAt: null,
    name: "Projeto permitido",
    type: "PESSOAL",
  },
  {
    id: HIDDEN_PROJECT_ID,
    tenantId: TENANT_ID,
    deletedAt: null,
    name: "Projeto oculto",
    type: "PESSOAL",
  },
  {
    id: "maintenance-hidden",
    tenantId: TENANT_ID,
    deletedAt: null,
    name: "Carro oculto",
    type: "CARRO",
  },
];

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Date)
    return actual instanceof Date && actual.getTime() === expected.getTime();
  if (expected === null || typeof expected !== "object")
    return actual === expected;

  const condition = expected as Record<string, unknown>;
  if (
    "in" in condition &&
    !((condition.in as unknown[]) ?? []).includes(actual)
  )
    return false;
  if ("equals" in condition && actual !== condition.equals) return false;
  if ("not" in condition && matchesValue(actual, condition.not)) return false;

  const operatorKeys = new Set(["in", "equals", "not"]);
  const nestedEntries = Object.entries(condition).filter(
    ([key]) => !operatorKeys.has(key),
  );
  if (nestedEntries.length === 0) return true;
  if (actual === null || typeof actual !== "object") return false;
  return nestedEntries.every(([key, value]) =>
    matchesValue((actual as Record<string, unknown>)[key], value),
  );
}

function matchesWhere(row: Row, where: Record<string, any> = {}): boolean {
  if (where.AND) {
    const clauses = Array.isArray(where.AND) ? where.AND : [where.AND];
    if (
      !clauses.every((clause: Record<string, any>) => matchesWhere(row, clause))
    )
      return false;
  }
  if (where.OR) {
    const clauses = Array.isArray(where.OR) ? where.OR : [where.OR];
    if (
      !clauses.some((clause: Record<string, any>) => matchesWhere(row, clause))
    )
      return false;
  }

  return Object.entries(where)
    .filter(([key]) => key !== "AND" && key !== "OR")
    .every(([key, expected]) => matchesValue(row[key], expected));
}

function scopedRow(row: Row): Row {
  return {
    ...row,
    project: projects.find((project) => project.id === row.projectId),
  };
}

function buildHarness() {
  const cards = [
    scopedRow({
      id: "card-hidden",
      tenantId: TENANT_ID,
      deletedAt: null,
      projectId: HIDDEN_PROJECT_ID,
    }),
  ];
  const accounts = [
    scopedRow({
      id: "account-hidden",
      tenantId: TENANT_ID,
      deletedAt: null,
      projectId: HIDDEN_PROJECT_ID,
    }),
  ];
  const expenseRows = [
    scopedRow({
      id: "linked-hidden",
      tenantId: TENANT_ID,
      deletedAt: null,
      projectId: HIDDEN_PROJECT_ID,
      formaPagamento: "A_VISTA",
    }),
    scopedRow({
      id: "update-hidden",
      tenantId: TENANT_ID,
      deletedAt: null,
      projectId: HIDDEN_PROJECT_ID,
      formaPagamento: "A_VISTA",
    }),
    scopedRow({
      id: "update-allowed",
      tenantId: TENANT_ID,
      deletedAt: null,
      projectId: ALLOWED_PROJECT_ID,
      formaPagamento: "A_VISTA",
    }),
  ];

  const findFirst = (rows: Row[]) =>
    jest.fn(
      async ({ where }: { where: Record<string, any> }) =>
        rows.find((row) => matchesWhere(row, where)) ?? null,
    );
  const findMany = (rows: Row[]) =>
    jest.fn(async ({ where }: { where: Record<string, any> }) =>
      rows.filter((row) => matchesWhere(row, where)),
    );

  const prisma: any = {
    project: {
      findFirst: findFirst(projects),
      findMany: findMany(projects),
    },
    creditCard: {
      findFirst: findFirst(cards),
      findMany: findMany(cards),
    },
    bankAccount: {
      findFirst: findFirst(accounts),
      findMany: findMany(accounts),
    },
    expense: {
      findFirst: findFirst(expenseRows),
      findMany: findMany(expenseRows),
    },
    maintenanceLog: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const expenses: any = {
    create: jest.fn().mockResolvedValue({
      id: "created-expense",
      titulo: "Mercado",
      fornecedor: null,
      valorTotal: 1000,
    }),
    createRecorrente: jest.fn(),
    update: jest.fn().mockResolvedValue({
      id: "update-allowed",
      tipoDespesa: "ALIMENTACAO",
      titulo: "Mercado atualizado",
      fornecedor: null,
      valorTotal: 1000,
    }),
  };
  const receipts: any = {
    create: jest.fn(),
  };
  const priceMonitor: any = {
    createItem: jest.fn(),
    refreshItem: jest.fn(),
    listByProjects: jest.fn().mockResolvedValue([]),
  };
  const service = new AgentToolsService(
    prisma,
    {} as any,
    expenses,
    receipts,
    {} as any,
    {} as any,
    { classifyBatch: jest.fn() } as any,
    priceMonitor,
  );
  const mutations = [
    expenses.create,
    expenses.createRecorrente,
    expenses.update,
    receipts.create,
    priceMonitor.createItem,
    priceMonitor.refreshItem,
  ];

  return { service, prisma, expenses, mutations };
}

function expectNoMutations(mutations: jest.Mock[]): void {
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
}

function containsProjectScope(where: unknown, projectIds: string[]): boolean {
  if (!where || typeof where !== "object") return false;
  const record = where as Record<string, unknown>;
  const direct = record.projectId as Record<string, unknown> | undefined;
  if (
    direct &&
    Array.isArray(direct.in) &&
    JSON.stringify(direct.in) === JSON.stringify(projectIds)
  ) {
    return true;
  }
  const relation = record.project as Record<string, unknown> | undefined;
  if (relation && containsProjectScope(relation, projectIds)) return true;
  return Object.values(record).some((value) => {
    if (Array.isArray(value))
      return value.some((item) => containsProjectScope(item, projectIds));
    return containsProjectScope(value, projectIds);
  });
}

describe("AgentService — normalização fail-closed de projectScope (SEC-1)", () => {
  function buildAgent() {
    const llm: LlmProvider = {
      id: "mock",
      isConfigured: () => true,
      chat: jest
        .fn()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            {
              id: "scope-call",
              name: "get_financial_overview",
              arguments: {},
            },
          ],
        })
        .mockResolvedValueOnce({ content: "ok", toolCalls: [] }),
    };
    const tools = {
      getToolDefs: jest.fn().mockReturnValue([]),
      buildPrimer: jest.fn().mockResolvedValue(""),
      execute: jest.fn().mockResolvedValue({}),
    } as unknown as AgentToolsService;
    return { service: new AgentService(llm, tools), tools };
  }

  it.each<[string, string[] | null | undefined, string[]]>([
    ["undefined", undefined, []],
    ["null", null, []],
    ["lista vazia", [], []],
  ])(
    "normaliza projectScope %s de USER para [] no primer e nas ferramentas",
    async (_label, projectScope, expectedScope) => {
      const { service, tools } = buildAgent();

      await service.chat({
        tenantId: TENANT_ID,
        role: "USER",
        projectScope,
        messages: [{ role: "user", content: "Resumo" }],
      });

      expect(tools.buildPrimer).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          role: "USER",
          projectScope: expectedScope,
        }),
      );
      expect(tools.execute).toHaveBeenCalledWith(
        "get_financial_overview",
        expect.objectContaining({
          tenantId: TENANT_ID,
          role: "USER",
          projectScope: expectedScope,
        }),
        {},
      );
    },
  );

  it("preserva projectScope null de OWNER no primer e nas ferramentas", async () => {
    const { service, tools } = buildAgent();

    await service.chat({
      tenantId: TENANT_ID,
      role: "OWNER",
      projectScope: null,
      messages: [{ role: "user", content: "Resumo" }],
    });

    expect(tools.buildPrimer).toHaveBeenCalledWith(
      expect.objectContaining({ role: "OWNER", projectScope: null }),
    );
    expect(tools.execute).toHaveBeenCalledWith(
      "get_financial_overview",
      expect.objectContaining({ role: "OWNER", projectScope: null }),
      {},
    );
  });
});

describe("AgentToolsService — projectScope fail-closed (SEC-1)", () => {
  const createArgs = {
    projectId: ALLOWED_PROJECT_ID,
    valor: "10,00",
    tipoDespesa: "ALIMENTACAO",
    titulo: "Mercado",
  };

  it.each<
    [string, { role: string; projectScope: string[] | null | undefined }]
  >([
    ["USER com []", { role: "USER", projectScope: [] }],
    ["USER com undefined", { role: "USER", projectScope: undefined }],
    ["USER com null", { role: "USER", projectScope: null }],
    ["OWNER com [] explícito", { role: "OWNER", projectScope: [] }],
  ])(
    "%s não pode escrever e é indistinguível de projeto ausente",
    async (_label, scope) => {
      const { service, mutations } = buildHarness();
      const ctx: ToolContext = {
        tenantId: TENANT_ID,
        allowedModules: ["expenses"],
        ...scope,
      };

      const denied = await service.execute("create_expense", ctx, createArgs);
      const missing = await service.execute("create_expense", ctx, {
        ...createArgs,
        projectId: "project-missing",
      });

      expect(denied).toEqual(missing);
      expectNoMutations(mutations);
    },
  );

  it.each<[string, { role: string; projectScope: string[] | null }]>([
    [
      "USER com projeto exato",
      { role: "USER", projectScope: [ALLOWED_PROJECT_ID] },
    ],
    ["OWNER irrestrito", { role: "OWNER", projectScope: null }],
  ])("%s pode escrever", async (_label, scope) => {
    const { service, expenses } = buildHarness();

    const result: any = await service.execute(
      "create_expense",
      {
        tenantId: TENANT_ID,
        allowedModules: ["expenses"],
        ...scope,
      },
      createArgs,
    );

    expect(result.ok).toBe(true);
    expect(result.despesa.id).toBe("created-expense");
    expect(expenses.create).toHaveBeenCalledTimes(1);
  });

  it("USER autorizado repassa allowedProjects não vazio à mutação", async () => {
    const { service, expenses } = buildHarness();

    const result: any = await service.execute(
      "update_expense",
      {
        tenantId: TENANT_ID,
        role: "USER",
        projectScope: [ALLOWED_PROJECT_ID],
        allowedModules: ["expenses"],
      },
      { expenseId: "update-allowed", titulo: "Mercado atualizado" },
    );

    expect(result.ok).toBe(true);
    expect(expenses.update).toHaveBeenCalledTimes(1);
    expect(expenses.update).toHaveBeenCalledWith(
      TENANT_ID,
      ALLOWED_PROJECT_ID,
      "update-allowed",
      { titulo: "Mercado atualizado" },
      expect.objectContaining({
        role: "USER",
        allowedProjects: [ALLOWED_PROJECT_ID],
      }),
    );
    expect(JSON.stringify(expenses.update.mock.calls)).not.toContain(
      '"allowedProjects":[]',
    );
  });

  it("projeto explícito oculto e ausente são idênticos no helper de manutenção", async () => {
    const { service, prisma, mutations } = buildHarness();
    const ctx: ToolContext = {
      tenantId: TENANT_ID,
      role: "USER",
      projectScope: [ALLOWED_PROJECT_ID],
    };

    const hidden = await service.execute("get_maintenance_status", ctx, {
      projectId: "maintenance-hidden",
    });
    const missing = await service.execute("get_maintenance_status", ctx, {
      projectId: "maintenance-missing",
    });

    expect(hidden).toEqual(missing);
    expect(prisma.maintenanceLog.findFirst).not.toHaveBeenCalled();
    expectNoMutations(mutations);
  });

  it.each([
    ["cartão", "creditCardId", "card-hidden", "card-missing"],
    ["conta", "bankAccountId", "account-hidden", "account-missing"],
    ["despesa vinculada", "linkedExpenseId", "linked-hidden", "linked-missing"],
  ])(
    "%s oculto e ausente são idênticos e não escrevem",
    async (_label, field, hiddenId, missingId) => {
      const { service, mutations } = buildHarness();
      const ctx: ToolContext = {
        tenantId: TENANT_ID,
        role: "USER",
        projectScope: [ALLOWED_PROJECT_ID],
        allowedModules: ["expenses"],
      };

      const hidden = await service.execute("create_expense", ctx, {
        ...createArgs,
        [field]: hiddenId,
      });
      const missing = await service.execute("create_expense", ctx, {
        ...createArgs,
        [field]: missingId,
      });

      expect(hidden).toEqual(missing);
      expectNoMutations(mutations);
    },
  );

  it("update_expense filtra a consulta inicial pelo escopo e oculta existência", async () => {
    const { service, prisma, mutations } = buildHarness();
    const ctx: ToolContext = {
      tenantId: TENANT_ID,
      role: "USER",
      projectScope: [ALLOWED_PROJECT_ID],
      allowedModules: ["expenses"],
    };

    const hidden = await service.execute("update_expense", ctx, {
      expenseId: "update-hidden",
      titulo: "Não deve alterar",
    });
    const firstWhere = prisma.expense.findFirst.mock.calls[0][0].where;
    const missing = await service.execute("update_expense", ctx, {
      expenseId: "update-missing",
      titulo: "Não deve alterar",
    });

    expect(containsProjectScope(firstWhere, [ALLOWED_PROJECT_ID])).toBe(true);
    expect(hidden).toEqual(missing);
    expectNoMutations(mutations);
  });

  it("mantém in:[] no primer e nas listas em vez de ampliar para o tenant", async () => {
    const { service, prisma } = buildHarness();
    const ctx: ToolContext = {
      tenantId: TENANT_ID,
      role: "USER",
      projectScope: [],
    };

    await service.buildPrimer(ctx);
    await service.execute("list_projects", ctx, {});
    await service.execute("list_payment_methods", ctx, {});

    expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT_ID,
      deletedAt: null,
      id: { in: [] },
    });
    expect(prisma.project.findMany.mock.calls[1][0].where).toEqual({
      tenantId: TENANT_ID,
      deletedAt: null,
      id: { in: [] },
    });
    expect(prisma.creditCard.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT_ID,
      deletedAt: null,
      projectId: { in: [] },
    });
    expect(prisma.bankAccount.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT_ID,
      deletedAt: null,
      projectId: { in: [] },
    });
  });
});
