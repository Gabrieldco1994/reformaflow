import { TenantFinancialController } from "./tenant-financial.controller";

describe("TenantFinancialController", () => {
  const service = {
    getOverview: jest.fn(),
    getByProject: jest.fn(),
    getCashFlow: jest.fn(),
    getByCategory: jest.fn(),
    getUpcoming: jest.fn(),
    getTopSuppliers: jest.fn(),
  };

  const controller = new TenantFinancialController(service as any);
  const tenantId = "tenant-1";

  beforeEach(() => jest.clearAllMocks());

  it("propaga scope restrito do usuário em todas as visões cross-project", () => {
    const user = { role: "MEMBER", allowedProjects: ["p-1", "p-2"] };

    controller.getOverview(tenantId, user);
    controller.getByProject(tenantId, user);
    controller.getByCategory(tenantId, user);
    controller.getCashFlow(tenantId, user, undefined);
    controller.getUpcoming(tenantId, user, undefined);
    controller.getTopSuppliers(tenantId, user, undefined);

    expect(service.getOverview).toHaveBeenCalledWith(tenantId, ["p-1", "p-2"]);
    expect(service.getByProject).toHaveBeenCalledWith(tenantId, ["p-1", "p-2"]);
    expect(service.getByCategory).toHaveBeenCalledWith(tenantId, [
      "p-1",
      "p-2",
    ]);
    expect(service.getCashFlow).toHaveBeenCalledWith(tenantId, 12, [
      "p-1",
      "p-2",
    ]);
    expect(service.getUpcoming).toHaveBeenCalledWith(tenantId, 30, [
      "p-1",
      "p-2",
    ]);
    expect(service.getTopSuppliers).toHaveBeenCalledWith(tenantId, 10, [
      "p-1",
      "p-2",
    ]);
  });

  it("ADMIN tem escopo null (sem restrição)", () => {
    const admin = { role: "ADMIN", allowedProjects: ["p-1"] };

    controller.getOverview(tenantId, admin);

    expect(service.getOverview).toHaveBeenCalledWith(tenantId, null);
  });

  it("normaliza limites de months/days/limit", () => {
    const user = { role: "MEMBER", allowedProjects: ["p-1"] };

    controller.getCashFlow(tenantId, user, "999");
    controller.getCashFlow(tenantId, user, "0");

    controller.getUpcoming(tenantId, user, "9999");
    controller.getUpcoming(tenantId, user, "0");

    controller.getTopSuppliers(tenantId, user, "999");
    controller.getTopSuppliers(tenantId, user, "0");

    expect(service.getCashFlow).toHaveBeenNthCalledWith(1, tenantId, 36, [
      "p-1",
    ]);
    expect(service.getCashFlow).toHaveBeenNthCalledWith(2, tenantId, 12, [
      "p-1",
    ]);

    expect(service.getUpcoming).toHaveBeenNthCalledWith(1, tenantId, 365, [
      "p-1",
    ]);
    expect(service.getUpcoming).toHaveBeenNthCalledWith(2, tenantId, 30, [
      "p-1",
    ]);

    expect(service.getTopSuppliers).toHaveBeenNthCalledWith(1, tenantId, 50, [
      "p-1",
    ]);
    expect(service.getTopSuppliers).toHaveBeenNthCalledWith(2, tenantId, 10, [
      "p-1",
    ]);
  });
});
