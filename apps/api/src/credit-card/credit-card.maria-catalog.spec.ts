import { CreditCardService } from "./credit-card.service";

describe("authenticated Maria card catalog contract", () => {
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
