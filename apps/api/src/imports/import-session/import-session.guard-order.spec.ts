// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ForbiddenException,
  RequestMethod,
  type ExecutionContext,
} from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { ProjectAccessGuard } from "../../common/guards/project-access.guard";
import { PrismaService } from "../../prisma/prisma.service";
import {
  cleanupImportWorld,
  createBody,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootRecoveryApp,
  UI_HEADERS,
  type RecoveryApp,
} from "../../test-utils/import-session-recovery-harness";
import {
  ServiceOwnedProjectAccess,
  SERVICE_OWNED_PROJECT_ACCESS_KEY,
} from "../../common/decorators/service-owned-project-access.decorator";
import { ImportSessionController } from "./import-session.controller";

/**
 * RED — global ProjectAccessGuard vs the import-session routes. The guard runs BEFORE any
 * controller/service code and reads projectId/sourceProjectId/targetProjectId from params,
 * query AND body. For a role-USER caller that turned a query/body the routes declare as
 * "400 uniform" into a 400/404 oracle keyed on which project ids exist in the tenant / the
 * grant. Every import route authorises inside the service (reauth + anchor/card), so those
 * twelve handlers opt out of the guard's id extraction through explicit per-handler metadata.
 * Real PrismaService, JwtStrategy and the four global guards in production order.
 */
const PREFIX = "imp-guard-order";
const setup = new PrismaClient();
let world: ImportWorld;
let api: RecoveryApp;
let wildId: string;
jest.setTimeout(120_000);

const HANDLERS = [
  "create",
  "list",
  "getSession",
  "getResult",
  "cancel",
  "declaration",
  "resolution",
  "defer",
  "reactivate",
  "prepareCurrentLot",
  "continueAnswering",
  "currentLot",
  "interpret",
  "getObservations",
  "getCandidates",
  "challenge",
  "confirm",
  "execute",
];
const invalid = {
  code: "INVALID_INPUT",
  retryable: false,
  sessionId: null,
  currentRevision: null,
  reason: null,
};
const notFound = { ...invalid, code: "NOT_FOUND" };
const KEYS = ["projectId", "sourceProjectId", "targetProjectId", "tenantId"];

