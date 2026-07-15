import { ForbiddenException } from "@nestjs/common";
import { ProjectService } from "./project.service";

const projects = [
  { id: "casa", tenantId: "t1", type: "CASA", name: "Casa" },
  { id: "carro", tenantId: "t1", type: "CARRO", name: "Carro" },
];
const user = {
  id: "u1",
  role: "USER",
  allowedProjectTypes: ["CASA"],
  allowedModules: [
    "dashboard",
    "expenses",
    "recurringBills",
    "maintenance",
    "reminders",
  ],
  allowedProjects: [],
};

describe("ProjectService objective gate", () => {
  it("lists only explicit types when a revoked type shares every module", async () => {
    const prisma: any = {
      project: { findMany: jest.fn().mockResolvedValue(projects) },
    };

    await expect(
      new ProjectService(prisma).findAll("t1", user),
    ).resolves.toEqual([projects[0]]);
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1" } }),
    );
  });

  it("denies create and detail for a revoked type, then restores preserved detail", async () => {
    const prisma: any = {
      project: {
        findFirst: jest.fn().mockResolvedValue({
          ...projects[1],
          rooms: [],
          _count: {},
        }),
      },
    };
    const service = new ProjectService(prisma);

    await expect(service.findById("t1", "carro", user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.create("t1", { name: "Novo", type: "CARRO" } as any, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.findById("t1", "carro", {
        ...user,
        allowedProjectTypes: ["CASA", "CARRO"],
      }),
    ).resolves.toMatchObject({ id: "carro", type: "CARRO" });
    expect(prisma.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "carro", tenantId: "t1" } }),
    );
  });

  it("derives access by module when type grants are empty", async () => {
    const prisma: any = {
      project: { findMany: jest.fn().mockResolvedValue(projects) },
    };
    await expect(
      new ProjectService(prisma).findAll("t1", {
        ...user,
        allowedProjectTypes: [],
      }),
    ).resolves.toEqual(projects);
  });

  it("requires both the explicit type and project grant", async () => {
    const prisma: any = {
      project: {
        findFirst: jest.fn().mockResolvedValue({
          ...projects[0],
          rooms: [],
          _count: {},
        }),
      },
    };
    await expect(
      new ProjectService(prisma).findById("t1", "casa", {
        ...user,
        allowedProjects: ["outro-projeto"],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
