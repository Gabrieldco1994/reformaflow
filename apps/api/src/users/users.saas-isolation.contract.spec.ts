import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

describe("administrative user isolation contract", () => {
  it("keeps the entire controller ADMIN-only", () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsersController)).toEqual(["ADMIN"]);

    const guard = new RolesGuard(new Reflector());
    const context: any = {
      getHandler: () => UsersController.prototype.list,
      getClass: () => UsersController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "USER" } }) }),
    };
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it("lists only the effective JWT tenant", async () => {
    const prisma: any = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new UsersService(prisma);

    await expect(service.list("jwt-tenant")).resolves.toEqual([]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "jwt-tenant" } }),
    );
  });

  it("cannot update a foreign-tenant user and performs no write", async () => {
    const prisma: any = {
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const service = new UsersService(prisma);

    await expect(
      service.update("jwt-tenant", "foreign-user", {
        role: "ADMIN",
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-user", tenantId: "jwt-tenant" },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
