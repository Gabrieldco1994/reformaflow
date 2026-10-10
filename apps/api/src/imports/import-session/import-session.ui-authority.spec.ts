import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");
import { ImportVaultGate } from "./vault/vault-state";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import * as ts from "typescript";
import { Module, Injectable, type ExecutionContext } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { ImportSessionDocumentFormat } from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  cleanupImportWorld,
  createBody,
  createScope,
  FIXED_NOW,
  mintGrant,
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionModule } from "./import-session.module";
import { ImportSessionController } from "./import-session.controller";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
  UI_GRANT_TTL_MS,
} from "./import-session-ui-grant";
import {
  ImportUiGuard,
  parseAllowedImportOrigins,
  EnvImportSessionUiOrigins,
  IMPORT_UI_HEADER,
} from "./import-session-ui.guard";
import type { UiImportGrantScope } from "./import-session.contract";

const PREFIX = "imp-ui";
const setup = new PrismaClient();
const prisma = new PrismaService();
const clock = new MutableClock();
const issuer = new ImportUiGrantIssuer(clock);
const capability = {
  writesEnabled: () => true,
  newImportFormats: () => [ImportSessionDocumentFormat.CSV],
} as const;
const availableGate = {
  boot: {
    state: () => "ON",
    stopped: new AbortController().signal,
    runtime: () => ({}),
    recheckLock: async () => ({ ok: true }),
  },
} as unknown as ImportVaultGate;
const service = new ImportSessionService(
  prisma,
  clock,
  capability,
  new RuntimeUiGrantVerifier(),
  ...rawTestDependencies(availableGate, clock, capability),
);
let world: ImportWorld;

const wireCode = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "RESOLVED";
};

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
const requestWith = (
  headers: Record<string, string | string[] | undefined>,
) => ({ headers });

