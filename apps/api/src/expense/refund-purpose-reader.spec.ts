/**
 * #704 reader RED — `GET /projects/:projectId/expenses/:id/refund-purpose` (contract frozen in
 * files/p704-o1-mapping.md v2.3.1 + files/p704-reader-design.md). The route does not exist yet:
 * every "[RED]" test fails on that fact (a route-not-found answer is neither the literal 200
 * bodies nor the opaque 404 body pinned here), never on a missing import or a TypeScript error.
 * "[control]" tests are green on the CURRENT code and pin the behavior the reader must not change.
 *
 * Real HTTP (global guards + privacy interceptor) over the real PrismaService and the disposable
 * test DB. Expectations are literals; nothing derives from the code under test. The clock is not
 * involved (no test depends on "now"), except guest expiry, which uses far past/future dates.
 *
 * Clause -> test map
 *  RD1 shape ................................ "RD1 …"
 *  RD2 visible assignment / after undo ....... "RD2 …"
 *  RD3 triangular bytes (+ revision, block) .. "RD3 …"
 *  RD4 opaque 404, zero writes, 401 .......... "RD4 …"
 *  RD5/RG5 per-clause literals ............... "RG5 …" (preview literal = control, reader = RED)
 *  RD6 coherence UNDO/PREPARE ................ "RD6 …"
 *  RD7 lost apply / undo recovery ............ "RD7 …"
 *  RD8/RG8 ONE tx (reserve declared), no reader DML, JWT write separate, counts . "RD8/RG8 …"
 *  RD9 interceptor leaves other payloads ..... "RD9 …"
 *  RD10/RG2 operational errors; injector inside refundCleanupFrom (control on DELETE + RED on GET) . "RD10/RG2 …"
 *  RD11 single visibility source, parity ..... "RD11 …"
 *  RD12 roomId validation .................... "RD12 …"
 *  RD13 financial readers ..................... existing suites (monthly-overview.refund-purpose, adversarial 50.000/12.345)
 *  RG1 opaque counterpart matrix ............. "RG1 …"
 *  RG3 assignment vs hasFeature .............. "RG3 …"
 *  RG4/RG7 deleted owned target, triangular .. "RG4 …" / "RG7 …"
 *  RG6 financing/marker/CFE of hidden target . "RG6 …"
 *  RG9 audience across GET/POST/DELETE ....... "RG9 …"
 *  RG10 summary O2 ........................... "RG10 …"
 *  RU1/RU2 ................................... expense.refund-purpose.undo-opacity.spec.ts (already green)
 * Pending until GREEN is measurable (not faked here): RG8 SELECT literals per loader with >900 ids,
 * the "remove OPAQUE_PROJECT_ACCESS from the GET" and shared-helper mutations.
 */
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  class LoggingPrismaClient extends actual.PrismaClient {
    constructor(options: Record<string, unknown> = {}) {
      super({ ...options, log: [{ emit: "event", level: "query" }] });
    }
  }
  return { ...actual, PrismaClient: LoggingPrismaClient };
});

