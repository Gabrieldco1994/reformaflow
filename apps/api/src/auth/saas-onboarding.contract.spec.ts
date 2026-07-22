import { BadRequestException, NotFoundException } from "@nestjs/common";
import { validate } from "class-validator";
import { AuthService } from "./auth.service";
import { RegisterOwnerDto } from "./dto/register-owner.dto";
import { UpdateObjectivesDto } from "./dto/update-objectives.dto";

const TYPES = ["REFORMA", "COMPRA", "CASA", "CARRO", "PESSOAL", "PLANTAS"] as const;
type Input = {
  tenantName: string;
  ownerName: string;
  email: string;
  username: string;
  password: string;
  projectTypes: string[];
};
const valid: any = {
  tenantName: " Acme ",
  ownerName: " Maria ",
  email: "maria@acme.com",
  username: "Maria.Silva",
  password: "segredo123",
  projectTypes: ["CASA", "PESSOAL"],
};
const registerDto = (input: Partial<Input> = {}) =>
  Object.assign(new RegisterOwnerDto(), valid, input);
const objectivesDto = (projectTypes: unknown) =>
  Object.assign(new UpdateObjectivesDto(), { projectTypes });

function harness() {
  const tx: any = {
    tenant: { create: jest.fn().mockResolvedValue({ id: "t1", name: "Acme" }) },
    user: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
  };
  tx.user.create.mockImplementation(({ data }: any) =>
    Promise.resolve({ id: "u1", allowedProjects: "[]", deletedAt: null, ...data }),
  );
  const prisma: any = {
    user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    tenant: { create: jest.fn() },
    project: { findMany: jest.fn() },
    $transaction: jest.fn(async (callback: any) => callback(tx)),
  };
  return { service: new AuthService(prisma, { sign: jest.fn() } as any), prisma, tx };
}

describe("self-service registration contract", () => {
  beforeEach(() => { process.env.AUTH_ENABLE_REGISTER = "1"; });
  afterEach(() => { delete process.env.AUTH_ENABLE_REGISTER; });

  it.each([
    [undefined], [null], [[]], [["CASA", "CASA"]], [["DESCONHECIDO"]],
    [[...TYPES, "CASA"]],
  ])("rejects a missing, malformed, duplicate, unknown, or >6 projectTypes set: %j", async (projectTypes) => {
    const errors = await validate(registerDto({ projectTypes: projectTypes as any }));
    expect(errors.map((error) => error.property)).toContain("projectTypes");
  });

  it.each(TYPES)("accepts canonical project type %s", async (projectType) => {
    expect(await validate(registerDto({ projectTypes: [projectType] }))).toEqual([]);
  });

  it("enforces the same minimum password length as the public form", async () => {
    const errors = await validate(registerDto({ password: "curta12" }));
    expect(errors.map((error) => error.property)).toContain("password");
  });

  it("creates exactly one tenant and one USER atomically, derives permissions, and creates no project", async () => {
    const { service, prisma, tx } = harness();
    const result = await service.registerOwner(valid as any);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: { username: "maria.silva", deletedAt: null }, select: { id: true },
    });
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t1", username: "maria.silva", name: "Maria", role: "USER", isGuest: false,
        allowedProjectTypes: JSON.stringify(["CASA", "PESSOAL"]),
        allowedModules: JSON.stringify([
          "dashboard", "recurringBills", "maintenance", "reminders", "expenses",
          "receipts", "cashFlow", "creditCards", "bankAccounts", "monthlyOverview",
        ]),
      }),
    });
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    expect(result.user.role).toBe("USER");
    expect(result.user.allowedProjects).toBe("[]");
  });

  it("ignores forged role, tenant and derived permissions", async () => {
    const { service, tx } = harness();
    await service.registerOwner({
      ...valid, role: "ADMIN", tenantId: "evil", allowedModules: ["admin"],
      allowedProjectTypes: ["REFORMA"],
    } as any);

    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe("t1");
    expect(data.role).toBe("USER");
    expect(data.allowedModules).toBe(JSON.stringify([
      "dashboard", "recurringBills", "maintenance", "reminders", "expenses",
      "receipts", "cashFlow", "creditCards", "bankAccounts", "monthlyOverview",
    ]));
    expect(data.allowedProjectTypes).toBe(JSON.stringify(["CASA", "PESSOAL"]));
  });

  it("keeps duplicate detection and both writes in the rollback boundary", async () => {
    const { service, prisma, tx } = harness();
    tx.user.findFirst.mockResolvedValue({ id: "existing" });

    await expect(service.registerOwner(valid as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  it("does not mutate when public registration is disabled", async () => {
    delete process.env.AUTH_ENABLE_REGISTER;
    const { service, prisma, tx } = harness();
    await expect(service.registerOwner(valid as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.tenant.create).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });
});

describe("self objective validation and persistence", () => {
  it.each([undefined, null, [], ["CASA", "CASA"], ["NOPE"], [...TYPES, "CASA"]])(
    "rejects %j at the endpoint DTO boundary",
    async (projectTypes) => {
      const errors = await validate(objectivesDto(projectTypes));
      expect(errors.map((error) => error.property)).toContain("projectTypes");
    },
  );

  it("updates only both derived permission fields for the authenticated identity", async () => {
    const { service, prisma } = harness();
    prisma.user.findUnique.mockResolvedValue({
      id: "u1", deletedAt: null, tenant: { deletedAt: null },
      allowedProjectTypes: '["CASA"]', allowedModules: '["dashboard","expenses"]',
    });
    prisma.user.update.mockResolvedValue({
      id: "u1", allowedProjectTypes: '["PLANTAS"]',
      allowedModules: '["dashboard","maintenance","reminders","plantsAi"]',
    });

    const result = await service.updateSelfObjectives("u1", ["PLANTAS"] as any);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" }, include: { tenant: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        allowedProjectTypes: '["PLANTAS"]',
        allowedModules: '["dashboard","maintenance","reminders","plantsAi"]',
      },
    });
    expect(result).toEqual({
      projectTypes: ["PLANTAS"], allowedProjectTypes: ["PLANTAS"],
      allowedModules: ["dashboard", "maintenance", "reminders", "plantsAi"],
    });
  });
});
