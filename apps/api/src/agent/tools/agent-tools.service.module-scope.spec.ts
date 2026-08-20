// #483 SEC-5 — as tools financeiras da Maria resolviam UM escopo amplo de projeto
// (o mesmo `projectScope` para todas) e liam despesa/recebimento/cartão sem
// perguntar quem é o DONO do recurso. Este spec fixa o contrato do acessor:
//   - cada leitura pede a lente do SEU módulo (`ctx.scopeFor(<módulo>)`);
//   - agregado misto recebe as duas lentes, nunca um gate único;
//   - a lente é memoizada por turno (uma resolução por módulo, mesmo com N tools).
import * as accessRules from "../../common/access-rules";
import { AgentToolsService, type ToolContext } from "./agent-tools.service";

const TENANT = "tenant-483";
const REFORMA = "project-483-reforma";
const PESSOAL = "project-483-pessoal";

type Row = Record<string, any>;

const projects: Row[] = [
  {
    id: REFORMA,
    tenantId: TENANT,
    deletedAt: null,
    name: "Reforma 483",
    type: "REFORMA",
  },
  {
    id: PESSOAL,
    tenantId: TENANT,
    deletedAt: null,
    name: "Pessoal 483",
    type: "PESSOAL",
  },
];

function matchesWhere(row: Row, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === "object" && "in" in expected) {
      return (expected.in as unknown[]).includes(row[key]);
    }
    return row[key] === expected;
  });
}

function buildHarness() {
  const prisma: any = {
    project: {
      findMany: jest.fn(async ({ where }: { where: Record<string, any> }) =>
        projects.filter((project) => matchesWhere(project, where)),
      ),
    },
    creditCard: { findMany: jest.fn(async () => []) },
    bankAccount: { findMany: jest.fn(async () => []) },
    expense: { findMany: jest.fn(async () => []) },
  };
  const financial: any = {
    getOverview: jest.fn(async () => ({ totalProjetos: 0 })),
    getByProject: jest.fn(async () => []),
    getByCategory: jest.fn(async () => []),
    getUpcoming: jest.fn(async () => []),
    getTopSuppliers: jest.fn(async () => []),
    getCashFlow: jest.fn(async () => []),
  };
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
  return { service, prisma, financial };
}

/** Requisitante que alcança a REFORMA por um módulo NÃO relacionado. */
const cardOnlyCtx = (): ToolContext => ({
  tenantId: TENANT,
  role: "USER",
  projectScope: [REFORMA],
  allowedProjects: [REFORMA],
  allowedProjectTypes: ["REFORMA"],
  allowedModules: ["creditCards"],
});

const expenseOnlyCtx = (): ToolContext => ({
  tenantId: TENANT,
  role: "USER",
  projectScope: [REFORMA],
  allowedProjects: [REFORMA],
  allowedProjectTypes: ["REFORMA"],
  allowedModules: ["expenses"],
});

const ownerCtx = (): ToolContext => ({
  tenantId: TENANT,
  role: "OWNER",
  projectScope: null,
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
});

/** [tool, método agregador, índice do argumento de escopo]. */
const AGGREGATE_TOOLS: Array<[string, string, number]> = [
  ["get_financial_overview", "getOverview", 1],
  ["get_by_project", "getByProject", 1],
  ["get_expenses_by_category", "getByCategory", 1],
  ["get_upcoming", "getUpcoming", 2],
  ["get_top_suppliers", "getTopSuppliers", 2],
  ["get_cashflow_history", "getCashFlow", 2],
];

