import { BadRequestException, NotFoundException } from "@nestjs/common";
import { validate } from "class-validator";
import { AuthService } from "./auth.service";
import { RegisterOwnerDto } from "./dto/register-owner.dto";
import { UpdateObjectivesDto } from "./dto/update-objectives.dto";

const TYPES = ["REFORMA", "COMPRA", "CASA", "CARRO", "PESSOAL", "PLANTAS"] as const;
type Input = {
  tenantName?: string;
  ownerName: string;
  email: string;
  username?: string;
  password: string;
  projectTypes?: string[];
};
const valid: Input = {
  ownerName: "Maria",
  email: "maria@example.com",
  password: "segredo123",
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

  it("requires email, ownerName, and password; all others optional", async () => {
    const errors = await validate(registerDto({
      email: undefined, ownerName: undefined, password: undefined,
    } as any));
    expect(errors.map((e) => e.property)).toContain("email");
    expect(errors.map((e) => e.property)).toContain("ownerName");
    expect(errors.map((e) => e.property)).toContain("password");
  });

  it("accepts projectTypes when provided and valid", async () => {
    expect(await validate(registerDto({ projectTypes: ["CASA", "PESSOAL"] }))).toEqual([]);
  });

  it("accepts projectTypes absent (defaults to [PESSOAL])", async () => {
    const errors = await validate(registerDto({ projectTypes: undefined }));
    expect(errors).toEqual([]);
  });

  it("rejects invalid projectTypes: malformed, duplicate, unknown, or >6 types", async () => {
    const invalid = [
      [["CASA", "CASA"]], // duplicate
      [["DESCONHECIDO"]], // unknown
      [[...TYPES, "CASA"]], // >6
      [[null]], // malformed
    ];
    for (const [projectTypes] of invalid) {
      const errors = await validate(registerDto({ projectTypes: projectTypes as any }));
      expect(errors.map((e) => e.property)).toContain("projectTypes");
    }
  });

  it("enforces minimum password length 8", async () => {
    const errors = await validate(registerDto({ password: "short12" }));
    expect(errors.map((e) => e.property)).toContain("password");
  });

  it("creates exactly one tenant and one USER atomically with derived permissions", async () => {
    const { service, prisma, tx } = harness();
    const result = await service.registerOwner(valid as any);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: "maria@example.com" }),
      }),
    );
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t1",
        email: "maria@example.com",
        username: "maria", // derived from email prefix
        name: "Maria",
        role: "USER",
        isGuest: false,
        allowedProjectTypes: JSON.stringify(["PESSOAL"]), // default
        // PESSOAL allows: dashboard, expenses, receipts, cashFlow, creditCards, bankAccounts, monthlyOverview, pendencias
        allowedModules: JSON.stringify([
          "dashboard", "expenses", "receipts", "cashFlow", "creditCards",
          "bankAccounts", "monthlyOverview", "pendencias",
        ]),
      }),
    });
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("ignores forged role, tenantId, and derived permissions", async () => {
    const { service, tx } = harness();
    await service.registerOwner({
      ...valid, role: "ADMIN", tenantId: "evil", allowedProjectTypes: ["REFORMA"],
    } as any);

    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe("t1");
    expect(data.role).toBe("USER");
    expect(data.allowedProjectTypes).toBe(JSON.stringify(["PESSOAL"]));
  });

  it("keeps duplicate email detection and transaction rollback on conflict", async () => {
    const { service, prisma, tx } = harness();
    tx.user.findFirst.mockResolvedValue({ id: "existing" });

    await expect(service.registerOwner(valid as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it("does not mutate when public registration is disabled", async () => {
    delete process.env.AUTH_ENABLE_REGISTER;
    const { service, prisma, tx } = harness();
    await expect(service.registerOwner(valid as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
  });
});
