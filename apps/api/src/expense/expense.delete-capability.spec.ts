import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { APIRequestContext, request } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseModule } from "./expense.module";
import { ExpenseService } from "./expense.service";
import { RefundPurposePrivacyInterceptor } from "./refund-purpose-privacy.interceptor";

describe("#704 advisory negative Expense.canDelete (real HTTP/Prisma)", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  let app: INestApplication;
  let http: APIRequestContext;
  let f: Awaited<ReturnType<typeof refundFixture>>;
  const queries: string[] = [];
  prisma.$use(async (params, next) => {
    if (params.model !== "User")
      queries.push(`${params.model}:${params.action}`);
    return next(params);
  });
  const path = (projectId: string, id?: string) =>
    `/projects/${projectId}/expenses${id ? `/${id}` : ""}`;
  const snapshot = async () => ({
    expenses: await db.expense.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
    }),
    cash: await db.cashFlowEntry.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
    }),
    allocations: await db.rateioAllocation.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
    }),
  });
  const read = async (url: string) => {
    const response = await http.get(url);
    expect(response.status()).toBe(200);
    return response.json();
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PrismaModule, ExpenseModule],
      providers: [JwtStrategy],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    const reflector = new Reflector();
    app.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new RolesGuard(reflector),
      new ModulesGuard(reflector, prisma),
      new ProjectAccessGuard(prisma, reflector),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new RefundPurposePrivacyInterceptor(prisma));
    await app.listen(0, "127.0.0.1");
  });
  beforeEach(async () => {
    f = await refundFixture(db, prisma, "refund-delete-capability");
    const jwt = new JwtService({
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
    });
    http = await request.newContext({
      baseURL: await app.getUrl(),
      extraHTTPHeaders: {
        Authorization: `Bearer ${jwt.sign({ sub: f.requester.id, tenantId: f.tenantId, sv: 0 })}`,
      },
    });
  });
  afterEach(async () => {
    await http.dispose();
    await f.cleanup();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("list/detail/cross-project expose true for removable source and false for protected target without writes", async () => {
    const applied = await f.apply();
    const before = await snapshot();
    queries.length = 0;
    for (const [projectId, id, canDelete] of [
      [f.projectId, f.source.id, true],
      [f.targetProjectId, applied.targetExpenseId, false],
    ] as const) {
      expect(await read(path(projectId, id))).toMatchObject({ id, canDelete });
      expect((await read(path(projectId))).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id, canDelete })]),
      );
      const anchor =
        projectId === f.projectId ? f.targetProjectId : f.projectId;
      expect(
        await read(
          `${path(anchor)}/cross-project?targetProjectId=${projectId}`,
        ),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ id, canDelete })]),
      );
    }
    expect(
      queries.filter(
        (query) => !/:(findMany|findFirst|findUnique|count)$/.test(query),
      ),
    ).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("current participant permission revocation disables source deletion and keeps raw rateio indistinguishable", async () => {
    const never = await read(`${path(f.projectId, f.source.id)}/rateio`);
    const applied = await f.apply();
    const anchor = await db.project.create({
      data: {
        tenantId: f.tenantId,
        name: "Authorized read anchor",
        type: "REFORMA",
      },
    });
    await db.user.update({
      where: { id: f.requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([f.projectId, anchor.id]),
        allowedModules: JSON.stringify(["expenses", "creditCards"]),
        allowedProjectTypes: JSON.stringify(["PESSOAL", "REFORMA"]),
      },
    });
    const before = await snapshot();
    for (const url of [
      path(f.projectId, f.source.id),
      path(f.projectId),
      `${path(anchor.id)}/cross-project?targetProjectId=${f.projectId}`,
    ]) {
      const payload = await read(url);
      const row = Array.isArray(payload)
        ? payload[0]
        : (payload.items?.[0] ?? payload);
      expect(row).toMatchObject({
        id: f.source.id,
        canDelete: false,
        linkedExpenseId: null,
      });
      expect(JSON.stringify(payload)).not.toContain(applied.targetExpenseId);
      expect(JSON.stringify(payload)).not.toContain(f.targetProjectId);
    }
    const hidden = await read(`${path(f.projectId, f.source.id)}/rateio`);
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(never));
    expect(JSON.stringify(hidden)).not.toContain("canDelete");
    expect(await snapshot()).toEqual(before);
  });

  it.each(["list", "detail", "cross-project"] as const)(
    "redacts a captured HTTP %s reference when an authorized undo commits before serialization",
    async (surface) => {
      const applied = await f.apply();
      const writer = await db.user.create({
        data: {
          tenantId: f.tenantId,
          username: "undo-writer",
          name: "Authorized undo writer",
          role: "OWNER",
        },
      });
      const anchor = await db.project.create({
        data: { tenantId: f.tenantId, name: "Read anchor", type: "REFORMA" },
      });
      await db.user.update({
        where: { id: f.requester.id },
        data: {
          role: "USER",
          allowedProjects: JSON.stringify([f.projectId, anchor.id]),
          allowedModules: JSON.stringify(["expenses", "creditCards"]),
          allowedProjectTypes: "[]",
        },
      });
      const service = app.get(ExpenseService);
      const enrich = service.withDeleteCapabilities.bind(service);
      let afterUndo: Awaited<ReturnType<typeof snapshot>> | undefined;
      const barrier = jest
        .spyOn(service, "withDeleteCapabilities")
        .mockImplementationOnce(async (...args) => {
          const captured = await enrich(...args);
          expect(captured).toEqual([
            expect.objectContaining({
              id: f.source.id,
              linkedExpenseId: applied.targetExpenseId,
              canDelete: false,
            }),
          ]);
          await f.service.undo(
            f.tenantId,
            f.projectId,
            f.source.id,
            { id: writer.id, role: writer.role },
            {
              expectedRevision: applied.revision,
            },
          );
          afterUndo = await snapshot();
          expect(afterUndo.allocations).toHaveLength(0);
          return captured;
        });
      try {
        const url =
          surface === "list"
            ? path(f.projectId)
            : surface === "detail"
              ? path(f.projectId, f.source.id)
              : `${path(anchor.id)}/cross-project?targetProjectId=${f.projectId}`;
        const payload = await read(url);
        expect(barrier).toHaveBeenCalledTimes(1);
        const row = Array.isArray(payload)
          ? payload[0]
          : (payload.items?.[0] ?? payload);
        expect(row).toMatchObject({ id: f.source.id, linkedExpenseId: null });
        const json = JSON.stringify(payload);
        expect(json).not.toContain(applied.targetExpenseId);
        expect(json).not.toContain("refundPurposeRevision");
        expect(json).not.toContain("isRefundCredit");
        expect(await snapshot()).toEqual(afterUndo);
      } finally {
        barrier.mockRestore();
      }
    },
  );

  it.each(["target-drift", "deleted-card", "card-module"] as const)(
    "source capability reflects cleanup blocker: %s",
    async (blocker) => {
      const applied = await f.apply();
      if (blocker === "target-drift")
        await db.expense.update({
          where: { id: applied.targetExpenseId },
          data: { valorTotal: -1 },
        });
      if (blocker === "deleted-card")
        await db.creditCard.update({
          where: { id: f.card.id },
          data: { deletedAt: new Date() },
        });
      if (blocker === "card-module")
        await db.user.update({
          where: { id: f.requester.id },
          data: {
            role: "USER",
            allowedProjects: JSON.stringify([f.projectId, f.targetProjectId]),
            allowedModules: JSON.stringify(["expenses"]),
            allowedProjectTypes: "[]",
          },
        });
      const before = await snapshot();
      expect(await read(path(f.projectId, f.source.id))).toMatchObject({
        canDelete: false,
        linkedExpenseId: applied.targetExpenseId,
      });
      expect([403, 404, 409]).toContain(
        (await http.delete(path(f.projectId, f.source.id))).status(),
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "allowedProjects",
    "allowedModules",
    "allowedProjectTypes",
  ] as const)(
    "malformed current %s fails closed without exposing the marked pointer",
    async (column) => {
      const applied = await f.apply();
      await db.user.update({
        where: { id: f.requester.id },
        data: { [column]: "{}" },
      });
      const before = await snapshot();
      for (const url of [path(f.projectId), path(f.projectId, f.source.id)]) {
        const response = await http.get(url);
        expect(response.status()).toBe(401);
        expect(await response.text()).not.toContain(applied.targetExpenseId);
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it("positive legacy linked rows retain their existing pointer", async () => {
    const target = await db.expense.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.targetProjectId,
        tipoDespesa: "OUTROS",
        valor: 1,
        valorTotal: 1,
        formaPagamento: "A_VISTA",
      },
    });
    const positive = await db.expense.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.projectId,
        tipoDespesa: "OUTROS",
        valor: 1,
        valorTotal: 1,
        formaPagamento: "A_VISTA",
        linkedExpenseId: target.id,
      },
    });
    await db.user.update({
      where: { id: f.requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([f.projectId]),
        allowedModules: JSON.stringify(["expenses"]),
        allowedProjectTypes: "[]",
      },
    });
    expect(await read(path(f.projectId, positive.id))).toMatchObject({
      linkedExpenseId: target.id,
    });
  });
  it("nonowned negative remains deletable and ordinary positive has unchanged optional wire shape", async () => {
    const positive = await db.expense.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.projectId,
        tipoDespesa: "OUTROS",
        valor: 100,
        valorTotal: 100,
        formaPagamento: "A_VISTA",
      },
    });
    expect(await read(path(f.projectId, f.source.id))).toMatchObject({
      canDelete: true,
    });
    expect(await read(path(f.projectId, positive.id))).not.toHaveProperty(
      "canDelete",
    );
    expect((await http.delete(path(f.projectId, f.source.id))).status()).toBe(
      200,
    );
  });

  it("unowned negative DELETE rechecks revoked grants inside the transaction despite a stale requester", async () => {
    await db.user.update({
      where: { id: f.requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([f.targetProjectId]),
        allowedModules: JSON.stringify(["expenses"]),
        allowedProjectTypes: "[]",
      },
    });
    const before = await snapshot();
    const service = app.get(ExpenseService);
    expect(
      await service.withDeleteCapabilities(f.tenantId, [f.source], f.requester),
    ).toEqual([expect.objectContaining({ canDelete: false })]);
    await expect(
      service.remove(f.tenantId, f.projectId, f.source.id, f.requester),
    ).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });

  it("capability cannot be written or forged; source DELETE still atomically cleans owned target", async () => {
    const applied = await f.apply();
    const targetPath = path(f.targetProjectId, applied.targetExpenseId);
    const before = await snapshot();
    expect(
      (await http.patch(targetPath, { data: { canDelete: true } })).status(),
    ).toBe(400);
    expect(
      (await http.delete(targetPath, { data: { canDelete: true } })).status(),
    ).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect((await http.delete(path(f.projectId, f.source.id))).status()).toBe(
      200,
    );
    expect(
      await db.expense.findUnique({ where: { id: applied.targetExpenseId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await db.cashFlowEntry.count({
        where: { tenantId: f.tenantId, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await db.rateioAllocation.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
  });

  it.each([
    { invoiceUndoState: "PROCESSED_NONE" },
    { settlesInvoiceKey: "m1:malformed-but-reserved" },
  ])(
    "unowned negative preserves actual deletion provenance guard: %j",
    async (data) => {
      await db.expense.update({ where: { id: f.source.id }, data });
      const before = await snapshot();
      expect(await read(path(f.projectId, f.source.id))).toMatchObject({
        canDelete: false,
      });
      expect((await read(path(f.projectId))).items[0]).toMatchObject({
        canDelete: false,
      });
      expect((await http.delete(path(f.projectId, f.source.id))).status()).toBe(
        409,
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it("batches standalone negative capability checks instead of querying per row", async () => {
    queries.length = 0;
    expect((await read(path(f.projectId))).items[0]).toMatchObject({
      canDelete: true,
    });
    const oneRowQueries = queries.length;
    await db.expense.createMany({
      data: Array.from({ length: 25 }, () => ({
        tenantId: f.tenantId,
        projectId: f.projectId,
        tipoDespesa: "OUTROS",
        valor: -1,
        valorTotal: -1,
        formaPagamento: "A_VISTA",
      })),
    });
    queries.length = 0;
    const result = await read(path(f.projectId));
    expect(result.items).toHaveLength(26);
    expect(
      result.items.every(
        (row: { canDelete?: boolean }) => row.canDelete === true,
      ),
    ).toBe(true);
    expect(queries.length).toBe(oneRowQueries);
    const planned = await read(`${path(f.projectId)}/planned`);
    expect(planned).toHaveLength(25);
    expect(
      planned.every((row: { canDelete?: boolean }) => row.canDelete === true),
    ).toBe(true);
  });
});