describe("AgentToolsService — escopo por RECURSO nas tools financeiras (#483)", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(AGGREGATE_TOOLS)(
    "%s: requisitante só com creditCards recebe lente vazia de despesa E de recebimento",
    async (tool, method, scopeArg) => {
      const { service, financial } = buildHarness();

      await service.execute(tool, cardOnlyCtx(), {});

      expect(financial[method]).toHaveBeenCalledTimes(1);
      expect(financial[method].mock.calls[0][scopeArg]).toEqual({
        expenses: [],
        receipts: [],
      });
    },
  );

  it.each(AGGREGATE_TOOLS)(
    "%s: requisitante com expenses recebe a lente do projeto só para despesa",
    async (tool, method, scopeArg) => {
      const { service, financial } = buildHarness();

      await service.execute(tool, expenseOnlyCtx(), {});

      expect(financial[method].mock.calls[0][scopeArg]).toEqual({
        expenses: [REFORMA],
        receipts: [],
      });
    },
  );

  it.each(AGGREGATE_TOOLS)(
    "%s: OWNER segue irrestrito no tenant (lentes null)",
    async (tool, method, scopeArg) => {
      const { service, financial } = buildHarness();

      await service.execute(tool, ownerCtx(), {});

      expect(financial[method].mock.calls[0][scopeArg]).toEqual({
        expenses: null,
        receipts: null,
      });
    },
  );

  it("um módulo não relacionado do MESMO tipo não concede o recurso (SEC-1)", async () => {
    const { service, financial } = buildHarness();
    // REFORMA suporta expenses, receipts E creditCards: possuir creditCards não
    // pode, sozinho, liberar despesa nem recebimento do mesmo projeto.
    await service.execute("get_financial_overview", cardOnlyCtx(), {});

    expect(financial.getOverview.mock.calls[0][1]).toEqual({
      expenses: [],
      receipts: [],
    });
  });

  it("memoiza a lente por módulo: um turno com várias tools resolve cada módulo uma vez", async () => {
    const { service, prisma } = buildHarness();
    const resolver = jest.spyOn(accessRules, "resolveAccessibleProjectScope");
    // Requisitante com os DOIS módulos: ambas as lentes chegam ao banco, então
    // a contagem de queries mede a memoização (sem ela: 4 tools × 2 = 8).
    const ctx: ToolContext = {
      tenantId: TENANT,
      role: "USER",
      projectScope: [REFORMA],
      allowedProjects: [REFORMA],
      allowedProjectTypes: ["REFORMA"],
      allowedModules: ["expenses", "receipts"],
    };

    await service.execute("get_financial_overview", ctx, {});
    await service.execute("get_by_project", ctx, {});
    await service.execute("get_expenses_by_category", ctx, {});
    await service.execute("get_top_suppliers", ctx, {});

    const modulesResolved = resolver.mock.calls.map((call) => call[6]);
    expect(modulesResolved.sort()).toEqual(["expenses", "receipts"]);
    expect(prisma.project.findMany).toHaveBeenCalledTimes(2);
    resolver.mockRestore();
  });

  it("memoização não vaza entre turnos: outro contexto resolve de novo", async () => {
    const { service } = buildHarness();
    const resolver = jest.spyOn(accessRules, "resolveAccessibleProjectScope");

    await service.execute("get_financial_overview", expenseOnlyCtx(), {});
    await service.execute("get_financial_overview", expenseOnlyCtx(), {});

    // Dois objetos de contexto distintos ⇒ duas resoluções por módulo.
    expect(resolver.mock.calls.map((call) => call[6]).sort()).toEqual([
      "expenses",
      "expenses",
      "receipts",
      "receipts",
    ]);
    resolver.mockRestore();
  });

  it("a lente do recurso nunca ultrapassa o escopo de projeto do turno", async () => {
    const { service, financial } = buildHarness();
    // ACL bruta alcança os dois projetos, mas o turno já foi restringido a um.
    await service.execute(
      "get_financial_overview",
      {
        tenantId: TENANT,
        role: "USER",
        projectScope: [PESSOAL],
        allowedProjects: [],
        allowedProjectTypes: ["REFORMA", "PESSOAL"],
        allowedModules: ["expenses", "receipts"],
      },
      {},
    );

    expect(financial.getOverview.mock.calls[0][1]).toEqual({
      expenses: [PESSOAL],
      receipts: [PESSOAL],
    });
  });

  it("escopo de turno vazio (fail-closed) mantém as lentes vazias", async () => {
    const { service, financial } = buildHarness();

    await service.execute(
      "get_financial_overview",
      {
        tenantId: TENANT,
        role: "USER",
        projectScope: [],
        allowedProjects: [],
        allowedProjectTypes: ["REFORMA"],
        allowedModules: ["expenses", "receipts"],
      },
      {},
    );

    expect(financial.getOverview.mock.calls[0][1]).toEqual({
      expenses: [],
      receipts: [],
    });
  });

  it("list_payment_methods filtra cartões pela lente de creditCards", async () => {
    const { service, prisma } = buildHarness();

    await service.execute("list_payment_methods", expenseOnlyCtx(), {});

    expect(prisma.creditCard.findMany.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      deletedAt: null,
      projectId: { in: [] },
    });
  });

  it("find_expenses filtra pela lente de despesa, não pelo escopo amplo", async () => {
    const { service, prisma } = buildHarness();

    await service.execute("find_expenses", cardOnlyCtx(), {});

    expect(prisma.expense.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ projectId: { in: [] } }),
    );
  });
});