import { ConflictException, HttpException, INestApplication, InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException, ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { APIRequestContext, request } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync } from "fs";
import { AsyncLocalStorage } from "async_hooks";
import { inspect } from "util";
import { join } from "path";
import {
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedPessoal,
  seedStatementImport,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { OPAQUE_PROJECT_ACCESS, ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { ExpenseController } from "./expense.controller";
import { ExpenseModule } from "./expense.module";
import { RefundPurposeService } from "./refund-purpose.service";
import { RefundPurposePrivacyInterceptor } from "./refund-purpose-privacy.interceptor";

const T = "reader-red";
const T2 = "reader-red-foreign";
const P = `${T}-personal`;
const R = `${T}-renovation`;
const C = `${T}-third`;
const H = `${T}-hidden`;
const SRC = "reader-source";
const OWNER = `${T}-owner`;
const VIS = `${T}-vis`;
const HID = `${T}-hid`;
const DATE = new Date("2026-09-10T00:00:00Z");
const OPAQUE_404 = {
  statusCode: 404,
  message: "Recurso não encontrado",
  error: "Not Found",
};
const CONFLICT_409 = {
  statusCode: 409,
  message:
    "Dados do crédito alterados ou incompatíveis. Confira os dados e faça uma nova prévia.",
  error: "Conflict",
};
const NEVER = { sourceExpenseId: SRC, assignment: null, actions: ["PREPARE"] };
const BLOCKED = { sourceExpenseId: SRC, assignment: null, actions: [] };
const SUMMARY_KEYS = [
  "allocationCents",
  "cardId",
  "cashFlowDate",
  "dataCompra",
  "dataPagamento",
  "importId",
  "roomId",
  "sourceExpenseId",
  "targetProjectId",
  "tipoDespesa",
];

describe("#704 refund purpose reader (RED, real HTTP/Prisma)", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const sql: string[] = [];
  let sentinels = 0;
  (prisma as any).$on("query", (e: { query: string; params: string }) => {
    if (e.params.includes("p704-sentinel")) {
      sentinels += 1;
      sql.push("SENTINEL");
    } else sql.push(e.query);
  });
  // A sentinel statement is issued last and awaited: once it is logged, every earlier statement is logged too.
  const flush = async () => {
    const seen = sentinels;
    await prisma.$queryRaw`SELECT ${`p704-sentinel-${seen + 1}`} AS s`;
    for (let waited = 0; sentinels === seen && waited < 2000; waited += 5) await new Promise((r) => setTimeout(r, 5));
    expect(sentinels).toBe(seen + 1);
  };
  // Every Prisma operation with the flag Prisma itself sets when it runs on a transaction client
  // (`runInTransaction`) and the ORIGIN of the call, taken from an AsyncLocalStorage that TEST-ONLY wrappers
  // set around the existing JwtStrategy.validate and RefundPurposeService methods. Nothing here is production code.
  type Op = { model?: string; action: string; tx: boolean; origin: string };
  const ops: Op[] = [];
  const origin = new AsyncLocalStorage<string>();
  const DML_ACTIONS = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "executeRaw", "executeRawUnsafe"];
  let inject: { model: string; action: string } | null = null;
  prisma.$use(async (params, next) => {
    const isSentinel = params.action === "queryRaw" && JSON.stringify(params.args).includes("p704-sentinel");
    if (!isSentinel)
      ops.push({ model: params.model, action: params.action, tx: params.runInTransaction === true, origin: origin.getStore() ?? "other" });
    return next(params);
  });
  prisma.$use(async (params, next) => {
    if (
      inject &&
      params.model === inject.model &&
      params.action === inject.action
    )
      throw new Error("injected-db-failure");
    return next(params);
  });
  let app: INestApplication;
  let jwt: JwtService;
  const clients = new Map<string, APIRequestContext>();
  let cardId: string;
  let importId: string;
  let cfeId: string;

  const as = async (userId: string) => {
    if (!clients.has(userId))
      clients.set(
        userId,
        await request.newContext({
          baseURL: await app.getUrl(),
          extraHTTPHeaders: {
            Authorization: `Bearer ${jwt.sign({ sub: userId, tenantId: T, sv: 0 })}`,
          },
        }),
      );
    return clients.get(userId)!;
  };
  const url = (projectId: string, id: string) =>
    `/projects/${projectId}/expenses/${id}/refund-purpose`;
  const shape = async (response: Awaited<ReturnType<APIRequestContext["get"]>>) => ({
    status: response.status(),
    text: await response.text(),
    headers: response.headers(),
  });
  const get = async (userId: string, id = SRC, projectId = P) =>
    shape(await (await as(userId)).get(url(projectId, id)));
  const post = async (
    userId: string,
    data: unknown,
    id = SRC,
    projectId = P,
  ) => shape(await (await as(userId)).post(url(projectId, id), { data }));
  const del = async (userId: string, data: unknown, id = SRC, projectId = P) =>
    shape(await (await as(userId)).delete(url(projectId, id), { data }));
  const plain = async (userId: string) =>
    shape(await (await as(userId)).get(`/projects/${P}/expenses/${SRC}`));
  const json = (r: { text: string }) => JSON.parse(r.text);
  const previewBody = (targetProjectId = R, roomId: string | null = null) => ({
    mode: "preview",
    targetProjectId,
    roomId,
  });
  const applyAs = async (userId = OWNER, roomId: string | null = null) => {
    const preview = json(await post(userId, previewBody(R, roomId)));
    const applied = await post(userId, {
      mode: "apply",
      targetProjectId: R,
      roomId,
      expectedRevision: preview.revision,
      expectedFingerprint: preview.fingerprint,
    });
    expect(applied.status).toBe(201);
    return json(applied);
  };
  const undoAs = async (userId = OWNER) => {
    const row = await db.expense.findUniqueOrThrow({ where: { id: SRC } });
    const undone = await del(userId, { expectedRevision: row.refundPurposeRevision });
    expect(undone.status).toBe(200);
    return json(undone);
  };
  const state = async () =>
    JSON.stringify({
      expenses: await db.expense.findMany({
        where: { tenantId: { in: [T, T2] } },
        orderBy: { id: "asc" },
      }),
      cash: await db.cashFlowEntry.findMany({
        where: { tenantId: T },
        orderBy: { id: "asc" },
      }),
      allocations: await db.rateioAllocation.findMany({
        where: { tenantId: T },
        orderBy: { id: "asc" },
      }),
      settlements: await db.crossProjectSettlement.findMany({ where: { tenantId: T } }),
      ledger: await db.importedInvoiceLiquidation.findMany({ where: { tenantId: T } }),
      tenants: await db.tenant.findMany({
        where: { id: { in: [T, T2] } },
        orderBy: { id: "asc" },
      }),
    });
  const peer = (projectId: string, data: Record<string, unknown> = {}, tenantId = T) =>
    db.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: "OUTROS",
        valor: 100,
        valorTotal: 100,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        ...data,
      },
    });
  const patchSource = (data: Record<string, unknown>) =>
    db.expense.update({ where: { id: SRC }, data });
  const patchCfe = (data: Record<string, unknown>) =>
    db.cashFlowEntry.update({ where: { id: cfeId }, data });
  const settlement = (sourceExpenseId: string, targetExpenseId: string) =>
    db.crossProjectSettlement.create({
      data: {
        tenantId: T,
        sourceExpenseId,
        targetExpenseId,
        parcelaIndex: 0,
        realValor: 1,
        plannedValor: 1,
        plannedStatus: "PLANEJADO",
      },
    });
  const allocation = (sourceExpenseId: string, targetExpenseId: string) =>
    db.rateioAllocation.create({
      data: {
        tenantId: T,
        sourceExpenseId,
        targetExpenseId,
        allocation: 100,
        plannedStatus: "PLANEJADO",
      },
    });
  const ledger = async (paymentExpenseId: string, purchaseExpenseId: string) => {
    const account = await seedBankAccount(db, {
      tenantId: T,
      projectId: P,
      last4: "7777",
    });
    const statement = await seedStatementImport(db, {
      tenantId: T,
      accountId: account.id,
      id: `${T}-statement`,
    });
    return db.importedInvoiceLiquidation.create({
      data: {
        tenantId: T,
        paymentExpenseId,
        purchaseExpenseId,
        importId: statement,
        cashFlowEntryId: cfeId,
        cardId,
        prevStatus: "PLANEJADO",
        entryValorCents: 1,
        dueMonth: "2026-09",
      },
    });
  };
  const grants = (projects: string[], types: string[], modules = ["expenses", "creditCards"]) => ({
    allowedProjects: JSON.stringify(projects),
    allowedProjectTypes: JSON.stringify(types),
    allowedModules: JSON.stringify(modules),
  });

  const wipe = async () => {
    await db.floorPlanMarker.deleteMany({ where: { floorPlan: { tenantId: T } } });
    await db.floorPlan.deleteMany({ where: { tenantId: T } });
    await db.financingInstallment.deleteMany({ where: { tenantId: T } });
    await db.financing.deleteMany({ where: { tenantId: T } });
    // rows a test moved to the foreign tenant come back so resetTenant removes them in FK order
    for (const model of [
      db.expense,
      db.creditCardStatementImport,
      db.creditCard,
      db.project,
    ] as any[])
      await model.updateMany({ where: { tenantId: T2 }, data: { tenantId: T } });
    await db.tenant.deleteMany({ where: { id: T2 } });
    await db.cashFlowEntry.updateMany({
      where: { tenantId: T },
      data: { budgetAllocationId: null },
    });
    await db.budgetAllocation.deleteMany({ where: { tenantId: T } });
    await db.room.deleteMany({ where: { project: { tenantId: T } } });
    await db.user.deleteMany({ where: { tenantId: T } });
    await resetTenant(db, T);
  };

  const seed = async () => {
    await wipe();
    await seedPessoal(db, { tenantId: T, projectId: P });
    await db.tenant.create({ data: { id: T2, name: "reader foreign" } });
    for (const [id, type] of [
      [R, "REFORMA"],
      [C, "CASA"],
      [H, "CASA"],
    ] as const)
      await db.project.create({ data: { id, tenantId: T, type, name: id } });
    const base = { tenantId: T, lastActivityAt: new Date() };
    await db.user.create({
      data: { id: OWNER, role: "OWNER", username: "owner", name: "Owner", ...base },
    });
    await db.user.create({
      data: {
        id: VIS,
        role: "USER",
        username: "vis",
        name: "Vis",
        ...base,
        ...grants([P, R, C], ["PESSOAL", "REFORMA", "CASA"]),
      },
    });
    await db.user.create({
      data: {
        id: HID,
        role: "USER",
        username: "hid",
        name: "Hid",
        ...base,
        ...grants([P], ["PESSOAL"]),
      },
    });
    const card = await seedCardWithClosingDue(db, {
      tenantId: T,
      projectId: P,
      last4: "1234",
    });
    cardId = card.id;
    importId = (
      await db.creditCardStatementImport.create({
        data: {
          tenantId: T,
          cardId,
          source: "CSV_GENERIC",
          periodLabel: "2026-09",
          status: "COMPLETED",
        },
      })
    ).id;
    await db.expense.create({
      data: {
        id: SRC,
        tenantId: T,
        projectId: P,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: -12345,
        valorTotal: -12345,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PAGO",
        origin: "import",
        cardLast4: card.last4,
        importId,
        externalId: "reader-refund",
        dataPagamento: DATE,
        dataCompra: new Date("2026-08-26T00:00:00Z"),
      },
    });
    cfeId = (
      await db.cashFlowEntry.create({
        data: {
          tenantId: T,
          projectId: P,
          expenseId: SRC,
          valor: -12345,
          tipo: "DESPESA",
          data: DATE,
          categoria: "Material",
          formaPagamento: "CARTAO_CREDITO",
          status: "PAGO",
        },
      })
    ).id;
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
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalInterceptors(new RefundPurposePrivacyInterceptor(prisma));
    await app.listen(0, "127.0.0.1");
    jwt = new JwtService({ secret: process.env.JWT_SECRET || "dev-secret-change-me" });
  });
  const trace = (proto: object, name: string, label: string) => {
    const original = (proto as Record<string, unknown>)[name];
    if (typeof original !== "function") return;
    jest.spyOn(proto as never, name as never).mockImplementation(function (this: unknown, ...args: unknown[]) {
      return origin.run(label, () => (original as (...a: unknown[]) => unknown).apply(this, args));
    } as never);
  };
  beforeEach(async () => {
    await seed();
    trace(JwtStrategy.prototype, "validate", "jwt");
    trace(ModulesGuard.prototype, "canActivate", "guard:modules");
    trace(ProjectAccessGuard.prototype, "canActivate", "guard:project-access");
    trace(RefundPurposeService.prototype, "execute", "service:execute");
    trace(RefundPurposeService.prototype, "undo", "service:undo");
    trace(RefundPurposeService.prototype, READER_METHOD, "service:read");
  });
  afterEach(async () => {
    inject = null;
    jest.restoreAllMocks();
    for (const client of clients.values()) await client.dispose();
    clients.clear();
  });
  afterAll(async () => {
    await wipe();
    await app.close();
    await prisma.$disconnect();
    await db.$disconnect();
  });

  // ------------------------------------------------------------------ RD1
  describe("RD1 shape", () => {
    it("[RED] RD1 an eligible never-assigned source answers exactly the literal body", async () => {
      const response = await get(VIS);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual(NEVER);
      expect(Object.keys(json(response)).sort()).toEqual(["actions", "assignment", "sourceExpenseId"]);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });
  });

  // ------------------------------------------------------------------ RD2
  describe("RD2 visible assignment", () => {
    it("[RED] RD2 the assignment carries the odd DB revision, the apply summary and only UNDO", async () => {
      const applied = await applyAs();
      const response = await get(VIS);
      expect(response.status).toBe(200);
      const body = json(response);
      const row = await db.expense.findUniqueOrThrow({ where: { id: SRC } });
      expect(row.refundPurposeRevision).toBe(1);
      expect(body).toEqual({
        sourceExpenseId: SRC,
        assignment: { revision: 1, summary: applied.summary },
        actions: ["UNDO"],
      });
      expect(Object.keys(body.assignment).sort()).toEqual(["revision", "summary"]);
      expect(Object.keys(body.assignment.summary).sort()).toEqual(SUMMARY_KEYS);
      expect("roomId" in body.assignment.summary).toBe(true);
      expect(body.assignment.summary.roomId).toBeNull();
      expect(body.assignment.summary).toMatchObject({
        allocationCents: -12345,
        cashFlowDate: "2026-09-10T00:00:00.000Z",
        dataPagamento: "2026-09-10T00:00:00.000Z",
        dataCompra: "2026-08-26T00:00:00.000Z",
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        targetProjectId: R,
      });
    });

    it("[RED] RD2 a real room is reported as a string and the key is never omitted", async () => {
      const room = await db.room.create({ data: { projectId: R, name: "Sala" } });
      const applied = await applyAs(OWNER, room.id);
      const reader = await get(VIS);
      expect(reader.status).toBe(200);
      const body = json(reader);
      expect(body.assignment.summary.roomId).toBe(room.id);
      expect(body.assignment.summary).toEqual(applied.summary);
    });

    it("[RED] RD2 after undo the reader answers the literal never-assigned body, without a revision", async () => {
      await applyAs();
      await undoAs();
      const response = await get(VIS);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual(NEVER);
      expect(response.text).not.toContain("revision");
    });
  });

  // ------------------------------------------------------------------ RD3 / RG7
  describe("RD3 triangular bytes", () => {
    type World = "hidden-assigned" | "never" | "hidden-participant" | "undone-history" | "hidden-assigned-rev3";
    const build = async (world: World, block: boolean) => {
      await seed();
      if (world === "hidden-assigned") await applyAs();
      if (world === "hidden-assigned-rev3") {
        await applyAs();
        await undoAs();
        await applyAs();
      }
      if (world === "undone-history") {
        await applyAs();
        await undoAs();
      }
      if (world === "hidden-participant") await allocation(SRC, (await peer(H)).id);
      if (block) await settlement(SRC, (await peer(P)).id);
      return get(HID);
    };
    const worlds: World[] = ["hidden-assigned", "hidden-assigned-rev3", "never", "hidden-participant", "undone-history"];

    it.each([false, true])(
      "[RED] RD3 the hidden viewer gets identical bytes in every world (visible block: %s)",
      async (block) => {
        const expected = block ? BLOCKED : NEVER;
        const texts: string[] = [];
        for (const world of worlds) {
          const response = await build(world, block);
          expect({ world, status: response.status }).toEqual({ world, status: 200 });
          expect({ world, body: json(response) }).toEqual({ world, body: expected });
          texts.push(response.text);
        }
        expect(new Set(texts).size).toBe(1);
      },
    );

    it("[control] RD3 the fixture really hides the target from the hidden viewer and shows it to the owner", async () => {
      await applyAs();
      const hidden = json(await plain(HID));
      const owner = json(await plain(OWNER));
      expect(hidden.linkedExpenseId).toBeNull();
      expect(typeof owner.linkedExpenseId).toBe("string");
    });
  });

  // ------------------------------------------------------------------ RD4
  describe("RD4 opaque 404", () => {
    it("[RED] RD4 every service-level absence answers the same literal opaque 404 and writes nothing", async () => {
      // The fixture patches below bump `updatedAt` on their own, so "writes nothing" is proven per request.
      const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
        const snapshot = await state();
        const result = await run();
        expect(await state()).toBe(snapshot);
        return result;
      };
      const cases: Array<[string, () => Promise<{ status: number; text: string }>]> = [
        ["absent id", () => quiet(() => get(VIS, "reader-nope"))],
        ["other project in the URL", () => quiet(() => get(VIS, SRC, C))],
      ];
      for (const [label, run] of cases) {
        const response = await run();
        expect({ label, status: response.status }).toEqual({ label, status: 404 });
        expect({ label, body: json(response) }).toEqual({ label, body: OPAQUE_404 });
      }
      await patchSource({ deletedAt: DATE });
      expect(json(await quiet(() => get(VIS)))).toEqual(OPAQUE_404);
      await patchSource({ deletedAt: null, tenantId: T2 });
      expect(json(await quiet(() => get(VIS)))).toEqual(OPAQUE_404);
      await patchSource({ tenantId: T });
      await db.creditCardStatementImport.update({ where: { id: importId }, data: { deletedAt: DATE } });
      expect(json(await quiet(() => get(VIS)))).toEqual(OPAQUE_404);
      await db.creditCardStatementImport.update({ where: { id: importId }, data: { deletedAt: null } });
      await db.creditCard.update({ where: { id: cardId }, data: { deletedAt: DATE } });
      expect(json(await quiet(() => get(VIS)))).toEqual(OPAQUE_404);
      await db.creditCard.update({ where: { id: cardId }, data: { deletedAt: null } });
    });

    it("[RED] RD4 a source project without the credit-card module answers the opaque 404", async () => {
      await db.project.update({ where: { id: P }, data: { type: "CASA" } });
      const response = await get(VIS);
      expect(response.status).toBe(404);
      expect(json(response)).toEqual(OPAQUE_404);
    });

    it("[RED] RD4 a viewer outside allowedProjects gets 404 (never 403) and no token gets 401", async () => {
      await db.user.update({ where: { id: HID }, data: grants([R], ["PESSOAL", "REFORMA"]) });
      const outside = await get(HID);
      expect(outside.status).toBe(404);
      const anonymous = await request.newContext({ baseURL: await app.getUrl() });
      const noAuth = await anonymous.get(url(P, SRC));
      expect(noAuth.status()).toBe(401);
      await anonymous.dispose();
    });
  });

  // ------------------------------------------------------------------ RG5 / RD5
  describe("RG5 per-clause literals", () => {
    type Reader = "BLOCKED" | "NOT_FOUND";
    const other = async () => (await peer(C)).id;
    const cases: Array<[string, () => Promise<unknown>, 404 | 409, Reader]> = [
      ["no importId", () => patchSource({ importId: null }), 409, "BLOCKED"],
      ["batch not COMPLETED", () => db.creditCardStatementImport.update({ where: { id: importId }, data: { status: "PENDING" } }), 409, "BLOCKED"],
      ["batch absent", () => db.creditCardStatementImport.update({ where: { id: importId }, data: { deletedAt: DATE } }), 404, "NOT_FOUND"],
      ["card absent", () => db.creditCard.update({ where: { id: cardId }, data: { deletedAt: DATE } }), 404, "NOT_FOUND"],
      ["non-negative total", async () => { await patchSource({ valor: 5, valorTotal: 5 }); await patchCfe({ valor: 5 }); }, 409, "BLOCKED"],
      ["amount times quantity differs", () => patchSource({ quantidade: 2 }), 409, "BLOCKED"],
      ["unknown category", () => patchSource({ tipoDespesa: "NAO_EXISTE" }), 409, "BLOCKED"],
      ["neutral category", () => patchSource({ tipoDespesa: "MOVIMENTACAO_INTERNA" }), 409, "BLOCKED"],
      ["investment category", () => patchSource({ tipoDespesa: "INVESTIMENTOS" }), 409, "BLOCKED"],
      ["status not PAGO", () => patchSource({ status: "PLANEJADO" }), 409, "BLOCKED"],
      ["fortnightly form", () => patchSource({ formaPagamento: "QUINZENAL" }), 409, "BLOCKED"],
      ["installment form", () => patchSource({ formaPagamento: "PARCELADO" }), 409, "BLOCKED"],
      ["origin bank", () => patchSource({ origin: "bank" }), 409, "BLOCKED"],
      ["no externalId", () => patchSource({ externalId: null }), 409, "BLOCKED"],
      ["card last4 differs", () => patchSource({ cardLast4: "9999" }), 409, "BLOCKED"],
      ["bankLast4", () => patchSource({ bankLast4: "1234" }), 409, "BLOCKED"],
      ["accountId", async () => { const a = await db.bankAccount.create({ data: { tenantId: T, projectId: P, institution: "OUTROS", nickname: "r", last4: "5555" } }); await patchSource({ accountId: a.id }); }, 409, "BLOCKED"],
      ["recorrente", () => patchSource({ recorrente: true }), 409, "BLOCKED"],
      ["recurrenceKey", () => patchSource({ recurrenceKey: "k" }), 409, "BLOCKED"],
      ["recorrenciaFim", () => patchSource({ recorrenciaFim: DATE }), 409, "BLOCKED"],
      ["seriesKey", () => patchSource({ seriesKey: "s" }), 409, "BLOCKED"],
      ["plannedExpenseId (active visible expense)", async () => patchSource({ plannedExpenseId: await other() }), 409, "BLOCKED"],
      ["settledByExpenseId (active visible expense)", async () => patchSource({ settledByExpenseId: await other() }), 409, "BLOCKED"],
      ["settlesInvoiceKey", () => patchSource({ settlesInvoiceKey: "1234:2026-09" }), 409, "BLOCKED"],
      ["quantidadeParcela", () => patchSource({ quantidadeParcela: 2 }), 409, "BLOCKED"],
      ["dataInicioParcela", () => patchSource({ dataInicioParcela: DATE }), 409, "BLOCKED"],
      ["paidParcelas", () => patchSource({ paidParcelas: "[0]" }), 409, "BLOCKED"],
      ["installmentDateOverrides", () => patchSource({ installmentDateOverrides: "{}" }), 409, "BLOCKED"],
      ["invoiceUndoState", () => patchSource({ invoiceUndoState: "PROCESSED_NONE" }), 409, "BLOCKED"],
      ["invoiceUndoDueMonth", () => patchSource({ invoiceUndoDueMonth: "2026-09" }), 409, "BLOCKED"],
      ["invoiceUndoParcelaCount", () => patchSource({ invoiceUndoParcelaCount: 1 }), 409, "BLOCKED"],
      ["invoiceUndoTrailVersion", () => patchSource({ invoiceUndoTrailVersion: 1 }), 409, "BLOCKED"],
      ["invoiceUndoCardId", () => patchSource({ invoiceUndoCardId: cardId }), 409, "BLOCKED"],
      ["no dataPagamento", () => patchSource({ dataPagamento: null }), 409, "BLOCKED"],
      ["no live cash flow", () => patchCfe({ deletedAt: DATE }), 409, "BLOCKED"],
      ["two live cash flows", async () => { const { id, ...copy } = await db.cashFlowEntry.findUniqueOrThrow({ where: { id: cfeId } }); await db.cashFlowEntry.create({ data: copy }); }, 409, "BLOCKED"],
      ["cash flow value differs", () => patchCfe({ valor: -1 }), 409, "BLOCKED"],
      ["cash flow still planned", () => patchCfe({ status: "PLANEJADO" }), 409, "BLOCKED"],
      ["cash flow is income", () => patchCfe({ tipo: "RECEITA" }), 409, "BLOCKED"],
      ["cash flow date differs", () => patchCfe({ data: new Date("2026-09-11T00:00:00Z") }), 409, "BLOCKED"],
      ["cash flow of another project", () => patchCfe({ projectId: C }), 409, "BLOCKED"],
      ["cash flow with receipt", async () => { const r = await db.receipt.create({ data: { projectId: P, tenantId: T, valor: 1, data: DATE, tipo: "DESPESA" } }); await patchCfe({ receiptId: r.id }); }, 409, "BLOCKED"],
      ["cash flow with budget", async () => { const b = await db.budgetAllocation.create({ data: { tenantId: T, sourceProjectId: P, targetProjectId: R, valor: 1, mes: "2026-09" } }); await patchCfe({ budgetAllocationId: b.id }); }, 409, "BLOCKED"],
      ["settlement with an active visible expense", async () => { await settlement(SRC, await other()); }, 409, "BLOCKED"],
      ["ledger claim with an active visible expense", async () => { await ledger(await other(), SRC); }, 409, "BLOCKED"],
      ["financing installment on the source", async () => { const f = await db.financing.create({ data: { projectId: P, tenantId: T, valorTotalFinanciado: 1, taxaJurosMensalBps: 1, prazoMeses: 1, dataPrimeiraParcela: DATE, diaVencimento: 10 } }); await db.financingInstallment.create({ data: { financingId: f.id, projectId: P, tenantId: T, numeroParcela: 1, dataVencimento: DATE, valorPrevisto: 1, saldoDevedorPrevisto: 1, expenseId: SRC } }); }, 409, "BLOCKED"],
      ["floor-plan marker on the source", async () => { const fp = await db.floorPlan.create({ data: { projectId: P, tenantId: T, name: "r", imageUrl: "x" } }); await db.floorPlanMarker.create({ data: { floorPlanId: fp.id, expenseId: SRC, bounds: "{}" } }); }, 409, "BLOCKED"],
      ["linkedExpenseId without an edge (active visible expense)", async () => patchSource({ linkedExpenseId: await other() }), 409, "BLOCKED"],
      ["ordinary allocation from the source (active visible expense)", async () => { await allocation(SRC, await other()); }, 409, "BLOCKED"],
      ["incoming pointer from an active visible expense", async () => { await db.expense.update({ where: { id: await other() }, data: { linkedExpenseId: SRC } }); }, 409, "BLOCKED"],
    ];

    it("[control] RG5 baseline: the eligible source previews with 200 through HTTP", async () => {
      const response = await post(VIS, previewBody());
      expect(response.status).toBe(201);
      expect(json(response)).toMatchObject({ mode: "preview", revision: 0 });
    });

    it.each(cases)("[control] RG5 %s: the current preview answers the pinned literal", async (label, mutate, previewStatus) => {
      await mutate();
      const preview = await post(VIS, previewBody());
      expect({ label, status: preview.status }).toEqual({ label, status: previewStatus });
      expect(json(preview)).toEqual(previewStatus === 404 ? OPAQUE_404 : CONFLICT_409);
    });

    it.each(cases)("[RED] RG5 %s: the reader answers the pinned literal", async (label, mutate, _previewStatus, reader) => {
      await mutate();
      const response = await get(VIS);
      if (reader === "NOT_FOUND") {
        expect({ label, status: response.status }).toEqual({ label, status: 404 });
        expect(json(response)).toEqual(OPAQUE_404);
      } else {
        expect({ label, status: response.status }).toEqual({ label, status: 200 });
        expect(json(response)).toEqual(BLOCKED);
      }
    });

    it("[RED] RG5 destination equal to the source project stays a preview-only conflict; the reader still offers PREPARE", async () => {
      const preview = await post(VIS, previewBody(P));
      expect(preview.status).toBe(409);
      expect(json(preview)).toEqual(CONFLICT_409);
      expect(json(await get(VIS))).toEqual(NEVER);
    });

    // The source's OWN fact: a soft-deleted cash-flow history row. Literals copied from the RG5 plan characterization
    // ("a deleted history row of the same project does not block; one of another project does").
    const deletedHistory = async (projectId: string) => {
      const { id, ...copy } = await db.cashFlowEntry.findUniqueOrThrow({ where: { id: cfeId } });
      await db.cashFlowEntry.create({ data: { ...copy, projectId, deletedAt: DATE } });
    };
    const historyCases: Array<[string, string, 201 | 409]> = [
      ["a deleted history cash flow of the SAME project", P, 201],
      ["a deleted history cash flow of ANOTHER project", C, 409],
    ];

    it.each(historyCases)("[control] RG5 %s: the current preview answers the pinned literal", async (_label, projectId, status) => {
      await deletedHistory(projectId);
      const preview = await post(VIS, previewBody());
      expect(preview.status).toBe(status);
      expect(json(preview)).toEqual(status === 201 ? expect.objectContaining({ mode: "preview", revision: 0 }) : CONFLICT_409);
    });

    it.each(historyCases)("[RED] RG5 %s: the reader keeps the source's own fact (same project: PREPARE, other project: no action)", async (_label, projectId, status) => {
      await deletedHistory(projectId);
      const response = await get(VIS);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual(status === 201 ? NEVER : BLOCKED);
    });
  });

  // ------------------------------------------------------------------ RG1
  describe("RG1 opaque counterpart matrix", () => {
    type Variant = "foreign-tenant" | "deleted-expense" | "deleted-project" | "foreign-project" | "no-acl" | "no-feature" | "dangling";
    const variants: Variant[] = ["foreign-tenant", "deleted-expense", "deleted-project", "foreign-project", "no-acl", "no-feature", "dangling"];
    type End =
      | "allocation" | "allocation-in" | "settlement" | "settlement-in" | "ledger-purchase" | "ledger-payment"
      | "incoming-linked" | "incoming-planned" | "incoming-settledBy" | "planned" | "settledBy" | "linked";
    const ends: End[] = [
      "allocation", "allocation-in", "settlement", "settlement-in", "ledger-purchase", "ledger-payment",
      "incoming-linked", "incoming-planned", "incoming-settledBy", "planned", "settledBy", "linked",
    ];
    const makePeer = async (variant: Variant | "active") => {
      switch (variant) {
        case "active":
          return peer(C);
        case "foreign-tenant":
          return peer(C, {}, T2);
        case "deleted-expense":
          return peer(C, { deletedAt: DATE });
        case "deleted-project": {
          await db.project.create({ data: { id: `${T}-deleted`, tenantId: T, type: "CASA", name: "d", deletedAt: DATE } });
          return peer(`${T}-deleted`);
        }
        case "foreign-project": {
          await db.project.create({ data: { id: `${T}-fp`, tenantId: T2, type: "CASA", name: "f" } });
          return peer(`${T}-fp`);
        }
        case "no-acl":
          return peer(H);
        case "no-feature": {
          await db.project.create({ data: { id: `${T}-plantas`, tenantId: T, type: "PLANTAS", name: "pl" } });
          return peer(`${T}-plantas`);
        }
        case "dangling":
          return { id: "reader-dangling" };
      }
    };
    const attach = async (end: End, id: string) => {
      switch (end) {
        case "allocation": await allocation(SRC, id); return;
        case "allocation-in": await allocation(id, SRC); return;
        case "settlement": await settlement(SRC, id); return;
        case "settlement-in": await settlement(id, SRC); return;
        case "ledger-purchase": await ledger(id, SRC); return;
        case "ledger-payment": await ledger(SRC, id); return;
        case "incoming-linked": await db.expense.update({ where: { id }, data: { linkedExpenseId: SRC } }); return;
        case "incoming-planned": await db.expense.update({ where: { id }, data: { plannedExpenseId: SRC } }); return;
        case "incoming-settledBy": await db.expense.update({ where: { id }, data: { settledByExpenseId: SRC } }); return;
        case "planned": await patchSource({ plannedExpenseId: id }); return;
        case "settledBy": await patchSource({ settledByExpenseId: id }); return;
        case "linked": await patchSource({ linkedExpenseId: id }); return;
      }
    };
    const viewerFor = (variant: Variant | "active") => (variant === "no-feature" ? OWNER : VIS);
    const combos: Array<[Variant, End]> = variants.flatMap((v) =>
      ends
        .filter((e) => (v === "dangling" ? e === "linked" : true))
        .map((e) => [v, e] as [Variant, End]),
    );

    it.each(combos)("[RED] RG1 a %s counterpart at the %s end is discarded: the literal never-assigned body", async (variant, end) => {
      const counterpart = await makePeer(variant);
      await attach(end, counterpart.id);
      const response = await get(viewerFor(variant));
      expect({ variant, end, status: response.status }).toEqual({ variant, end, status: 200 });
      expect({ variant, end, body: json(response) }).toEqual({ variant, end, body: NEVER });
    });

    it.each(ends)("[control] RG1 the current preview refuses with 409 an ACTIVE counterpart at the %s end", async (end) => {
      const counterpart = await makePeer("active");
      await attach(end, counterpart.id);
      const preview = await post(VIS, previewBody());
      expect(preview.status).toBe(409);
      expect(json(preview)).toEqual(CONFLICT_409);
    });

    it.each(ends)("[RED] RG1 control: an ACTIVE counterpart at the %s end blocks (actions [])", async (end) => {
      const counterpart = await makePeer("active");
      await attach(end, counterpart.id);
      const response = await get(VIS);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual(BLOCKED);
    });
  });

  // ------------------------------------------------------------------ RG3 / RD11
  describe("RG3/RD11 assignment visibility vs hasFeature", () => {
    it("[RED] RG3 target reachable by canUse but without the expenses feature: assignment present, actions [], DELETE still 404", async () => {
      const applied = await applyAs();
      await db.project.update({ where: { id: R }, data: { type: "PLANTAS" } });
      const via = json(await plain(OWNER));
      expect(typeof via.linkedExpenseId).toBe("string");
      const response = await get(OWNER);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual({
        sourceExpenseId: SRC,
        assignment: { revision: 1, summary: applied.summary },
        actions: [],
      });
      const undone = await del(OWNER, { expectedRevision: 1 });
      expect(undone.status).toBe(404);
    });

    it("[RED] RG3 target with an ACL denial: assignment null and linkedExpenseId null on the interceptor side", async () => {
      await applyAs();
      const via = json(await plain(HID));
      expect(via.linkedExpenseId).toBeNull();
      expect(json(await get(HID))).toEqual(NEVER);
    });

    it("[RED] RD11 parity on the target axis, and a visible target next to a hidden participant keeps the assignment", async () => {
      await applyAs();
      await allocation(SRC, (await peer(H)).id);
      await db.user.update({ where: { id: VIS }, data: grants([P, R], ["PESSOAL", "REFORMA"]) });
      const reader = await get(VIS);
      expect(reader.status).toBe(200);
      const body = json(reader);
      const via = json(await plain(VIS));
      expect(typeof via.linkedExpenseId).toBe("string");
      expect(body.assignment).not.toBeNull();
      expect(body.assignment.revision).toBe(1);
      expect(body.actions).toEqual([]);
    });

    it("[control] RD11 the visibility predicate has one source: no module under src/expense defines or re-exports it", () => {
      const dir = __dirname;
      const offenders: string[] = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".ts") || name.endsWith(".spec.ts")) continue;
        const text = readFileSync(join(dir, name), "utf8");
        if (/export\s+(async\s+)?function\s+(canUseInlineProject|resolveInlineProject)\b/.test(text)) offenders.push(name);
        if (/export\s*\{[^}]*\b(canUseInlineProject|resolveInlineProject)\b[^}]*\}/.test(text)) offenders.push(name);
      }
      expect(offenders).toEqual([]);
      const interceptor = readFileSync(join(dir, "refund-purpose-privacy.interceptor.ts"), "utf8");
      expect(interceptor).toMatch(/canUseInlineProject[\s\S]*from\s+"\.\.\/bank-account\/inline-expenses"/);
    });
  });

  // ------------------------------------------------------------------ RG4
  describe("RG4 deleted owned target", () => {
    const variants = ["live-usable-project", "deleted-project", "no-acl"] as const;
    const withOther = [false, true];
    const cases = variants.flatMap((v) => withOther.map((o) => [v, o] as const));

    const deleteTarget = async (variant: (typeof variants)[number], pointer: boolean) => {
      const applied = await applyAs();
      await db.expense.update({ where: { id: applied.targetExpenseId }, data: { deletedAt: DATE } });
      if (variant === "deleted-project") await db.project.update({ where: { id: R }, data: { deletedAt: DATE } });
      if (pointer) await db.expense.update({ where: { id: (await peer(C)).id }, data: { linkedExpenseId: applied.targetExpenseId } });
      return variant === "no-acl" ? HID : VIS;
    };

    it.each(cases)("[RED] RG4 %s (pointer from another expense: %s) is byte-equal to the never-assigned body", async (variant, pointer) => {
      const viewer = await deleteTarget(variant, pointer);
      const response = await get(viewer);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual(NEVER);
    });

    it("[control] RG4 the existing POST preview and DELETE answers for a deleted owned target are pinned unchanged", async () => {
      const applied = await applyAs();
      await db.expense.update({ where: { id: applied.targetExpenseId }, data: { deletedAt: DATE } });
      const preview = await post(VIS, previewBody());
      const undone = await del(VIS, { expectedRevision: 1 });
      expect({ preview: preview.status, undo: undone.status }).toEqual({ preview: 409, undo: 409 });
    });
  });

  describe("RG7 five-way triangular with and without a visible block", () => {
    it.each([false, true])("[RED] RG7 hidden-assigned, never, hidden-participant, deleted-target and dangling pointer are byte-identical (block: %s)", async (block) => {
      const texts: string[] = [];
      const run = async (label: string, setup: () => Promise<void>, revision?: number) => {
        await seed();
        await setup();
        if (revision !== undefined) await patchSource({ refundPurposeRevision: revision });
        if (block) await settlement(SRC, (await peer(P)).id);
        const response = await get(HID);
        expect({ label, status: response.status, body: json(response) }).toEqual({
          label,
          status: 200,
          body: block ? BLOCKED : NEVER,
        });
        texts.push(response.text);
      };
      await run("hidden-assigned", async () => { await applyAs(); });
      await run("never", async () => undefined);
      await run("hidden-participant", async () => { await allocation(SRC, (await peer(H)).id); });
      await run("deleted-target", async () => {
        const applied = await applyAs();
        await db.expense.update({ where: { id: applied.targetExpenseId }, data: { deletedAt: DATE } });
      });
      await run("dangling-pointer", async () => { await patchSource({ linkedExpenseId: "reader-dangling" }); });
      await run("never, even revision > 0", async () => undefined, 4);
      expect(new Set(texts).size).toBe(1);
    });
  });

  // ------------------------------------------------------------------ RG6
  describe("RG6 financing / marker / cash flow", () => {
    it("[RED] RG6 financing and marker on a hidden target do not influence the body and no ACL table is read", async () => {
      const applied = await applyAs();
      const financing = await db.financing.create({ data: { projectId: R, tenantId: T, valorTotalFinanciado: 1, taxaJurosMensalBps: 1, prazoMeses: 1, dataPrimeiraParcela: DATE, diaVencimento: 10 } });
      await db.financingInstallment.create({ data: { financingId: financing.id, projectId: R, tenantId: T, numeroParcela: 1, dataVencimento: DATE, valorPrevisto: 1, saldoDevedorPrevisto: 1, expenseId: applied.targetExpenseId } });
      const plan = await db.floorPlan.create({ data: { projectId: R, tenantId: T, name: "r", imageUrl: "x" } });
      await db.floorPlanMarker.create({ data: { floorPlanId: plan.id, expenseId: applied.targetExpenseId, bounds: "{}" } });
      await flush();
      sql.length = 0;
      const response = await get(HID);
      await flush();
      expect(response.status).toBe(200);
      expect(json(response)).toEqual(NEVER);
      const tables = sql.filter((q) => /^SELECT/.test(q)).map((q) => (q.match(/FROM `main`\.`(\w+)`/) ?? [])[1]);
      expect(tables).not.toContain("financings");
      expect(tables).not.toContain("floor_plans");
    });
  });

  // ------------------------------------------------------------------ RD6 / RD7
  describe("RD6 coherence and RD7 recovery", () => {
    it("[RED] RD6 UNDO in actions means DELETE with the reported revision succeeds", async () => {
      await applyAs();
      const reader = await get(VIS);
      expect(reader.status).toBe(200);
      const body = json(reader);
      expect(body.actions).toEqual(["UNDO"]);
      const undone = await del(VIS, { expectedRevision: body.assignment.revision });
      expect(undone.status).toBe(200);
      expect(json(undone)).toEqual({ revision: 2, alreadyUndone: false });
    });

    it("[RED] RD6 a visible assignment with drift keeps the assignment, drops UNDO, and DELETE answers 409", async () => {
      const applied = await applyAs();
      await db.expense.update({ where: { id: applied.targetExpenseId }, data: { titulo: "drifted" } });
      const reader = await get(VIS);
      expect(reader.status).toBe(200);
      const body = json(reader);
      expect(body.assignment.revision).toBe(1);
      expect(body.actions).toEqual([]);
      const undone = await del(VIS, { expectedRevision: 1 });
      expect(undone.status).toBe(409);
    });

    it("[RED] RD6 PREPARE is necessary, not sufficient: a hidden participant yields PREPARE and then the opaque 404 preview", async () => {
      await allocation(SRC, (await peer(H)).id);
      expect(json(await get(HID))).toEqual(NEVER);
      const preview = await post(HID, previewBody(R));
      expect(preview.status).toBe(404);
      expect(json(preview)).toEqual(OPAQUE_404);
    });

    it("[RED] RD7 a lost apply is visible with the same revision and summary, and the same fingerprint replays without writes", async () => {
      const preview = json(await post(OWNER, previewBody()));
      const request = { mode: "apply", targetProjectId: R, roomId: null, expectedRevision: preview.revision, expectedFingerprint: preview.fingerprint };
      const first = json(await post(OWNER, request));
      const reader = await get(VIS);
      expect(reader.status).toBe(200);
      expect(json(reader).assignment).toEqual({ revision: 1, summary: first.summary });
      const before = await state();
      const replay = await post(OWNER, request);
      expect(replay.status).toBe(201);
      expect(json(replay)).toEqual({ ...first, alreadyApplied: true });
      expect(await state()).toBe(before);
    });

    it("[RED] RD7 a lost undo: the reader shows null, and an old-revision DELETE replays as alreadyUndone", async () => {
      await applyAs();
      await undoAs();
      expect(json(await get(VIS))).toEqual(NEVER);
      const replay = await del(OWNER, { expectedRevision: 1 });
      expect(replay.status).toBe(200);
      expect(json(replay)).toEqual({ revision: 2, alreadyUndone: true });
    });
  });

  // Public reader name on RefundPurposeService, PINNED here before GREEN (signature like execute/undo minus the
  // body). It is looked up dynamically so that today's RED is behavioural ("not a function"), not a TS error.
  const READER_METHOD = "read";
  type ServiceReader = (tenantId: string, projectId: string, expenseId: string, requester: unknown) => Promise<unknown>;
  const serviceReader = (): ServiceReader | undefined => {
    const service = app.get(RefundPurposeService) as unknown as Record<string, unknown>;
    const method = service[READER_METHOD];
    return typeof method === "function" ? (method.bind(service) as ServiceReader) : undefined;
  };
  // The requester exactly as the JWT strategy hands it to a controller (built BEFORE the measured window).
  const realActor = (userId: string) => app.get(JwtStrategy).validate({ sub: userId, tenantId: T, sv: 0 } as never);

  // ------------------------------------------------------------------ RD8 / RG8
  describe("RD8/RG8 one transaction, no reader DML", () => {
    const GUARD_TABLES = ["users", "tenants", "projects"];
    const tableName = (q: string) => (q.match(/FROM `main`\.`(\w+)`/) ?? [])[1] as string | undefined;
    const isTx = (q: string) => /^(BEGIN|COMMIT|ROLLBACK)/.test(q);
    const isDml = (q: string) => /^(INSERT|UPDATE|DELETE)/.test(q);
    const JWT_ACTIVITY = /^UPDATE `main`\.`users` SET `last_activity_at`/;
    // Every statement that is not a transaction marker, DML or the identified sentinel counts as a read,
    // including a SELECT without FROM.
    const reads = (list: string[]) => list.filter((q) => q !== "SENTINEL" && !isTx(q) && !isDml(q));
    const domainReads = (list: string[]) => reads(list).filter((q) => !GUARD_TABLES.includes(tableName(q) ?? ""));
    const windows = () => {
      const log = sql.filter((q) => q !== "SENTINEL");
      const begin = log.findIndex((q) => /^BEGIN/.test(q));
      const commit = log.findIndex((q) => /^COMMIT/.test(q));
      return {
        log,
        begins: log.filter((q) => /^BEGIN/.test(q)).length,
        commits: log.filter((q) => /^COMMIT/.test(q)).length,
        rollbacks: log.filter((q) => /^ROLLBACK/.test(q)).length,
        before: begin < 0 ? log : log.slice(0, begin),
        inside: begin < 0 || commit < 0 ? [] : log.slice(begin + 1, commit),
        after: commit < 0 ? [] : log.slice(commit + 1),
      };
    };
    const shapeOf = (list: string[]) => reads(list).map((q) => tableName(q) ?? "(no FROM)");
    const capture = async (run: () => Promise<{ status: number }>) => {
      await flush();
      sql.length = 0;
      const response = await run();
      await flush();
      return { response, ...windows() };
    };
    const preview = () => capture(() => post(VIS, previewBody()));

    it("[control] RD8 the log parser sees, on the current preview, ONE BEGIN IMMEDIATE ... COMMIT, guards before it, the actor re-read first inside it and nothing after", async () => {
      const w = await preview();
      expect(w.response.status).toBe(201);
      expect([w.begins, w.commits, w.rollbacks]).toEqual([1, 1, 0]);
      expect(w.log.find((q) => /^BEGIN/.test(q))).toBe("BEGIN IMMEDIATE");
      expect(shapeOf(w.before)).toEqual(["users", "tenants", "projects", "projects", "projects"]);
      expect(domainReads(w.before)).toEqual([]);
      expect(tableName(w.inside[0])).toBe("users");
      expect(tableName(w.inside[1])).toBe("tenants");
      expect(shapeOf(w.inside)).toEqual(expect.arrayContaining(["users", "tenants", "projects", "expenses", "credit_cards"]));
      expect(w.after).toEqual([]);
      expect(w.log.filter(isDml)).toEqual([]);
    });

    it("[RED] RD8 a GET runs every read of the reader (users, tenants and projects included) in ONE transaction, with the guard prefix of the current preview and no DML", async () => {
      const baseline = await preview();
      const before = await state();
      const w = await capture(() => get(VIS));
      expect(w.response.status).toBe(200);
      expect(await state()).toBe(before);
      expect([w.begins, w.commits, w.rollbacks]).toEqual([1, 1, 0]);
      // The preview's third `projects` read is ProjectAccessGuard on the POST body targetProjectId (pinned causally below).
      expect(shapeOf(baseline.before)).toEqual(["users", "tenants", "projects", "projects", "projects"]);
      expect(shapeOf(w.before)).toEqual(["users", "tenants", "projects", "projects"]);
      expect(domainReads(w.before)).toEqual([]);
      expect(tableName(w.inside[0])).toBe("users");
      expect(tableName(w.inside[1])).toBe("tenants");
      expect(shapeOf(w.inside)).toEqual(expect.arrayContaining(["users", "tenants", "projects", "expenses"]));
      expect(w.after).toEqual([]);
      expect(w.log.filter(isDml)).toEqual([]);
    });

    // Causal, not just counted: each statement before BEGIN is attributed to the guard that issued it.
    // ProjectAccessGuard walks a Set of params/query/body `projectId|sourceProjectId|targetProjectId`, so a POST
    // whose body names ANOTHER project reads it once more; the same project (or a GET, which has no body) does not.
    it("[control] RD8 origin of the extra `projects` read: ProjectAccessGuard on the POST body targetProjectId; a POST to the SAME project has the GET prefix, and all three handlers carry OPAQUE_PROJECT_ACCESS", async () => {
      const guards = (w: { ops: Array<{ origin: string; model?: string; action: string }> }) =>
        w.ops.filter((o) => o.origin !== "service:read" && o.origin !== "service:execute").map((o) => `${o.origin}:${o.model}.${o.action}`);
      const g = await opsWindow(() => get(VIS));
      const same = await opsWindow(() => post(VIS, previewBody(P)));
      const cross = await opsWindow(() => post(VIS, previewBody(R)));
      expect(g.response.status).toBe(200);
      expect(same.response.status).toBeGreaterThanOrEqual(400);
      expect(same.response.status).toBeLessThan(500);
      expect(cross.response.status).toBe(201);
      const GET_PREFIX = ["jwt:User.findUnique", "guard:modules:Project.findFirst", "guard:project-access:Project.findFirst"];
      expect(guards(g)).toEqual(GET_PREFIX);
      expect(guards(same)).toEqual(GET_PREFIX);
      expect(guards(cross)).toEqual([...GET_PREFIX, "guard:project-access:Project.findFirst"]);
      expect(shapeOf(g.before)).toEqual(["users", "tenants", "projects", "projects"]);
      expect(shapeOf(same.before)).toEqual(shapeOf(g.before));
      expect(shapeOf(cross.before)).toEqual(["users", "tenants", "projects", "projects", "projects"]);
      for (const handler of ["readRefundPurpose", "refundPurpose", "undoRefundPurpose"])
        expect({ handler, opaque: Reflect.getMetadata(OPAQUE_PROJECT_ACCESS, (ExpenseController.prototype as unknown as Record<string, object>)[handler]) }).toEqual({ handler, opaque: true });
    });

    it("[control] RD8 origin instrumentation is alive: on the CURRENT preview a stale actor's activity UPDATE is attributed to the JWT call, the service's own operations are all on the tx client and none writes", async () => {
      await db.user.update({ where: { id: VIS }, data: { lastActivityAt: null } });
      const w = await opsWindow(() => post(VIS, previewBody()));
      expect(w.response.status).toBe(201);
      const jwt = w.ops.filter((o) => o.origin === "jwt");
      const service = w.ops.filter((o) => o.origin === "service:execute");
      expect(jwt.filter(isWrite).map((o) => `${o.model}.${o.action}`)).toEqual(["User.update"]);
      expect(jwt.some((o) => o.model === "User" && o.action === "findUnique")).toBe(true);
      expect(service.length).toBeGreaterThan(3);
      expect(service.every((o) => o.tx)).toBe(true);
      expect(service.filter(isWrite)).toEqual([]);
      expect(w.ops.filter(isWrite).length).toBe(1);
    });

    it("[control] RD8 an activity-style UPDATE users emitted by the service itself, even after COMMIT, is attributed to the service and rejected (no JWT exemption by statement text)", async () => {
      const service = app.get(RefundPurposeService);
      const requester = await realActor(VIS);
      const w = await opsWindow(() =>
        origin.run("service:execute", async () => {
          const value = await service.execute(T, P, SRC, requester as never, previewBody());
          await prisma.user.update({ where: { id: VIS }, data: { lastActivityAt: new Date() } });
          return { status: value ? 201 : 0 };
        }),
      );
      expect(w.response.status).toBe(201);
      expect(w.log.filter((q) => JWT_ACTIVITY.test(q)).length).toBe(1);
      expect(w.after.filter((q) => JWT_ACTIVITY.test(q)).length).toBe(1);
      expect(w.ops.filter((o) => o.origin === "service:execute" && isWrite(o)).map((o) => `${o.model}.${o.action}`)).toEqual(["User.update"]);
      expect(w.ops.filter((o) => o.origin === "jwt")).toEqual([]);
    });

    it("[RED] RD8 the session-activity write is separate: with a stale actor the ONLY write is the JWT-origin activity UPDATE; every read of the reader is on its tx client and the reader writes nothing", async () => {
      await db.user.update({ where: { id: VIS }, data: { lastActivityAt: null } });
      const w = await opsWindow(() => get(VIS));
      expect(w.response.status).toBe(200);
      const reader = w.ops.filter((o) => o.origin === "service:read");
      expect(reader.length).toBeGreaterThan(3);
      expect(reader.every((o) => o.tx)).toBe(true);
      expect(reader.filter(isWrite)).toEqual([]);
      expect(w.ops.filter((o) => o.origin === "jwt" && isWrite(o)).map((o) => `${o.model}.${o.action}`)).toEqual(["User.update"]);
      expect(w.ops.filter(isWrite).length).toBe(1);
      expect(w.inside.filter(isDml)).toEqual([]);
    });

    // Service level: the REAL service, no guards, so every operation in the window belongs to the service under test.
    const isWrite = (o: Op) => DML_ACTIONS.includes(o.action);
    const opsWindow = async <R extends { status: number }>(run: () => Promise<R>) => {
      const txs: unknown[] = [];
      const real = prisma.$transaction.bind(prisma) as (fn: unknown, options?: unknown) => Promise<unknown>;
      const transaction = jest.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, options?: unknown) =>
        real(typeof fn === "function" ? (tx: unknown) => { txs.push(tx); return (fn as (t: unknown) => unknown)(tx); } : fn, options)) as never);
      await flush();
      sql.length = 0;
      ops.length = 0;
      const response = await run();
      const snapshot = ops.slice();
      await flush();
      const w = windows();
      transaction.mockRestore();
      return { response, ops: snapshot, transactions: txs, ...w };
    };
    const serviceWindow = async (run: (method: ServiceReader, requester: unknown) => Promise<unknown>) => {
      const method = serviceReader();
      expect(typeof method).toBe("function");
      const requester = await realActor(VIS);
      let outcome: { value?: unknown; error?: unknown } = {};
      const w = await opsWindow(async () => {
        outcome = await run(method as ServiceReader, requester).then((value) => ({ value }), (error) => ({ error }));
        return { status: 0 };
      });
      return { outcome, requester, ...w };
    };
    // A transaction is proven by the client the operation ran on, NOT by its position between BEGIN and COMMIT:
    // a root-client read issued meanwhile lands inside that SQL window but is flagged runInTransaction=false.
    const notOnTx = (list: Op[]) => list.filter((o) => !o.tx).map((o) => `${o.model ?? "(raw)"}.${o.action}`);

    it("[control] RD8 a ROOT-client read and a ROOT raw query issued between BEGIN and COMMIT sit inside the SQL window but are NOT on the transaction: only the tx-client flag tells them apart", async () => {
      const w = await opsWindow(() =>
        origin.run("service:execute", async () => {
          await prisma.$transaction(async (tx) => {
            await tx.user.findFirst({ where: { id: VIS } });
            await tx.$queryRaw`SELECT 1 AS on_tx`;
            await prisma.tenant.findFirst({ where: { id: T } });
            await prisma.$queryRaw`SELECT 2 AS on_root`;
          });
          return { status: 200 };
        }),
      );
      expect(w.transactions.length).toBe(1);
      expect(w.transactions[0]).not.toBe(prisma);
      expect(shapeOf(w.inside)).toEqual(expect.arrayContaining(["users", "tenants", "(no FROM)"]));
      expect(w.inside.some((q) => tableName(q) === "tenants")).toBe(true);
      expect(w.ops.map((o) => `${o.model ?? "(raw)"}.${o.action}:${o.tx}`)).toEqual([
        "User.findFirst:true", "(raw).queryRaw:true", "Tenant.findFirst:false", "(raw).queryRaw:false",
      ]);
      expect(notOnTx(w.ops)).toEqual(["Tenant.findFirst", "(raw).queryRaw"]);
    });

    it("[control] RD8 harness: the REAL service preview (no guards) has ONE $transaction on a distinct tx client, every operation on it, nothing before BEGIN IMMEDIATE, the actor re-read first and zero DML", async () => {
      const service = app.get(RefundPurposeService);
      const requester = await realActor(VIS);
      const w = await opsWindow(async () => {
        const value = await service.execute(T, P, SRC, requester as never, previewBody());
        return { status: value ? 201 : 0 };
      });
      expect(w.response.status).toBe(201);
      expect(w.transactions.length).toBe(1);
      expect(w.transactions[0]).not.toBe(prisma);
      expect(w.ops.length).toBeGreaterThan(3);
      expect(w.ops.every((o) => o.origin === "service:execute")).toBe(true);
      expect(notOnTx(w.ops)).toEqual([]);
      expect(w.ops.filter(isWrite)).toEqual([]);
      expect(w.before).toEqual([]);
      expect(w.log.find((q) => /^BEGIN/.test(q))).toBe("BEGIN IMMEDIATE");
      expect(tableName(w.inside[0])).toBe("users");
      expect(tableName(w.inside[1])).toBe("tenants");
      expect(shapeOf(w.inside)).toEqual(expect.arrayContaining(["users", "tenants", "projects", "expenses"]));
      expect(w.after).toEqual([]);
      expect(w.log.filter(isDml)).toEqual([]);
    });

    it("[RED] RD8 primary: the REAL service reader (no guards) opens exactly ONE $transaction on a distinct tx client and EVERY operation it issues, users/tenants/projects included, runs on that client, with no write", async () => {
      await applyAs();
      const before = await state();
      const r = await serviceWindow((method, requester) => method(T, P, SRC, requester));
      expect(r.outcome).toHaveProperty("value");
      expect(r.transactions.length).toBe(1);
      expect(r.transactions[0]).not.toBe(prisma);
      expect(r.ops.length).toBeGreaterThan(3);
      expect(r.ops.every((o) => o.origin === "service:read")).toBe(true);
      expect(notOnTx(r.ops)).toEqual([]);
      expect(r.ops.filter(isWrite)).toEqual([]);
      // The tenant row is the actor read's `include` (SQL `tenants` at inside[1] below), not a separate operation.
      expect(["User", "Project", "Expense"].every((m) => r.ops.some((o) => o.model === m))).toBe(true);
      expect([r.begins, r.commits, r.rollbacks]).toEqual([1, 1, 0]);
      expect(r.before).toEqual([]);
      expect(tableName(r.inside[0])).toBe("users");
      expect(tableName(r.inside[1])).toBe("tenants");
      expect(r.after).toEqual([]);
      expect(r.log.filter(isDml)).toEqual([]);
      expect(await state()).toBe(before);
    });

    it("[RED] RG8 more participants do not add reads: 1 hidden participant vs 6 give the same statement shape", async () => {
      await allocation(SRC, (await peer(H)).id);
      const one = await capture(() => get(VIS));
      expect(one.response.status).toBe(200);
      for (let i = 0; i < 5; i += 1) await allocation(SRC, (await peer(H)).id);
      const six = await capture(() => get(VIS));
      expect(six.response.status).toBe(200);
      expect(shapeOf(six.log)).toEqual(shapeOf(one.log));
    });
  });

  // ------------------------------------------------------------------ RD9
  describe("RD9 other payloads unchanged", () => {
    it("[control] RD9 GET :id and :id/rateio for the hidden viewer are byte-identical to the never-associated baseline", async () => {
      const read = async () => ({
        expense: (await (await as(HID)).get(`/projects/${P}/expenses/${SRC}`)).status(),
        rateio: await (await (await as(HID)).get(`/projects/${P}/expenses/${SRC}/rateio`)).text(),
      });
      const never = await read();
      await applyAs();
      const hidden = await read();
      expect(hidden.expense).toBe(never.expense);
      expect(hidden.rateio).toBe(never.rateio);
    });
  });

  // ------------------------------------------------------------------ RD10 / RG2
  describe("RD10/RG2 operational failures", () => {
    const captureLogs = () => {
      const calls: unknown[] = [];
      for (const level of ["error", "warn", "log", "debug", "verbose"] as const)
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { calls.push(args); });
      return calls;
    };
    const sanitized = (text: string) => {
      for (const leak of [SRC, "12345", "injected-db-failure", "RemovalContextMiss", "Unrepresentable"])
        expect(text).not.toContain(leak);
    };

    it("[RED] RG2 an injected database failure is a sanitized 5xx, never 404 or 200", async () => {
      inject = { model: "CrossProjectSettlement", action: "findMany" };
      const response = await get(VIS);
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.status).toBeLessThan(600);
      sanitized(response.text);
    });

    it("[RED] RG2 an incomplete loader (RemovalContextMiss) is a sanitized 5xx, not an opaque 404", async () => {
      const { RemovalContext } = await import("./removal-context");
      jest.spyOn(RemovalContext.prototype, "loadSettlements").mockResolvedValue(undefined);
      const response = await get(VIS);
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.status).toBeLessThan(600);
      sanitized(response.text);
    });

    it("[RED] RD10 a failing LOAD of the graph (marker read) propagates as 5xx", async () => {
      await applyAs();
      inject = { model: "FloorPlanMarker", action: "findMany" };
      const response = await get(VIS);
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.status).toBeLessThan(600);
    });

    // The evaluator of UNDO is `refundCleanupFrom` (pure, synchronous, reads only the loaded context).
    // The seam is the EXISTING accessor `RemovalContext.allocationsOf`, which the evaluation calls first; the
    // injector throws only when `refundCleanupFrom` is on the call stack (the reader graph also calls the
    // accessor, untouched). `hits.inside === 1` proves the evaluation really ran; 0 means the seam is dead.
    const failInsideUndoEvaluation = async (make: () => Error) => {
      const { RemovalContext } = await import("./removal-context");
      const original = RemovalContext.prototype.allocationsOf;
      const hits = { inside: 0, outside: 0 };
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      jest.spyOn(RemovalContext.prototype, "allocationsOf").mockImplementation(function (this: any, ...args: [string[]]) {
        if (/\brefundCleanupFrom\b/.test(new Error().stack ?? "")) {
          hits.inside += 1;
          throw make();
        }
        hits.outside += 1;
        return original.apply(this, args);
      });
      return { hits, restore: () => { Error.stackTraceLimit = limit; } };
    };

    const GENERIC_500 = '{"message":"Internal Server Error","statusCode":500}';

    it("[RED] G4 every unexpected 5xx class (integrity, graph load, UNDO evaluation, a typed HttpException 503/500 with a private sentinel) answers the EXACT same body and leave the SAME single generic log with no data, stack, cause or private name", async () => {
      const scenarios: Array<[string, () => Promise<void>]> = [
        ["integrity", async () => { await applyAs(); await patchCfe({ deletedAt: DATE }); }],
        ["load", async () => { await applyAs(); inject = { model: "FloorPlanMarker", action: "findMany" }; }],
        ["undo-evaluation", async () => { await applyAs(); await failInsideUndoEvaluation(() => new TypeError("private-undo-evaluation-detail")); }],
        ["http-503-in-undo-evaluation", async () => { await applyAs(); await failInsideUndoEvaluation(() => new ServiceUnavailableException("private-http-503")); }],
        ["http-500-in-undo-evaluation", async () => { await applyAs(); await failInsideUndoEvaluation(() => new HttpException("private-http-500", 500)); }],
      ];
      const outcomes: Array<{ name: string; status: number; text: string; log: string; calls: number }> = [];
      const stackLimit = Error.stackTraceLimit;
      for (const [name, arrange] of scenarios) {
        await seed();
        jest.restoreAllMocks();
        inject = null;
        await arrange();
        const logs = captureLogs();
        const response = await get(VIS);
        outcomes.push({ name, status: response.status, text: response.text, log: inspect(logs, { depth: 6 }), calls: logs.length });
        jest.restoreAllMocks();
        inject = null;
      }
      Error.stackTraceLimit = stackLimit;
      for (const o of outcomes) {
        expect({ name: o.name, status: o.status, text: o.text }).toEqual({ name: o.name, status: 500, text: GENERIC_500 });
        expect({ name: o.name, calls: o.calls }).toEqual({ name: o.name, calls: 1 });
        for (const leak of [SRC, "12345", "injected-db-failure", "private-undo-evaluation-detail", "private-http-503", "private-http-500", "RemovalContextMiss", "Unrepresentable", "TypeError", "ServiceUnavailable"])
          expect(o.log).not.toContain(leak);
        expect(o.log).not.toMatch(/\n\s+at /);
      }
      expect(new Set(outcomes.map((o) => o.text)).size).toBe(1);
      expect(new Set(outcomes.map((o) => o.log)).size).toBe(1);
    });

    // The intentional cause is PRIVATE to the service: asserted on the thrown exception, never on logs or HTTP.
    it("[RED] G4 service: an integrity failure throws InternalServerErrorException whose private cause is the intentional summary error, with the exact default body", async () => {
      await applyAs();
      await patchCfe({ deletedAt: DATE });
      const method = serviceReader();
      expect(typeof method).toBe("function");
      const error = await (method as ServiceReader)(T, P, SRC, await realActor(VIS)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as InternalServerErrorException).getResponse()).toEqual({ message: "Internal Server Error", statusCode: 500 });
      expect(((error as { cause?: Error }).cause as Error).constructor.name).toBe("RefundPurposeSummaryUnrepresentable");
    });

    // `summary.importId` is a required string of the public type: a visible assignment whose source lost it
    // cannot be represented, so it is the same intentional integrity failure as a missing cash flow.
    it("[control] RG10 (f) a VISIBLE assignment whose source has importId null is the EXACT generic 500 (body, private cause, one constant log), never a fabricated importId", async () => {
      await applyAs();
      await patchSource({ importId: null });
      const logs = captureLogs();
      const response = await get(VIS);
      expect({ status: response.status, text: response.text }).toEqual({ status: 500, text: GENERIC_500 });
      expect(logs.length).toBe(1);
      const log = inspect(logs, { depth: 6 });
      for (const leak of [SRC, "12345", "Unrepresentable", "TypeError", "importId"]) expect(log).not.toContain(leak);
      expect(log).not.toMatch(/\n\s+at /);
      const error = await (serviceReader() as ServiceReader)(T, P, SRC, await realActor(VIS)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as InternalServerErrorException).getResponse()).toEqual({ message: "Internal Server Error", statusCode: 500 });
      expect(((error as { cause?: Error }).cause as Error).constructor.name).toBe("RefundPurposeSummaryUnrepresentable");
    });

    it("[RED] G4 an expected 4xx (missing source: opaque 404) passes through intact and emits no error log", async () => {
      const logs = captureLogs();
      const response = await get(VIS, "no-such-source");
      expect(response.status).toBe(404);
      expect(json(response)).toEqual(OPAQUE_404);
      expect(logs).toEqual([]);
    });

    it.each([
      ["503", () => new ServiceUnavailableException("private-http-503")],
      ["500", () => new HttpException("private-http-500", 500)],
    ])("[RED] G4 service: a typed HttpException %s thrown inside the UNDO evaluation is NOT passed through: it is wrapped with itself as private cause and the generic body", async (_status, make) => {
      await applyAs();
      const thrown = make();
      const injector = await failInsideUndoEvaluation(() => thrown);
      const method = serviceReader();
      expect(typeof method).toBe("function");
      const error = await (method as ServiceReader)(T, P, SRC, await realActor(VIS)).catch((e: unknown) => e);
      injector.restore();
      expect(injector.hits.inside).toBe(1);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(error).not.toBe(thrown);
      expect((error as InternalServerErrorException).getStatus()).toBe(500);
      expect((error as InternalServerErrorException).getResponse()).toEqual({ message: "Internal Server Error", statusCode: 500 });
      expect((error as { cause?: unknown }).cause).toBe(thrown);
    });

    it("[RED] G4 service: an unexpected TypeError inside the UNDO evaluation is wrapped with THAT TypeError as private cause, not as the intentional integrity error", async () => {
      await applyAs();
      const boom = new TypeError("private-undo-evaluation-detail");
      const injector = await failInsideUndoEvaluation(() => boom);
      const method = serviceReader();
      expect(typeof method).toBe("function");
      const error = await (method as ServiceReader)(T, P, SRC, await realActor(VIS)).catch((e: unknown) => e);
      injector.restore();
      expect(injector.hits.inside).toBe(1);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect((error as InternalServerErrorException).getResponse()).toEqual({ message: "Internal Server Error", statusCode: 500 });
      expect((error as { cause?: unknown }).cause).toBe(boom);
      expect(((error as { cause?: Error }).cause as Error).constructor.name).not.toBe("RefundPurposeSummaryUnrepresentable");
    });

    it.each([
      ["untyped", () => new Error("injected-undo-evaluation-failure"), 500],
      ["ConflictException", () => new ConflictException("x"), 409],
      ["NotFoundException", () => new NotFoundException("x"), 404],
      ["HttpException 503 with a private sentinel", () => new ServiceUnavailableException("private-http-503"), 503],
      ["HttpException 500 with a private sentinel", () => new HttpException("private-http-500", 500), 500],
    ])("[control] RD10 the injector really fires inside refundCleanupFrom: on the CURRENT DELETE a %s error surfaces with its own status", async (_name, make, status) => {
      await applyAs();
      const injector = await failInsideUndoEvaluation(make);
      try {
        const response = await del(VIS, { expectedRevision: 1 });
        expect(injector.hits.inside).toBe(1);
        expect(response.status).toBe(status);
      } finally {
        injector.restore();
      }
    });

    it("[RED] RD10 an UNTYPED error thrown inside the UNDO evaluation is a sanitized 5xx, not a hidden UNDO", async () => {
      await applyAs();
      const injector = await failInsideUndoEvaluation(() => new Error("injected-undo-evaluation-failure"));
      try {
        const response = await get(VIS);
        expect(injector.hits.inside).toBe(1);
        expect(response.status).toBeGreaterThanOrEqual(500);
        expect(response.status).toBeLessThan(600);
        expect(response.text).not.toContain("injected-undo-evaluation-failure");
        sanitized(response.text);
      } finally {
        injector.restore();
      }
    });

    it.each([
      ["NotFoundException", async () => new NotFoundException("x")],
      ["ConflictException", async () => new ConflictException("x")],
    ])("[RED] RD10 a typed %s thrown inside the UNDO evaluation only removes UNDO: assignment kept, actions []", async (_name, make) => {
      const applied = await applyAs();
      const error = await make();
      const injector = await failInsideUndoEvaluation(() => error);
      const logs = captureLogs();
      try {
        const response = await get(VIS);
        expect(logs).toEqual([]);
        expect(injector.hits.inside).toBe(1);
        expect(response.status).toBe(200);
        expect(json(response)).toEqual({
          sourceExpenseId: SRC,
          assignment: { revision: 1, summary: applied.summary },
          actions: [],
        });
      } finally {
        injector.restore();
      }
    });

    it("[RED] RG10 corrupt required data never becomes assignment null nor an empty summary, and logs carry no row content", async () => {
      const logs = captureLogs();
      await applyAs();
      await patchCfe({ deletedAt: DATE });
      const zero = await get(VIS);
      expect(zero.status).toBeGreaterThanOrEqual(500);
      sanitized(zero.text);
      expect(JSON.stringify(logs)).not.toContain(SRC);
      expect(JSON.stringify(logs)).not.toContain("12345");
    });
  });

  // ------------------------------------------------------------------ RG10
  describe("RG10 summary from persisted columns", () => {
    it("[RED] RG10 (a) drift with one cash flow on another date: both dates are the persisted ones, actions [], DELETE 409", async () => {
      await applyAs();
      await patchSource({ status: "PLANEJADO" });
      await patchCfe({ data: new Date("2026-09-12T00:00:00Z") });
      const reader = await get(VIS);
      expect(reader.status).toBe(200);
      const body = json(reader);
      expect(body.assignment.summary.dataPagamento).toBe("2026-09-10T00:00:00.000Z");
      expect(body.assignment.summary.cashFlowDate).toBe("2026-09-12T00:00:00.000Z");
      expect(body.actions).toEqual([]);
      expect((await del(VIS, { expectedRevision: 1 })).status).toBe(409);
    });

    it("[RED] RG10 (b) no active source cash flow is a 5xx", async () => {
      await applyAs();
      await patchCfe({ deletedAt: DATE });
      expect((await get(VIS)).status).toBeGreaterThanOrEqual(500);
    });

    it("[RED] RG10 (c) two active source cash flows are a 5xx", async () => {
      await applyAs();
      const { id, ...copy } = await db.cashFlowEntry.findUniqueOrThrow({ where: { id: cfeId } });
      await db.cashFlowEntry.create({ data: copy });
      expect((await get(VIS)).status).toBeGreaterThanOrEqual(500);
    });

    it.each([
      ["dataPagamento null", { dataPagamento: null }],
      ["tipoDespesa outside the enum", { tipoDespesa: "NAO_EXISTE" }],
    ])("[RED] RG10 (d) %s is a 5xx", async (_label, data) => {
      await applyAs();
      await patchSource(data);
      expect((await get(VIS)).status).toBeGreaterThanOrEqual(500);
    });

    it("[RED] RG10 (e) null dataCompra is a valid 200 with dataCompra null and roomId null present", async () => {
      await applyAs();
      await patchSource({ dataCompra: null });
      const response = await get(VIS);
      expect(response.status).toBe(200);
      const summary = json(response).assignment.summary;
      expect(summary.dataCompra).toBeNull();
      expect("roomId" in summary).toBe(true);
      expect(summary.roomId).toBeNull();
    });
  });

  // ------------------------------------------------------------------ R4 (review 727) / R1
  describe("R4 UNDO is offered only when DELETE would accept its revision; R1 batch/card of a visible assignment", () => {
    it.each([0, 2, 4, -1])(
      "[RED] R4 (a) a visible assignment with persisted revision %s keeps assignment+summary, actions [] and the DELETE it would need is refused with 400",
      async (revision) => {
        const applied = await applyAs();
        await patchSource({ refundPurposeRevision: revision });
        const response = await get(VIS);
        expect(response.status).toBe(200);
        expect(json(response)).toEqual({ sourceExpenseId: SRC, assignment: { revision, summary: applied.summary }, actions: [] });
        const before = await state();
        const refused = await del(OWNER, { expectedRevision: revision });
        expect(refused.status).toBe(400);
        expect(await state()).toBe(before);
      },
    );

    it("[control] R4 (a) an odd persisted revision still offers UNDO and DELETE accepts it", async () => {
      const applied = await applyAs();
      expect(json(await get(VIS))).toEqual({ sourceExpenseId: SRC, assignment: { revision: 1, summary: applied.summary }, actions: ["UNDO"] });
      expect(json(await del(OWNER, { expectedRevision: 1 }))).toEqual({ revision: 2, alreadyUndone: false });
    });

    it("[control] R4 (b) a HIDDEN assignment with an even persisted revision is byte-identical to a never-assigned source", async () => {
      await applyAs();
      await patchSource({ refundPurposeRevision: 2 });
      const hidden = await get(HID);
      await seed();
      const never = await get(HID);
      expect(json(hidden)).toEqual(NEVER);
      expect(hidden.text).toBe(never.text);
    });

    it.each([
      ["batch soft-deleted", () => db.creditCardStatementImport.update({ where: { id: importId }, data: { deletedAt: DATE } })],
      ["card soft-deleted", () => db.creditCard.update({ where: { id: cardId }, data: { deletedAt: DATE } })],
    ])("[control] R1 (d) a VISIBLE assignment whose %s answers the opaque 404, not a 500 and not the assignment", async (_label, arrange) => {
      await applyAs();
      await arrange();
      const before = await state();
      const response = await get(VIS);
      expect(response.status).toBe(404);
      expect(json(response)).toEqual(OPAQUE_404);
      expect(await state()).toBe(before);
    });
  });

  // -------------------------------------------- pre-existing verbs the RED tests lean on
  describe("controls: the POST/DELETE/interceptor behavior the reader tests rely on (green today)", () => {
    it("[control] RD6/RD7 undo, its replay and the apply replay answer the pinned literals", async () => {
      const preview = json(await post(OWNER, previewBody()));
      const request = { mode: "apply", targetProjectId: R, roomId: null, expectedRevision: 0, expectedFingerprint: preview.fingerprint };
      const first = json(await post(OWNER, request));
      const replay = json(await post(OWNER, request));
      expect(replay).toEqual({ ...first, alreadyApplied: true });
      expect(first.alreadyApplied).toBe(false);
      expect(first.revision).toBe(1);
      expect(json(await del(OWNER, { expectedRevision: 1 }))).toEqual({ revision: 2, alreadyUndone: false });
      expect(json(await del(OWNER, { expectedRevision: 1 }))).toEqual({ revision: 2, alreadyUndone: true });
    });

    it("[control] RD6/RG10 drift on the target or on the source cash flow makes DELETE answer 409", async () => {
      const applied = await applyAs();
      await db.expense.update({ where: { id: applied.targetExpenseId }, data: { titulo: "drifted" } });
      expect((await del(VIS, { expectedRevision: 1 })).status).toBe(409);
      await db.expense.update({ where: { id: applied.targetExpenseId }, data: { titulo: null } });
      await patchSource({ status: "PLANEJADO" });
      await patchCfe({ data: new Date("2026-09-12T00:00:00Z") });
      expect((await del(VIS, { expectedRevision: 1 })).status).toBe(409);
    });

    it("[control] RG3 with a PLANTAS target the owner still sees linkedExpenseId while DELETE answers 404", async () => {
      await applyAs();
      await db.project.update({ where: { id: R }, data: { type: "PLANTAS" } });
      expect(typeof json(await plain(OWNER)).linkedExpenseId).toBe("string");
      expect((await del(OWNER, { expectedRevision: 1 })).status).toBe(404);
    });

    it("[control] RD6/RD11 a hidden participant makes the current preview 404, and a visible target keeps linkedExpenseId", async () => {
      await allocation(SRC, (await peer(H)).id);
      const preview = await post(HID, previewBody());
      expect(preview.status).toBe(404);
      expect(json(preview)).toEqual(OPAQUE_404);
      await seed();
      await applyAs();
      await db.user.update({ where: { id: VIS }, data: grants([P, R], ["PESSOAL", "REFORMA"]) });
      await allocation(SRC, (await peer(H)).id);
      expect(typeof json(await plain(VIS)).linkedExpenseId).toBe("string");
    });
  });

  // ------------------------------------------------------------------ RD12
  describe("RD12 roomId validation (existing POST contract)", () => {
    it.each([
      ["omitted", { mode: "preview", targetProjectId: R }, 400],
      ["empty string", { mode: "preview", targetProjectId: R, roomId: "" }, 400],
      ["number", { mode: "preview", targetProjectId: R, roomId: 5 }, 400],
      ["unknown room", { mode: "preview", targetProjectId: R, roomId: "reader-no-room" }, 404],
      ["null", { mode: "preview", targetProjectId: R, roomId: null }, 201],
    ])("[control] RD12 roomId %s", async (_label, body, status) => {
      expect((await post(VIS, body)).status).toBe(status);
    });
  });

  // ------------------------------------------------------------------ RG9
  describe("RG9 audience across the three verbs", () => {
    const provision = async () => {
      const base = { tenantId: T, role: "USER", lastActivityAt: new Date() };
      await db.user.create({ data: { id: `${T}-nop`, username: "nop", name: "nop", ...base, ...grants([R], ["REFORMA"]) } });
      await db.user.create({ data: { id: `${T}-notype`, username: "notype", name: "notype", ...base, ...grants([P], ["CASA"]) } });
      await db.user.create({ data: { id: `${T}-noproj`, username: "noproj", name: "noproj", ...base, ...grants([R], ["PESSOAL", "REFORMA"]) } });
      await db.user.create({ data: { id: `${T}-admin`, username: "admin", name: "admin", ...base, role: "ADMIN" } });
      for (const id of ["guest-active", "guest-expired"])
        await db.user.create({ data: { id: `${T}-${id}`, username: id, name: id, isGuest: true, ...base, ...grants([P, R, C], ["PESSOAL", "REFORMA", "CASA"]) } });
    };
    const TYPE_403 = { message: "Sem permissão para este tipo de projeto", error: "Forbidden", statusCode: 403 };
    const denied: Array<[string, number, unknown]> = [
      ["nop", 403, TYPE_403],
      ["notype", 403, TYPE_403],
      ["noproj", 404, OPAQUE_404],
    ];

    it.each(denied)("[control] RG9 actor %s: POST preview and DELETE already answer the pinned literal", async (name, status, body) => {
      await provision();
      const id = `${T}-${name}`;
      const [p, d] = [await post(id, previewBody()), await del(id, { expectedRevision: 1 })];
      expect({ actor: name, post: [p.status, json(p)] }).toEqual({ actor: name, post: [status, body] });
      expect({ actor: name, del: [d.status, json(d)] }).toEqual({ actor: name, del: [status, body] });
    });

    it.each(denied)("[RED] RG9 actor %s: GET answers the same literal as POST preview and DELETE", async (name, status, body) => {
      await provision();
      const g = await get(`${T}-${name}`);
      expect({ actor: name, get: [g.status, json(g)] }).toEqual({ actor: name, get: [status, body] });
    });

    it("[control] RG9 an expired guest is already refused 401 by POST preview and DELETE", async () => {
      await provision();
      await db.tenant.update({ where: { id: T }, data: { expiresAt: new Date("2020-01-01T00:00:00Z") } });
      const id = `${T}-guest-expired`;
      const [p, d] = [await post(id, previewBody()), await del(id, { expectedRevision: 1 })];
      expect([p.status, d.status]).toEqual([401, 401]);
    });

    it("[RED] RG9 an expired guest is refused identically by the three verbs", async () => {
      await provision();
      await db.tenant.update({ where: { id: T }, data: { expiresAt: new Date("2020-01-01T00:00:00Z") } });
      const id = `${T}-guest-expired`;
      const g = await get(id);
      expect([g.status, json(g)]).toEqual([401, { message: "Sessão inválida", error: "Unauthorized", statusCode: 401 }]);
    });

    it.each(["guest-active", "admin"])("[RED] RG9 actor %s: GET is allowed exactly when POST preview is", async (name) => {
      await provision();
      await db.tenant.update({ where: { id: T }, data: { expiresAt: new Date("2100-01-01T00:00:00Z") } });
      const id = `${T}-${name}`;
      const p = await post(id, previewBody());
      const g = await get(id);
      expect(p.status).toBe(201);
      expect(g.status).toBe(200);
      expect(json(g)).toEqual(NEVER);
    });
  });
});
