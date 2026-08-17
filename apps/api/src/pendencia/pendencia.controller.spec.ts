/**
 * B0 (#447) verification delta — `PendenciaController.findFinancialQueue`
 * ("pendencia financeiras", `GET :projectId/pendencias/financeiras`) does
 * NOT declare `@CurrentUser()` at all — the only other handler in this
 * controller family reading the requester lives elsewhere
 * (`MonthlyOverviewController.payInvoice`). Without the requester reaching
 * `PendenciaService.findFinancialQueue` (and from there into
 * `MonthlyOverviewService.getAccountView`), there is no way to
 * materialize/validate the requester's concrete scope before the queue is
 * built — see `pendencia.financial-queue.fixture.integration.spec.ts` for the
 * proven sibling-PESSOAL leak through this exact call chain.
 */
import { PendenciaController } from "./pendencia.controller";
import { PendenciaService } from "./pendencia.service";

describe("PendenciaController.findFinancialQueue — repassa requester (B0 #447)", () => {
  it("repassa o requester ao service.findFinancialQueue", async () => {
    const findFinancialQueue = jest.fn().mockResolvedValue({ total: 0, grupos: [] });
    const controller = new PendenciaController({
      findFinancialQueue,
    } as unknown as PendenciaService);
    const requester = { id: "sentinel-requester-b0-447", role: "USER" };

    await (controller as any).findFinancialQueue(
      "tenant-1",
      "pessoal-1",
      "2026-08",
      requester,
    );

    const callArgs = findFinancialQueue.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(JSON.stringify(callArgs)).toContain(requester.id);
  });
});
