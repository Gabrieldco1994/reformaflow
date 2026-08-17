/**
 * B0 (#447) verification delta — `PendenciaController.findFinancialQueue`
 * ("pendencia financeiras") did not declare `@CurrentUser()`, so the
 * requester never reached `PendenciaService.findFinancialQueue` (and from
 * there `MonthlyOverviewService.getAccountView`) — see
 * `pendencia.financial-queue.fixture.integration.spec.ts` for the sibling-
 * PESSOAL leak this exact gap caused.
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
