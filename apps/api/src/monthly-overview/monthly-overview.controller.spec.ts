import { MonthlyOverviewController } from "./monthly-overview.controller";
import { MonthlyOverviewService } from "./monthly-overview.service";
import { MODULE_KEY } from "../common/decorators/require-module.decorator";

describe("MonthlyOverviewController", () => {
  it("encaminha o mês opcional para a visão mensal", async () => {
    const getOverview = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({
      getOverview,
    } as unknown as MonthlyOverviewService);

    await controller.getOverview("tenant-1", "pessoal-1", "2026-03");

    expect(getOverview).toHaveBeenCalledWith(
      "tenant-1",
      "pessoal-1",
      "2026-03",
    );
  });
});

/**
 * B0 (#447) — nenhuma das 7 rotas GET deste controller declara
 * `@RequireModule('monthlyOverview')`. Como `ModulesGuard.canActivate` retorna
 * `true` sem checar NADA quando o Reflector não encontra metadata
 * (`if (!required) return true;`), hoje QUALQUER usuário autenticado — mesmo
 * sem o módulo `monthlyOverview` — atravessa este controller inteiro. Este
 * teste fixa o contrato "Controller mensal exige módulo" usando o MESMO
 * mecanismo (`RequireModule`/`MODULE_KEY`) já usado por
 * `InvoiceAdjustmentController` (`creditCards`) e `PurchasePlannerController`
 * (`monthlyOverview`) — não inventa guarda nova.
 */
describe("MonthlyOverviewController — exige o módulo monthlyOverview (B0 #447)", () => {
  it("declara @RequireModule('monthlyOverview') na classe do controller", () => {
    const required = Reflect.getMetadata(MODULE_KEY, MonthlyOverviewController);
    expect(required).toEqual(
      expect.arrayContaining(["monthlyOverview"]),
    );
  });
});

/**
 * B0 (#447) — "Controller mensal exige módulo/requester": nenhum dos 7 GETs
 * hoje recebe o `requester` (`@CurrentUser()`) — só `payInvoice` (um POST)
 * usa esse decorator no controller inteiro. Sem o requester chegando ao
 * service, não há como materializar/validar o scope concreto (tenant+tipos+
 * módulos+IDs) por requisitante antes de ler caixa/conta/DRE/faturas/neutros.
 * Cada assert procura o `requesterId` sentinela em QUALQUER posição/formato
 * (arg posicional ou dentro de um objeto de opções) — não assume fiação
 * específica, só que o dado chega ao service de alguma forma.
 */
describe("MonthlyOverviewController — repassa requester para os 7 GETs (B0 #447)", () => {
  const requester = { id: "sentinel-requester-b0-447", role: "USER" };

  function forwardedRequester(mockCalls: unknown[][]) {
    expect(mockCalls.length).toBeGreaterThan(0);
    return JSON.stringify(mockCalls[0]).includes(requester.id);
  }

  it("getOverview repassa o requester ao service", async () => {
    const getOverview = jest.fn().mockResolvedValue({});
    const controller = new MonthlyOverviewController({ getOverview } as any);
    await (controller as any).getOverview("t1", "p1", "2026-08", requester);
    expect(forwardedRequester(getOverview.mock.calls)).toBe(true);
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