describe("RED — ProjectAccessGuard must not front-run the import-session contract", () => {
  beforeAll(async () => {
    await setup.$connect();
    world = await seedImportWorld(setup, PREFIX);
    wildId = `${PREFIX}-u-wild`;
    // Literal `[]` grants = the documented wildcard: an unrestricted role-USER.
    await setup.user.create({
      data: {
        id: wildId,
        tenantId: world.tenantId,
        username: wildId,
        name: wildId,
        role: "USER",
        allowedModules: JSON.stringify(["creditCards", "expenses"]),
        allowedProjects: "[]",
        allowedProjectTypes: "[]",
      },
    });
    api = await bootRecoveryApp(setup);
  });
  afterAll(async () => {
    await api.close();
    await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
  });
  beforeEach(async () => {
    api.clock.current = FIXED_NOW;
    await setup.importSession.deleteMany({
      where: { tenantId: { in: [world.tenantId, world.otherTenantId] } },
    });
  });

  const actorId = (label: string) =>
    label === "OWNER"
      ? world.users.owner.id
      : label === "restricted USER"
        ? world.users.restricted.id
        : wildId;

  describe("list: query is 400 uniform whatever the id shape/value", () => {
    it.each(["OWNER", "restricted USER", "unrestricted USER"])(
      "%s",
      async (label) => {
        const token = await api.tokenFor(actorId(label));
        const seen: unknown[] = [];
        for (const key of KEYS) {
          for (const value of [
            world.projects.pessoal,
            world.projects.casa,
            world.projects.foreign,
            "nope-project",
          ]) {
            const reply = await api.call(
              "GET",
              `/import-sessions?${key}=${encodeURIComponent(value)}`,
              { token },
            );
            seen.push([key, value, reply.status, reply.json?.code]);
            expect(reply.json).toMatchObject(invalid);
          }
        }
        expect(seen.filter((row) => (row as unknown[])[2] !== 400)).toEqual([]);
      },
    );
  });

  describe("extras are never an ACL selector: same bytes with and without them", () => {
    const withExtras = (path: string, key: string, value: string) =>
      `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

    it("GET session / GET result of a session anchored outside the grant stay the opaque 404 for every extra", async () => {
      const hidden = await seedSession(setup, world, {
        ownerUserId: world.users.restricted.id,
        ownerProjectId: world.projects.casa,
        cardId: world.cards.casa,
      });
      const token = await api.tokenFor(world.users.restricted.id);
      for (const path of [
        `/import-sessions/${hidden.id}`,
        `/import-sessions/${hidden.id}/result`,
      ]) {
        const base = await api.call("GET", path, { token });
        expect(base.status).toBe(404);
        expect(base.json).toMatchObject(notFound);
        for (const value of [world.projects.pessoal, world.projects.casa]) {
          const reply = await api.call(
            "GET",
            withExtras(path, "projectId", value),
            { token },
          );
          expect([reply.status, reply.text]).toEqual([base.status, base.text]);
        }
      }
    });

    it("GET session of the actor's own granted session ignores an out-of-grant extra (no guard 404)", async () => {
      const own = await seedSession(setup, world, {
        ownerUserId: world.users.restricted.id,
      });
      const token = await api.tokenFor(world.users.restricted.id);
      const path = `/import-sessions/${own.id}`;
      const base = await api.call("GET", path, { token });
      expect(base.status).toBe(200);
      const reply = await api.call(
        "GET",
        withExtras(path, "projectId", world.projects.casa),
        { token },
      );
      expect([reply.status, reply.text]).toEqual([base.status, base.text]);
    });

    it("cancel: a project id in the body or query never reaches the guard; body stays 400, ACL stays 404", async () => {
      const hidden = await seedSession(setup, world, {
        ownerUserId: world.users.restricted.id,
        ownerProjectId: world.projects.casa,
        cardId: world.cards.casa,
      });
      const own = await seedSession(setup, world, {
        ownerUserId: world.users.restricted.id,
      });
      const token = await api.tokenFor(world.users.restricted.id);
      const cancel = (id: string, body: unknown, query = "") =>
        api.call("POST", `/import-sessions/${id}/cancel${query}`, {
          token,
          headers: UI_HEADERS,
          body,
        });
      for (const value of [world.projects.casa, world.projects.foreign]) {
        const badBody = await cancel(own.id, {
          expectedRevision: 1,
          projectId: value,
        });
        expect([badBody.status, badBody.json?.code]).toEqual([
          400,
          "INVALID_INPUT",
        ]);
      }
      const base = await cancel(hidden.id, { expectedRevision: 1 });
      expect([base.status, base.json?.code]).toEqual([404, "NOT_FOUND"]);
      const withQuery = await cancel(
        hidden.id,
        { expectedRevision: 1 },
        `?sourceProjectId=${world.projects.pessoal}`,
      );
      expect([withQuery.status, withQuery.text]).toEqual([
        base.status,
        base.text,
      ]);
      // A refused/invalid cancel wrote nothing.
      const rows = await setup.importSession.findMany({
        where: { id: { in: [own.id, hidden.id] } },
        select: { state: true, revision: true },
      });
      expect(rows.every((r) => r.state === "DRAFT" && r.revision === 1)).toBe(
        true,
      );
    });

    it("unavailable create fails before body/query ACL selectors and writes nothing", async () => {
      const token = await api.tokenFor(world.users.restricted.id);
      const create = (body: unknown, query = "") =>
        api.call("POST", `/import-sessions${query}`, {
          token,
          headers: UI_HEADERS,
          body,
        });
      const extra = await create({
        ...createBody(world.cards.pessoal),
        projectId: world.projects.foreign,
      });
      const withQuery = await create(
        createBody(world.cards.casa),
        `?projectId=${world.projects.pessoal}`,
      );
      expect([extra.status, extra.json?.code]).toEqual([
        503,
        "CAPABILITY_DISABLED",
      ]);
      expect([withQuery.status, withQuery.json?.code]).toEqual([
        503,
        "CAPABILITY_DISABLED",
      ]);
      expect(
        await setup.importSession.count({
          where: { tenantId: world.tenantId },
        }),
      ).toBe(0);
    });
  });

  describe("authentication still precedes everything (opt-out is not an auth bypass)", () => {
    it("no token / garbage token => 401 even with project-shaped keys", async () => {
      for (const token of [undefined, "not.a.jwt"]) {
        const reply = await api.call(
          "GET",
          `/import-sessions?projectId=${world.projects.pessoal}`,
          { token },
        );
        expect([reply.status, reply.json?.code]).toEqual([
          401,
          "UNAUTHENTICATED",
        ]);
      }
    });

    it("new documentary routes reject no-JWT before parsing body or resolving ids", async () => {
      const reply = await api.call(
        "POST",
        "/import-sessions/not-an-authorized-session/declarations",
        {
          headers: UI_HEADERS,
          body: { malformed: true },
        },
      );
      expect([reply.status, reply.json?.code]).toEqual([
        401,
        "UNAUTHENTICATED",
      ]);
    });

    it("JWT tenant remains authoritative on a new route despite header/query overrides", async () => {
      const own = await seedSession(setup, world, {
        ownerUserId: world.users.owner.id,
      });
      const token = await api.tokenFor(world.users.owner.id);
      const body = {
        version: 1,
        requestId: "11111111-1111-4111-8111-111111111111",
        expectedRevision: 1,
        lineId: "line-1",
      };
      const base = await api.call("POST", `/import-sessions/${own.id}/defer`, {
        token,
        headers: UI_HEADERS,
        body,
      });
      const overridden = await api.call(
        "POST",
        `/import-sessions/${own.id}/defer?tenantId=${world.otherTenantId}`,
        {
          token,
          headers: {
            ...UI_HEADERS,
            "x-tenant-id": world.otherTenantId,
          },
          body: { ...body, requestId: "22222222-2222-4222-8222-222222222222" },
        },
      );
      expect(base.status).toBe(503);
      expect(overridden.status).toBe(503);
      expect(overridden.json?.code).toBe(base.json?.code);
    });
  });

  describe("the opt-out is per-handler metadata, delimited to the dedicated import routes", () => {
    const build = async () => {
      const findFirst = jest.fn().mockResolvedValue({ type: "PESSOAL" });
      const moduleRef = await Test.createTestingModule({
        providers: [
          ProjectAccessGuard,
          Reflector,
          { provide: PrismaService, useValue: { project: { findFirst } } },
        ],
      }).compile();
      return { guard: moduleRef.get(ProjectAccessGuard), findFirst };
    };
    const contextFor = (
      klass: abstract new (...args: never[]) => unknown,
      handler: (...args: never[]) => unknown,
      request: Record<string, unknown>,
    ) =>
      ({
        getClass: () => klass,
        getHandler: () => handler,
        switchToHttp: () => ({ getRequest: () => request }),
      }) as unknown as ExecutionContext;
    const restrictedRequest = (extra: Record<string, unknown> = {}) => ({
      user: {
        role: "USER",
        tenantId: "t",
        allowedProjects: ["granted"],
        allowedProjectTypes: [],
        allowedModules: ["creditCards"],
      },
      params: {},
      query: { projectId: "not-granted" },
      body: {},
      ...extra,
    });

    it("the controller exposes exactly the dedicated literal handlers", () => {
      const names = Object.getOwnPropertyNames(
        ImportSessionController.prototype,
      ).filter((name) => name !== "constructor");
      expect(names.sort()).toEqual([...HANDLERS].sort());
    });

    it("the attachment controller adds four individually opted-out handlers", async () => {
      if (
        !existsSync(join(__dirname, "vault/import-attachment.controller.ts"))
      ) {
        expect(HANDLERS).toHaveLength(18);
        return;
      }
      const { ImportAttachmentController } = jest.requireActual<{
        ImportAttachmentController: abstract new (...args: never[]) => object;
      }>("./vault/import-attachment.controller");
      const handlers = Object.entries(
        Object.getOwnPropertyDescriptors(ImportAttachmentController.prototype),
      ).filter(([name]) => name !== "constructor");
      expect(handlers.map(([name]) => name).sort()).toEqual([
        "analyze",
        "download",
        "reserve",
        "upload",
      ]);
      expect(HANDLERS.length + handlers.length).toBe(22);
      expect(
        Reflect.getMetadata(PATH_METADATA, ImportAttachmentController),
      ).toBe("import-sessions");
      const routes: Array<[string, unknown, unknown]> = [];
      for (const [name, descriptor] of handlers) {
        expect(typeof descriptor.value).toBe("function");
        expect(descriptor.value.name).toBe(name);
        expect(
          Reflect.getMetadata(
            SERVICE_OWNED_PROJECT_ACCESS_KEY,
            descriptor.value,
          ),
        ).toBe(true);
        const { guard, findFirst } = await build();
        await expect(
          guard.canActivate(
            contextFor(
              ImportAttachmentController,
              descriptor.value,
              restrictedRequest({ body: { targetProjectId: "x" } }),
            ),
          ),
        ).resolves.toBe(true);
        expect(findFirst).not.toHaveBeenCalled();
        routes.push([
          name,
          Reflect.getMetadata(METHOD_METADATA, descriptor.value),
          Reflect.getMetadata(PATH_METADATA, descriptor.value),
        ]);
      }
      expect(
        routes.sort(([left], [right]) => left.localeCompare(right)),
      ).toEqual([
        [
          "analyze",
          RequestMethod.POST,
          ":id/attachments/:attachmentId/analyze",
        ],
        [
          "download",
          RequestMethod.GET,
          ":id/attachments/:attachmentId/content",
        ],
        ["reserve", RequestMethod.POST, ":id/attachments"],
        ["upload", RequestMethod.PUT, ":id/attachments/:attachmentId/content"],
      ]);
    });

    it.each(HANDLERS)("%s: the guard skips id extraction", async (name) => {
      const { guard, findFirst } = await build();
      const handler = (
        ImportSessionController.prototype as unknown as Record<
          string,
          (...args: never[]) => unknown
        >
      )[name]!;
      expect(typeof handler).toBe("function");
      await expect(
        guard.canActivate(
          contextFor(
            ImportSessionController,
            handler,
            restrictedRequest({ body: { targetProjectId: "x" } }),
          ),
        ),
      ).resolves.toBe(true);
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("any unmarked handler keeps the guard, whatever the path / body flag says", async () => {
      class Other {
        handle() {
          return null;
        }
      }
      const { guard } = await build();
      for (const request of [
        restrictedRequest(),
        restrictedRequest({
          path: "/import-sessions",
          url: "/import-sessions",
        }),
        restrictedRequest({
          body: { skipProjectAccess: true, serviceOwned: true },
        }),
      ]) {
        await expect(
          guard.canActivate(contextFor(Other, Other.prototype.handle, request)),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it("the mark is per HANDLER: a class-level mark opts nothing out", async () => {
      @ServiceOwnedProjectAccess()
      class ClassMarked {
        handle() {
          return null;
        }
      }
      const { guard } = await build();
      await expect(
        guard.canActivate(
          contextFor(
            ClassMarked,
            ClassMarked.prototype.handle,
            restrictedRequest(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // NOTE: the guard only acts when it recognises a project id, so the absence of the mark is
    // NOT a protection for a new id-less route. The tripwire is the literal twelve-handler list
    // above plus per-handler auth/tenant/project tests; B2 must extend it explicitly.
    it("only the import controller (plus the decorator and guard files) mentions the opt-out", () => {
      const root = join(__dirname, "..", "..");
      const hits: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (
            full.endsWith(".ts") &&
            !full.endsWith(".spec.ts") &&
            readFileSync(full, "utf8").includes("ServiceOwnedProjectAccess")
          )
            hits.push(full.slice(root.length + 1));
        }
      };
      walk(root);
      const expected = [
        "common/decorators/service-owned-project-access.decorator.ts",
        "common/guards/project-access.guard.ts",
        "imports/import-session/import-session.controller.ts",
      ];
      if (existsSync(join(__dirname, "vault/import-attachment.controller.ts")))
        expected.push(
          "imports/import-session/vault/import-attachment.controller.ts",
        );
      expect(hits.sort()).toEqual(expected);
    });
  });
});
