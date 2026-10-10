import { CreditCardService } from "./credit-card.service";
import { CreditCardTenantController } from "./credit-card-tenant.controller";
import { PATH_METADATA } from "@nestjs/common/constants";

describe("authenticated Maria card catalog contract", () => {
  it("GET /tenant/credit-cards returns the integer boundary days or null without inventing missing configuration", async () => {
    expect(Reflect.getMetadata(PATH_METADATA, CreditCardTenantController)).toBe(
      "tenant/credit-cards",
    );
    const findMany = jest.fn().mockResolvedValue([
      { id: "first", closingDay: 1, dueDay: 31 },
      { id: "last", closingDay: 31, dueDay: 1 },
      { id: "unconfigured", closingDay: null, dueDay: null },
    ]);
    const prisma = { creditCard: { findMany } };
    const service = new CreditCardService(
      prisma as never,
      {} as never,
      {} as never,
    );
    const controller = new CreditCardTenantController(service, prisma as never);
    const response = await controller.list("jwt-tenant", { role: "ADMIN" });
    expect(
      response.map(({ closingDay, dueDay }) => ({ closingDay, dueDay })),
    ).toEqual([
      { closingDay: 1, dueDay: 31 },
      { closingDay: 31, dueDay: 1 },
      { closingDay: null, dueDay: null },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "jwt-tenant", deletedAt: null },
      }),
    );
  });
  it("includes closingDay/dueDay and preserves current tenant and project ACL scope", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "configured", closingDay: 5, dueDay: 10 },
      { id: "missing-days", closingDay: null, dueDay: null },
    ]);
    const service = new CreditCardService(
      { creditCard: { findMany } } as never,
      {} as never,
      {} as never,
    );
    const cards = await service.listCardsTenant("jwt-tenant", [
      "authorized-project",
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: "jwt-tenant",
          deletedAt: null,
          projectId: { in: ["authorized-project"] },
        },
      }),
    );
    expect(cards).toEqual([
      expect.objectContaining({ id: "configured", closingDay: 5, dueDay: 10 }),
      expect.objectContaining({
        id: "missing-days",
        closingDay: null,
        dueDay: null,
      }),
    ]);
    expect(
      cards.every(
        (card) =>
          Object.prototype.hasOwnProperty.call(card, "closingDay") &&
          Object.prototype.hasOwnProperty.call(card, "dueDay"),
      ),
    ).toBe(true);
  });
  it("deny-all scope is not expanded to the tenant catalog", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new CreditCardService(
      { creditCard: { findMany } } as never,
      {} as never,
      {} as never,
    );
    await service.listCardsTenant("jwt-tenant", []);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: "jwt-tenant",
          deletedAt: null,
          projectId: { in: [] },
        },
      }),
    );
  });
});
