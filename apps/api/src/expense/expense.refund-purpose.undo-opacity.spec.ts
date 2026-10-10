/**
 * #704 hardening — undo must not turn the revision comparison into an oracle for a
 * target the actor can no longer see. Real HTTP (global guards + privacy
 * interceptor) over the real PrismaService and the disposable test DB.
 *
 * Contract pinned here (literals, not derived from the code under test):
 *  - actor sees the source but not the owned target: an exact AND a stale odd
 *    revision answer the same 404 body as a non-existent source, never a 409
 *    that confirms a hidden marked target;
 *  - a fully authorized actor keeps the visible 409 for drift and the
 *    alreadyUndone replay;
 *  - failures leave every financial row (incl. updatedAt) untouched;
 *  - an unexpected error stays a 500, it is never disguised as 404.
 */
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
import { RefundPurposePrivacyInterceptor } from "./refund-purpose-privacy.interceptor";
import { RemovalContext } from "./removal-context";

describe("#704 undo opacity behind a revoked refund target (real HTTP/Prisma)", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  let app: INestApplication;
  let http: APIRequestContext;
  let f: Awaited<ReturnType<typeof refundFixture>>;
  let jwt: JwtService;

  const token = (userId: string) =>
    jwt.sign({ sub: userId, tenantId: f.tenantId, sv: 0 });
  const client = async (userId: string) =>
    request.newContext({
      baseURL: await app.getUrl(),
      extraHTTPHeaders: { Authorization: `Bearer ${token(userId)}` },
    });
  const undoUrl = (projectId: string, id: string) =>
    `/projects/${projectId}/expenses/${id}/refund-purpose`;
  const undo = async (
    who: APIRequestContext,
    id: string,
    expectedRevision: unknown,
    projectId = f.projectId,
  ) => {
    const response = await who.delete(undoUrl(projectId, id), {
      data: { expectedRevision },
    });
    return { status: response.status(), body: await response.text() };
  };
  const rows = async () =>
    JSON.stringify({
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
  /** Same owner, source project still visible, the renovation project revoked. */
  const revokeTarget = () =>
    db.user.update({
      where: { id: f.requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([f.projectId]),
        allowedProjectTypes: JSON.stringify(["PESSOAL"]),
        allowedModules: JSON.stringify(["expenses", "creditCards"]),
      },
    });

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
    jwt = new JwtService({
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
    });
  });
  beforeEach(async () => {
    f = await refundFixture(db, prisma, "refund-undo-opacity");
    http = await client(f.requester.id);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await http.dispose();
    await f.cleanup();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("revoked target: the exact revision and a stale odd revision answer identically to a non-existent source", async () => {
    const applied = await f.apply();
    expect(applied.revision).toBe(1);
    await revokeTarget();
    const before = await rows();

    const exact = await undo(http, f.source.id, applied.revision);
    const stale = await undo(http, f.source.id, applied.revision + 2);
    const absent = await undo(http, "does-not-exist", applied.revision);

    // Physical zero-write check first: a failing status assertion must not hide it.
    expect(await rows()).toBe(before);
    expect(absent.status).toBe(404);
    expect(exact).toEqual(absent);
    expect(stale).toEqual(absent);
  });

  it("revoked target: a far-off odd stale revision is never a 409 either", async () => {
    const applied = await f.apply();
    await revokeTarget();
    const before = await rows();
    const stale = await undo(http, f.source.id, applied.revision + 4);
    expect(await rows()).toBe(before);
    expect(stale.status).not.toBe(409);
    expect(stale.status).toBe(404);
  });

  it("visible target: drift still answers 409 and changes nothing", async () => {
    const applied = await f.apply();
    const before = await rows();
    const drift = await undo(http, f.source.id, applied.revision + 2);
    expect(drift.status).toBe(409);
    expect(await rows()).toBe(before);
  });

  it("visible target with a drifted target row: the exact revision is refused with 409 and nothing is written", async () => {
    const applied = await f.apply();
    await db.expense.update({
      where: { id: applied.targetExpenseId },
      data: { titulo: "drifted" },
    });
    const before = await rows();
    const drift = await undo(http, f.source.id, applied.revision);
    expect(drift.status).toBe(409);
    expect(await rows()).toBe(before);
  });

  it("missing source and a source of another project answer the same 404", async () => {
    const applied = await f.apply();
    const before = await rows();
    const absent = await undo(http, "does-not-exist", applied.revision);
    const wrongProject = await undo(
      http,
      f.source.id,
      applied.revision,
      f.targetProjectId,
    );
    expect(absent.status).toBe(404);
    expect(wrongProject).toEqual(absent);
    expect(await rows()).toBe(before);
  });

  it("replay after a successful undo is alreadyUndone for the authorized actor", async () => {
    const applied = await f.apply();
    const first = await undo(http, f.source.id, applied.revision);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({
      revision: 2,
      alreadyUndone: false,
    });
    const settled = await rows();
    const replay = await undo(http, f.source.id, applied.revision);
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({
      revision: 2,
      alreadyUndone: true,
    });
    expect(await rows()).toBe(settled);
  });

  it("an unexpected operational error stays a 500 and is never disguised as 404", async () => {
    const applied = await f.apply();
    await revokeTarget();
    const before = await rows();
    jest
      .spyOn(RemovalContext.prototype, "loadAllocations")
      .mockRejectedValue(new Error("synthetic operational failure"));
    const outcome = await undo(http, f.source.id, applied.revision);
    expect(outcome.status).toBe(500);
    jest.restoreAllMocks();
    expect(await rows()).toBe(before);
  });
});
