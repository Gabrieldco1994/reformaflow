import { MonthlyOverviewController } from "./monthly-overview.controller";
import { MonthlyOverviewService } from "./monthly-overview.service";

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