describe("B1a — UI authority (Origin + header + runtime grant), not bypassable", () => {
  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "setInterval",
        "setTimeout",
      ],
    });
    jest.setSystemTime(FIXED_NOW);
    await setup.$connect();
    await prisma.onModuleInit();
    world = await seedImportWorld(setup, PREFIX);
  });
  beforeEach(async () => {
    clock.current = FIXED_NOW;
    await setup.importSession.deleteMany({
      where: { tenantId: world.tenantId },
    });
  });
  afterAll(async () => {
    await cleanupImportWorld(setup, PREFIX);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  describe("allowlist (D1: CORS_ORIGIN split/trim, exact http(s) origins)", () => {
    it('parses exact origins and drops wildcards, paths, bad schemes and "null"', () => {
      expect(
        parseAllowedImportOrigins(
          " http://localhost:3000 , https://app.example.com ",
        ),
      ).toEqual(["http://localhost:3000", "https://app.example.com"]);
      expect(parseAllowedImportOrigins("*")).toEqual([]);
      expect(parseAllowedImportOrigins("null")).toEqual([]);
      expect(parseAllowedImportOrigins("https://*.example.com")).toEqual([]);
      expect(parseAllowedImportOrigins("https://app.example.com/")).toEqual([]);
      expect(parseAllowedImportOrigins("https://app.example.com/path")).toEqual(
        [],
      );
      expect(parseAllowedImportOrigins("ftp://app.example.com")).toEqual([]);
      expect(parseAllowedImportOrigins("http://localhost:3000, *")).toEqual([
        "http://localhost:3000",
      ]);
      expect(parseAllowedImportOrigins("")).toEqual([]);
    });

    it("PRODUCTION without an explicit CORS_ORIGIN denies every UI action (no localhost default)", () => {
      const previousOrigin = process.env["CORS_ORIGIN"];
      const previousEnv = process.env["NODE_ENV"];
      try {
        delete process.env["CORS_ORIGIN"];
        process.env["NODE_ENV"] = "production";
        expect(new EnvImportSessionUiOrigins().allowed()).toEqual([]);
        process.env["CORS_ORIGIN"] = "";
        expect(new EnvImportSessionUiOrigins().allowed()).toEqual([]);
        // An explicit exact origin is honoured in production.
        process.env["CORS_ORIGIN"] = "https://app.example.com";
        expect(new EnvImportSessionUiOrigins().allowed()).toEqual([
          "https://app.example.com",
        ]);
      } finally {
        if (previousOrigin === undefined) delete process.env["CORS_ORIGIN"];
        else process.env["CORS_ORIGIN"] = previousOrigin;
        if (previousEnv === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = previousEnv;
      }
    });

    it("defaults to the current local origin when CORS_ORIGIN is unset OUTSIDE production, and never widens it", () => {
      const previous = process.env["CORS_ORIGIN"];
      try {
        delete process.env["CORS_ORIGIN"];
        expect(new EnvImportSessionUiOrigins().allowed()).toEqual([
          "http://localhost:3000",
        ]);
        process.env["CORS_ORIGIN"] = "*";
        expect(new EnvImportSessionUiOrigins().allowed()).toEqual([]);
        process.env["CORS_ORIGIN"] =
          "https://a.example.com,https://b.example.com";
        expect(new EnvImportSessionUiOrigins().allowed()).toEqual([
          "https://a.example.com",
          "https://b.example.com",
        ]);
      } finally {
        if (previous === undefined) delete process.env["CORS_ORIGIN"];
        else process.env["CORS_ORIGIN"] = previous;
      }
    });
  });

  describe("ImportUiGuard", () => {
    const guard = () =>
      new ImportUiGuard({ allowed: () => ["http://localhost:3000"] }, issuer);
    const denied: Array<
      [string, Record<string, string | string[] | undefined>]
    > = [
      [
        "foreign origin",
        { origin: "https://evil.example", [IMPORT_UI_HEADER]: "1" },
      ],
      ["missing origin", { [IMPORT_UI_HEADER]: "1" }],
      ['"null" origin', { origin: "null", [IMPORT_UI_HEADER]: "1" }],
      ["wildcard origin", { origin: "*", [IMPORT_UI_HEADER]: "1" }],
      [
        "origin with trailing slash",
        { origin: "http://localhost:3000/", [IMPORT_UI_HEADER]: "1" },
      ],
      [
        "origin with different case",
        { origin: "HTTP://LOCALHOST:3000", [IMPORT_UI_HEADER]: "1" },
      ],
      [
        "origin as array",
        {
          origin: ["http://localhost:3000", "http://localhost:3000"],
          [IMPORT_UI_HEADER]: "1",
        },
      ],
      ["missing UI header", { origin: "http://localhost:3000" }],
      [
        "UI header 0",
        { origin: "http://localhost:3000", [IMPORT_UI_HEADER]: "0" },
      ],
      [
        "UI header true",
        { origin: "http://localhost:3000", [IMPORT_UI_HEADER]: "true" },
      ],
      [
        "subdomain of the allowed origin",
        { origin: "http://evil.localhost:3000", [IMPORT_UI_HEADER]: "1" },
      ],
      [
        "allowed host with another port",
        { origin: "http://localhost:3001", [IMPORT_UI_HEADER]: "1" },
      ],
      [
        "allowed origin as prefix of another",
        {
          origin: "http://localhost:3000.evil.example",
          [IMPORT_UI_HEADER]: "1",
        },
      ],
      [
        "scheme downgrade",
        { origin: "https://localhost:3000", [IMPORT_UI_HEADER]: "1" },
      ],
      [
        "origin repeated in one value",
        {
          origin: "http://localhost:3000, http://localhost:3000",
          [IMPORT_UI_HEADER]: "1",
        },
      ],
      [
        "UI header duplicated",
        { origin: "http://localhost:3000", [IMPORT_UI_HEADER]: "1, 1" },
      ],
    ];
    it.each(denied)(
      "denies %s with UI_ACTION_REQUIRED and issues nothing",
      (_label, headers) => {
        const request = requestWith(headers);
        expect(() => guard().canActivate(contextFor(request))).toThrow(
          expect.objectContaining({ code: "UI_ACTION_REQUIRED", status: 403 }),
        );
        expect(() =>
          issuer.issue(
            request,
            authFor(world.users.owner),
            createScope("c", randomUUID()),
          ),
        ).toThrow(expect.objectContaining({ code: "UI_ACTION_REQUIRED" }));
      },
    );

    it("admits the exact origin with the exact header and only then lets the boundary issue a grant", () => {
      const request = requestWith({
        origin: "http://localhost:3000",
        [IMPORT_UI_HEADER]: "1",
      });
      expect(guard().canActivate(contextFor(request))).toBe(true);
      const grant = issuer.issue(
        request,
        authFor(world.users.owner),
        createScope("c", randomUUID()),
      );
      expect(Object.isFrozen(grant)).toBe(true);
      expect(JSON.stringify(grant)).toBe("{}");
    });

    it("denies every origin when the allowlist is empty or the only entry is a wildcard", () => {
      for (const list of [[], parseAllowedImportOrigins("*")]) {
        const request = requestWith({ origin: "*", [IMPORT_UI_HEADER]: "1" });
        const emptyGuard = new ImportUiGuard({ allowed: () => list }, issuer);
        expect(() => emptyGuard.canActivate(contextFor(request))).toThrow(
          expect.objectContaining({ code: "UI_ACTION_REQUIRED" }),
        );
      }
    });
  });

  describe("the service verifies the grant at runtime (a forged/absent grant creates nothing)", () => {
    const sessionCount = () =>
      setup.importSession.count({ where: { tenantId: world.tenantId } });
    const owner = () => authFor(world.users.owner);

    it("the body flag consentAnalyze:true carries no authority without a grant", async () => {
      for (const forged of [
        undefined,
        null,
        {},
        { consentAnalyze: true },
        "grant",
        1,
        [],
        Object.freeze({}),
      ]) {
        const body = createBody(world.cards.pessoal);
        expect(await wireCode(service.create(owner(), body, forged))).toBe(
          "UI_ACTION_REQUIRED",
        );
      }
      expect(await sessionCount()).toBe(0);
    });

    it("rejects a structural copy of a valid grant (identity, not shape)", async () => {
      const requestId = randomUUID();
      const auth = owner();
      const real = mintGrant(
        issuer,
        auth,
        createScope(world.cards.pessoal, requestId),
      );
      const copy = Object.freeze({ ...(real as object) });
      expect(
        await wireCode(
          service.create(
            auth,
            createBody(world.cards.pessoal, requestId),
            copy,
          ),
        ),
      ).toBe("UI_ACTION_REQUIRED");
      expect(await sessionCount()).toBe(0);
    });

    const mismatches: Array<
      [string, (requestId: string) => UiImportGrantScope]
    > = [
      ["another card", () => createScope(world.cards.casa, "x")],
      [
        "another createRequestId",
        () => createScope(world.cards.pessoal, randomUUID()),
      ],
      [
        "the reserve operation",
        () => ({
          operation: "RESERVE_ATTACHMENTS",
          sessionId: "s",
          expectedRevision: 1,
        }),
      ],
      [
        "the upload operation",
        () => ({
          operation: "UPLOAD_CONTENT",
          sessionId: "s",
          attachmentId: "a",
          uploadGeneration: 0,
        }),
      ],
      [
        "the cancel operation",
        () => ({
          operation: "CANCEL_SESSION",
          sessionId: "s",
          expectedRevision: 1,
        }),
      ],
      [
        "another consent policy version",
        (requestId) => ({
          ...createScope(world.cards.pessoal, requestId),
          consentPolicyVersion: 2,
        }),
      ],
    ];
    it.each(mismatches)(
      "rejects a grant minted for %s",
      async (_label, scopeFor) => {
        const requestId = randomUUID();
        const auth = owner();
        const grant = mintGrant(issuer, auth, scopeFor(requestId));
        // Either the grant scope differs from the body (card/requestId) or it is another operation.
        const body = createBody(world.cards.pessoal, requestId);
        expect(await wireCode(service.create(auth, body, grant))).toBe(
          "UI_ACTION_REQUIRED",
        );
        expect(await sessionCount()).toBe(0);
      },
    );

    it("rejects another actor's grant, an expired grant and a grant beyond the token lifetime", async () => {
      const requestId = randomUUID();
      const body = createBody(world.cards.pessoal, requestId);
      const scope = createScope(world.cards.pessoal, requestId);
      const peerGrant = mintGrant(issuer, authFor(world.users.peer), scope);
      expect(await wireCode(service.create(owner(), body, peerGrant))).toBe(
        "UI_ACTION_REQUIRED",
      );

      const auth = owner();
      const grant = mintGrant(issuer, auth, scope);
      clock.current = new Date(FIXED_NOW.getTime() + UI_GRANT_TTL_MS);
      expect(await wireCode(service.create(auth, body, grant))).toBe(
        "UI_ACTION_REQUIRED",
      );

      clock.current = FIXED_NOW;
      const shortLived = authFor(world.users.owner, {
        expiresAt: new Date(FIXED_NOW.getTime() + 5_000),
      });
      const shortGrant = mintGrant(issuer, shortLived, scope);
      clock.current = new Date(FIXED_NOW.getTime() + 5_000);
      expect(
        await wireCode(service.create(shortLived, body, shortGrant)),
      ).toMatch(/^(UI_ACTION_REQUIRED|UNAUTHENTICATED)$/);
      expect(await sessionCount()).toBe(0);
    });

    it("a grant is single-use: the second presentation of the very same grant is refused", async () => {
      const requestId = randomUUID();
      const auth = owner();
      const body = createBody(world.cards.pessoal, requestId);
      const grant = mintGrant(
        issuer,
        auth,
        createScope(world.cards.pessoal, requestId),
      );
      expect((await service.create(auth, body, grant)).created).toBe(true);
      expect(await wireCode(service.create(auth, body, grant))).toBe(
        "UI_ACTION_REQUIRED",
      );
      expect(await sessionCount()).toBe(1);

      const seeded = await seedSession(setup, world);
      const cancelGrant = mintGrant(issuer, auth, {
        operation: "CANCEL_SESSION",
        sessionId: seeded.id,
        expectedRevision: 1,
      });
      await service.cancel(
        auth,
        seeded.id,
        { expectedRevision: 1 },
        cancelGrant,
      );
      expect(
        await wireCode(
          service.cancel(auth, seeded.id, { expectedRevision: 1 }, cancelGrant),
        ),
      ).toBe("UI_ACTION_REQUIRED");
    });

    it("control: a grant for exactly this scope, used before its TTL, creates the session", async () => {
      const requestId = randomUUID();
      const auth = owner();
      const grant = mintGrant(
        issuer,
        auth,
        createScope(world.cards.pessoal, requestId),
      );
      clock.current = new Date(FIXED_NOW.getTime() + UI_GRANT_TTL_MS - 1);
      const result = await service.create(
        auth,
        createBody(world.cards.pessoal, requestId),
        grant,
      );
      expect(result.created).toBe(true);
    });

    it("cancel demands a grant bound to this session and revision", async () => {
      const seeded = await seedSession(setup, world);
      const auth = owner();
      const cancel = (grant: unknown, revision = 1) =>
        service.cancel(auth, seeded.id, { expectedRevision: revision }, grant);
      expect(await wireCode(cancel(undefined))).toBe("UI_ACTION_REQUIRED");
      expect(await wireCode(cancel({}))).toBe("UI_ACTION_REQUIRED");
      expect(
        await wireCode(
          cancel(
            mintGrant(issuer, auth, {
              operation: "CANCEL_SESSION",
              sessionId: randomUUID(),
              expectedRevision: 1,
            }),
          ),
        ),
      ).toBe("UI_ACTION_REQUIRED");
      expect(
        await wireCode(
          cancel(
            mintGrant(issuer, auth, {
              operation: "CANCEL_SESSION",
              sessionId: seeded.id,
              expectedRevision: 2,
            }),
          ),
        ),
      ).toBe("UI_ACTION_REQUIRED");
      expect(
        await wireCode(
          cancel(
            mintGrant(
              issuer,
              auth,
              createScope(world.cards.pessoal, randomUUID()),
            ),
          ),
        ),
      ).toBe("UI_ACTION_REQUIRED");
      expect(
        (
          await setup.importSession.findUniqueOrThrow({
            where: { id: seeded.id },
          })
        ).state,
      ).toBe("DRAFT");
      const view = await cancel(
        mintGrant(issuer, auth, {
          operation: "CANCEL_SESSION",
          sessionId: seeded.id,
          expectedRevision: 1,
        }),
      );
      expect(view.state).toBe("CANCELLED");
    });
  });

  describe("tools cannot reach this authority", () => {
    const SRC = join(__dirname, "..", "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory()
          ? walk(full)
          : full.endsWith(".ts")
            ? [full]
            : [];
      });

    it("only named contextual consumers reference the boundary, never its grant issuer", () => {
      const offenders = walk(join(SRC, "agent")).filter((file) =>
        /import-session|ImportUiGrantIssuer|UiImportPersistenceGrant/.test(
          readFileSync(file, "utf8"),
        ),
      );
      expect(offenders.map((file) => relative(SRC, file))).toEqual([
        "agent/agent.controller.ts",
        "agent/agent.import-chat.http.contract.spec.ts",
        "agent/agent.import-chat.loop.contract.spec.ts",
        "agent/agent.module.ts",
        "agent/agent.service.ts",
        "agent/evals/issue-716/issue-716.offline.spec.ts",
        "agent/tools/agent-tools.service.classify-fallback.spec.ts",
        "agent/tools/agent-tools.service.ts",
      ]);
      expect(
        offenders.filter(
          (file) =>
            !file.endsWith(".spec.ts") &&
            /ImportUiGrantIssuer|UiImportPersistenceGrant/.test(
              readFileSync(file, "utf8"),
            ),
        ),
      ).toEqual([]);
    });

    it("only the import-session boundary files import the grant issuer", () => {
      const allowed = new Set([
        "imports/import-session/import-session.module.ts",
        "imports/import-session/import-session.controller.ts",
        "imports/import-session/import-session-ui.guard.ts",
        "imports/import-session/import-session-ui-grant.ts",
        "imports/import-session/vault/import-attachment.controller.ts",
      ]);
      const importers = walk(SRC)
        .filter(
          (file) => !/\.spec\.ts$/.test(file) && !file.includes("test-utils"),
        )
        .filter((file) =>
          /import-session-ui-grant/.test(readFileSync(file, "utf8")),
        )
        .map((file) => relative(SRC, file));
      expect(importers.filter((file) => !allowed.has(file))).toEqual([]);
    });

    it("only the verified-JWT guard mints an authenticated context (plus the test harness)", () => {
      const allowed = new Set([
        "imports/import-session/import-session.auth.ts",
      ]);
      const minters = walk(SRC)
        .filter(
          (file) => !/\.spec\.ts$/.test(file) && !file.includes("test-utils"),
        )
        .filter((file) =>
          /mintImportAuthContext/.test(readFileSync(file, "utf8")),
        )
        .map((file) => relative(SRC, file));
      expect(minters.filter((file) => !allowed.has(file))).toEqual([]);
    });

    it("pins financial admission, request assertion and writer calls by symbol, not just boundary imports", () => {
      const matrix: Record<string, readonly string[]> = {
        assertImportAuthForRequest: [
          "imports/import-session/import-session-ui-grant.ts",
          "imports/import-session/import-session.auth.ts",
          "imports/import-session/import-chat.admission.ts",
        ],
        readImportAuthForRequest: [
          "imports/import-session/import-chat.guard.ts",
          "imports/import-session/import-session-operation-throttle.guard.ts",
        ],
        registerPendingImportChat: [
          "imports/import-session/import-chat.guard.ts",
        ],
        activateImportChat: ["imports/import-session/import-chat.bridge.ts"],
        releaseImportChat: ["imports/import-session/import-chat.bridge.ts"],
        importChatAuth: ["imports/import-session/import-chat.bridge.ts"],
        reserveImportChatOperation: [
          "imports/import-session/import-chat.bridge.ts",
        ],
        reservedImportChatWrite: [
          "imports/import-session/import-session-workflow.service.ts",
        ],
        assertLiveImportConversationWrite: [
          "imports/import-session/import-chat.admission.ts",
          "imports/import-session/import-session-workflow.service.ts",
        ],
        bindImportChatToolContext: ["agent/agent.service.ts"],
        rememberImportChatOutcome: ["agent/tools/agent-tools.service.ts"],
        rememberImportChatView: [
          "imports/import-session/import-chat.bridge.ts",
        ],
        markImportChatStarted: ["imports/import-session/import-chat.bridge.ts"],
        mintImportAuthContext: [
          "imports/import-session/import-session.auth.ts",
        ],
        attestRequest: ["imports/import-session/import-session-ui.guard.ts"],
        issueFinancialAction: [
          "imports/import-session/import-session.controller.ts",
        ],
        verifyFinancialAction: [
          "imports/import-session/import-session-workflow.service.ts",
        ],
        runImportSessionWrite: [
          "imports/import-session/import-session-interpretation.service.ts",
          "imports/import-session/import-session-workflow.service.ts",
          "imports/import-session/import-session.extraction.service.ts",
          "imports/import-session/import-session.service.ts",
          "imports/import-session/vault/import-upload.service.ts",
          "imports/import-session/vault/vault-reaper.ts",
        ],
        isRetryableWriteFailure: [
          "imports/import-session/import-session.service.ts",
          "imports/import-session/import-session.writer.ts",
          "imports/import-session/vault/vault-purger.ts",
        ],
      };
      const files = walk(SRC).filter(
        (file) =>
          !/\.(spec|test|d)\.ts$/.test(file) && !file.includes("test-utils"),
      );
      const present = new Set(files.map((file) => relative(SRC, file)));
      const callers: Record<string, Set<string>> = {};
      for (const path of files) {
        const source = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) {
            const name = ts.isIdentifier(node.expression)
              ? node.expression.text
              : ts.isPropertyAccessExpression(node.expression)
                ? node.expression.name.text
                : "";
            if (Object.prototype.hasOwnProperty.call(matrix, name))
              (callers[name] ??= new Set()).add(relative(SRC, path));
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      for (const [symbol, paths] of Object.entries(matrix))
        expect({
          symbol,
          callers: [...(callers[symbol] ?? [])].sort(),
        }).toEqual({
          symbol,
          callers: paths.filter((path) => present.has(path)).sort(),
        });
    });

    it("contextual exports do not let another module inject the issuer", async () => {
      @Injectable()
      class Stranger {
        constructor(readonly issuer: ImportUiGrantIssuer) {}
      }
      @Module({ imports: [ImportSessionModule], providers: [Stranger] })
      class StrangerModule {}
      await expect(
        Test.createTestingModule({ imports: [StrangerModule] }).compile(),
      ).rejects.toThrow();
    });

    it("exposes exactly the eighteen dedicated routes and no generic draft mutation", () => {
      const proto = ImportSessionController.prototype as unknown as Record<
        string,
        unknown
      >;
      const routes = Object.getOwnPropertyNames(proto)
        .filter((name) => name !== "constructor")
        .map(
          (name) =>
            `${Reflect.getMetadata(METHOD_METADATA, proto[name] as object)} ${Reflect.getMetadata(PATH_METADATA, proto[name] as object)}`,
        )
        .sort();
      expect(Reflect.getMetadata(PATH_METADATA, ImportSessionController)).toBe(
        "import-sessions",
      );
      // RequestMethod: GET=0, POST=1. A PATCH entry here reopens generic draft authority.
      expect(routes).toEqual(
        [
          "0 /",
          "0 :id",
          "0 :id/result",
          "0 :id/observations",
          "0 :id/candidates",
          "0 :id/current-lot",
          "1 /",
          "1 :id/cancel",
          "1 :id/declarations",
          "1 :id/resolutions",
          "1 :id/defer",
          "1 :id/reactivate",
          "1 :id/current-lot/prepare",
          "1 :id/current-lot/continue",
          "1 :id/interpretations",
          "1 :id/confirmation-challenge",
          "1 :id/confirm",
          "1 :id/execute",
        ].sort(),
      );
    });
  });
});
