import { MonthlyOverviewController } from "./monthly-overview.controller";
import { MODULE_KEY } from "../common/decorators/require-module.decorator";

/**
 * B0 (#447) — nenhuma das 7 rotas GET deste controller declara
 * `@RequireModule('monthlyOverview')`, e nenhuma repassa `requester`
 * (`@CurrentUser()`) ao service — sem o requester chegando lá, não há como
 * materializar/validar o scope concreto (tenant+tipos+módulos+IDs) antes de
 * ler caixa/conta/DRE/faturas/neutros. `Reflector.getAllAndOverride` deixa
 * metadata de MÉTODO sobrescrever a de CLASSE, então o slug é checado nos 7
 * handlers individualmente, não só na classe.
 */
describe("MonthlyOverviewController — exige exatamente o módulo monthlyOverview nos 7 GETs (B0 #447)", () => {
  const SEVEN_GETS = [
    "getOverview",
    "getAccountView",
    "getAccountViewYearly",
    "getCardInvoicesYearly",
    "getDreOverview",
    "getOriginItemsYearly",
    "getNeutros",
  ] as const;

  it("declara @RequireModule('monthlyOverview') na classe do controller", () => {
    const required = Reflect.getMetadata(MODULE_KEY, MonthlyOverviewController);
    expect(required).toEqual(["monthlyOverview"]);
  });

  it.each(SEVEN_GETS)(
    "%s resolve para exatamente ['monthlyOverview'] (metadata de método OU de classe)",
    (methodName) => {
      const handler = (MonthlyOverviewController.prototype as any)[methodName];
      const methodLevel = Reflect.getMetadata(MODULE_KEY, handler);
      const classLevel = Reflect.getMetadata(MODULE_KEY, MonthlyOverviewController);
      const required = methodLevel ?? classLevel;
      expect(required).toEqual(["monthlyOverview"]);
    },
  );
});

describe("MonthlyOverviewController — repassa requester para os 7 GETs (B0 #447)", () => {
  const requester = { id: "sentinel-requester-b0-447", role: "USER" };

  function forwardedRequester(mockCalls: unknown[][]) {
    expect(mockCalls.length).toBeGreaterThan(0);
    return JSON.stringify(mockCalls[0]).includes(requester.id);
  }

  it("getOverview repassa o mês e o requester ao service, nessa ordem exata", async () => {
    const getOverview = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ getOverview } as any);
    await (controller as any).getOverview("t1", "p1", "2026-08", requester);
    expect(getOverview).toHaveBeenCalledWith("t1", "p1", "2026-08", requester);
  });

  it("getAccountView repassa o requester ao service", async () => {
    const getAccountView = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ getAccountView } as any);
    await (controller as any).getAccountView("t1", "p1", "2026-08", requester);
    expect(forwardedRequester(getAccountView.mock.calls)).toBe(true);
  });

  it("getAccountViewYearly repassa o requester ao service", async () => {
    const getAccountViewYearly = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ getAccountViewYearly } as any);
    await (controller as any).getAccountViewYearly("t1", "p1", "2026", requester);
    expect(forwardedRequester(getAccountViewYearly.mock.calls)).toBe(true);
  });

  it("getCardInvoicesYearly repassa o requester ao service", async () => {
    const getCardInvoicesYearly = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ getCardInvoicesYearly } as any);
    await (controller as any).getCardInvoicesYearly("t1", "p1", "2026", requester);
    expect(forwardedRequester(getCardInvoicesYearly.mock.calls)).toBe(true);
  });

  it("getDreOverview repassa o requester ao service", async () => {
    const getDreOverview = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ getDreOverview } as any);
    await (controller as any).getDreOverview("t1", "p1", "2026-08", "2026", requester);
    expect(forwardedRequester(getDreOverview.mock.calls)).toBe(true);
  });

  it("getOriginItemsYearly repassa o requester ao service", async () => {
    const getOriginItemsYearly = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ getOriginItemsYearly } as any);
    await (controller as any).getOriginItemsYearly(
      "t1",
      "p1",
      "2026",
      "cartao",
      "1111",
      requester,
    );
    expect(forwardedRequester(getOriginItemsYearly.mock.calls)).toBe(true);
  });

  it("getNeutros repassa o requester ao service", async () => {
    const getNeutros = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ getNeutros } as any);
    await (controller as any).getNeutros("t1", "p1", "2026", requester);
    expect(forwardedRequester(getNeutros.mock.calls)).toBe(true);
  });
});

/**
 * B0 (#447) — as 2 rotas POST herdaram o rename do param (`:pessoalProjectId`),
 * que tira `ProjectAccessGuard` do caminho, mas NÃO herdaram o repasse do
 * requester. Sem o requester completo chegando ao service, `ensurePessoalProject`
 * resolve o anchor em modo full-access e um USER restrito muta qualquer PESSOAL
 * do mesmo tenant. `requester.id` continua indo separado: é o `createdByUserId`
 * da despesa de pagamento (KPI "despesas criadas" depende dele).
 */
describe("MonthlyOverviewController — repassa o requester COMPLETO nas 2 mutações (B0 #447)", () => {
  const requester = {
    id: "sentinel-requester-b0-447",
    role: "USER",
    allowedProjects: ["p1"],
    allowedProjectTypes: ["PESSOAL"],
    allowedModules: ["monthlyOverview"],
  };

  it("payInvoice repassa o requester completo ao service E mantém requester.id como autor", async () => {
    const payInvoice = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ payInvoice } as any);
    const body = {
      cardLast4: "1111",
      month: "2026-06",
      amountCents: 7_000,
      bankLast4: "4247",
      paymentDate: "2026-05-31",
    };

    await (controller as any).payInvoice("t1", requester, "p1", body);

    expect(payInvoice).toHaveBeenCalledWith("t1", "p1", body, requester.id, requester);
  });

  it("undoInvoicePayment repassa o requester completo ao service", async () => {
    const undoInvoicePayment = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ undoInvoicePayment } as any);
    const body = { cardLast4: "1111", dueMonth: "2026-06" };

    await (controller as any).undoInvoicePayment("t1", requester, "p1", body);

    expect(undoInvoicePayment).toHaveBeenCalledWith("t1", "p1", body, requester);
  });
});
