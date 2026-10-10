const testDbGuard: {
  REPO_ROOT: string;
  ACTIVE_DB_PATH: string;
} = require("../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { basename, resolve } from "node:path";
import { Module, ValidationPipe, type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import type { ImportChatTurnV1 } from "@reformaflow/domain";
import cookieParser from "cookie-parser";
import type { Request } from "express";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import {
  assertImportAuthForRequest,
  assertMintedImportContext,
} from "../imports/import-session/import-session.auth";
import {
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  type ImportSessionCapability,
} from "../imports/import-session/import-session.capability";
import { ImportSessionModule } from "../imports/import-session/import-session.module";
import { ImportSessionService } from "../imports/import-session/import-session.service";
import { IMPORT_SESSION_UI_ORIGINS } from "../imports/import-session/import-session-ui.guard";
import { PrismaService } from "../prisma/prisma.service";
import {
  FIXED_NOW,
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../test-utils/import-session-harness";
import { AgentModule } from "./agent.module";
import { AgentService } from "./agent.service";
import { AgentDailyQuotaGuard } from "./agent-daily-quota.guard";
import { AgentChatThrottleGuard } from "./agent-chat-throttle.guard";
import type { ImportChatRead } from "./import-chat.contract";
import { LLM_PROVIDER, type LlmProvider } from "./llm/llm.types";
import { AgentToolsService } from "./tools/agent-tools.service";

const evidenceRoot =
  process.env.P08_QA_EVIDENCE ??
  resolve(testDbGuard.REPO_ROOT, ".agents/p08-contextual-evidence");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidenceDirectory = mkdtempSync(resolve(evidenceRoot, "http-"));
const suiteRun = basename(evidenceDirectory);

const ORIGIN = "http://localhost:3000";
const UI = { origin: ORIGIN, "x-rf-import-ui": "1" };
const TURN_ID = "9cad9057-c2d4-4ddd-bc49-79e651b9a001";
const clock = new MutableClock(FIXED_NOW);
const local: LlmProvider = {
  id: "qa-local",
  isConfigured: () => true,
  chat: jest.fn(async () => ({ content: "Resposta local.", toolCalls: [] })),
};

@Module({
  imports: [AuthModule, AgentModule, ImportSessionModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ModulesGuard },
    { provide: APP_GUARD, useClass: ProjectAccessGuard },
  ],
})
class ContextualHttpModule {}

// Structural observation of the frozen bridge API, not a substitute implementation.
interface Bridge {
  contextForRequest(request: object): object | null;
  read(admission: object, query: ImportChatRead): Promise<unknown>;
  release(admission: object): void;
}

function object(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function bridgeFrom(app: INestApplication): Bridge {
  const file = resolve(
    __dirname,
    "../imports/import-session/import-chat.bridge.ts",
  );
  expect({ bridgeImplemented: existsSync(file) }).toEqual({
    bridgeImplemented: true,
  });
  const exports: unknown = require(file);
  const token = object(exports).ImportChatBridge;
  expect(typeof token).toBe("function");
  if (typeof token !== "function") throw new Error("Missing ImportChatBridge");
  return app.get<Bridge>(token);
}

function proveDatabase(label: string): void {
  const expected = testDbGuard.ACTIVE_DB_PATH;
  expect(process.env.DATABASE_URL).toBe(`file:${expected}`);
  const raw = execFileSync(
    "lsof",
    ["-nP", "-a", "-p", String(process.pid), "-Fn"],
    {
      encoding: "utf8",
    },
  );
  writeFileSync(resolve(evidenceDirectory, `${label}.lsof`), raw, {
    mode: 0o600,
    flag: "wx",
  });
  const dbFiles = raw
    .split("\n")
    .filter((line) =>
      /^n.*\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$/.test(line),
    )
    .map((line) => line.slice(1));
  expect(dbFiles).toContain(expected);
  expect(
    dbFiles.filter(
      (file) =>
        ![
          expected,
          `${expected}-wal`,
          `${expected}-shm`,
          `${expected}-journal`,
        ].includes(file),
    ),
  ).toEqual([]);
}

describe("P08 HTTP/admission contract (real HTTP, guards and PrismaService)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let world: ImportWorld;
  let sessionId: string;
  let port: number;
  let request: Request;
  let tick = 0;

  function turn(
    intent: "CONTINUE" | "OPEN_REVIEW" | "READ_RESULT" = "CONTINUE",
  ): ImportChatTurnV1 {
    return {
      version: 1,
      turnId: TURN_ID,
      sessionId,
      expectedRevision: 1,
      channel: "TEXT",
      literalAnswer: "Continuar",
      intent,
      focus: null,
      scope: null,
    };
  }

  const body = (importTurn: unknown) => ({
    messages: [{ role: "user", content: "Continuar" }],
    importTurn,
  });

  async function tokenFor(userId = world.users.owner.id): Promise<string> {
    return app
      .get(AuthService)
      .issueToken(await db.user.findUniqueOrThrow({ where: { id: userId } }));
  }

  function call(
    payload: unknown,
    token?: string,
    headers: Record<string, string> = UI,
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolveReply, reject) => {
      const text = JSON.stringify(payload);
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/agent/chat",
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(text),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const json: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            resolveReply({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.end(text);
    });
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      now: FIXED_NOW,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    const module = await Test.createTestingModule({
      imports: [ContextualHttpModule],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(local)
      .overrideProvider(IMPORT_SESSION_CLOCK)
      .useValue(clock)
      .overrideProvider(IMPORT_SESSION_CAPABILITY)
      .useValue({
        writesEnabled: () => false,
        newImportFormats: () => [],
      } satisfies ImportSessionCapability)
      .overrideProvider(IMPORT_SESSION_UI_ORIGINS)
      .useValue({ allowed: () => [ORIGIN] })
      .compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.use((req: Request, _res: unknown, next: () => void) => {
      request = req;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    db = app.get(PrismaService);
    proveDatabase("http-first-connect-before-seed");
    const databases = await db.$queryRaw<
      Array<{ file: string }>
    >`PRAGMA database_list`;
    expect(databases.map((row) => row.file).filter(Boolean)).toEqual([
      testDbGuard.ACTIVE_DB_PATH,
    ]);
    world = await seedImportWorld(db, `p08-http-contract-${suiteRun}`);
    await app.listen(0, "127.0.0.1");
    const address: unknown = app.getHttpServer().address();
    const number = object(address).port;
    if (typeof number !== "number" || number <= 0)
      throw new Error("No ephemeral port");
    port = number;
    proveDatabase("http-boot-before-request");
  });

  beforeEach(async () => {
    tick++;
    clock.current = new Date(FIXED_NOW.getTime() + tick * 61_000);
    jest.setSystemTime(clock.current);
    jest.mocked(local.chat).mockClear();
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("External fetch forbidden in P08 QA"));
    await db.agentDailyQuota.updateMany({
      where: { tenantId: world.tenantId },
      data: { count: 0 },
    });
    sessionId = (await seedSession(db, world)).id;
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    jest.useRealTimers();
  });

  it("CONTROL: absent importTurn keeps generic signatures, primer and response", async () => {
    const primer = jest.spyOn(app.get(AgentToolsService), "buildPrimer");
    const result = await call(
      { messages: [{ role: "user", content: "Oi" }] },
      await tokenFor(),
      {},
    );
    expect(result.status).toBe(201);
    expect(result.json).toEqual({
      reply: "Resposta local.",
      toolsUsed: [],
      provider: "qa-local",
    });
    expect(primer).toHaveBeenCalledTimes(1);
    expect(local.chat).toHaveBeenCalledTimes(1);
    const args = jest.mocked(local.chat).mock.calls[0]!;
    expect(args).toHaveLength(2);
    expect(args[0][0]?.role).toBe("system");
    expect(args[1].map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "create_expense",
        "create_receipt",
        "create_recurring_expense",
        "check_price_monitor_item",
      ]),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "CONTINUE"],
    ["empty", {}],
    ["extra authority", { tenantId: "forged", version: 1 }],
  ])(
    "present invalid importTurn (%s) never falls back to generic",
    async (_name, invalid) => {
      const agent = jest.spyOn(app.get(AgentService), "chat");
      const result = await call(body(invalid), await tokenFor());
      expect(result.status).toBe(400);
      expect(agent).not.toHaveBeenCalled();
      expect(local.chat).not.toHaveBeenCalled();
      expect(object(result.json)).not.toHaveProperty("reply");
    },
  );

  it.each(["tenantId", "nonce", "grant", "confirmed", "replaceLines"])(
    "rejects the extra %s even on an otherwise valid envelope",
    async (extra) => {
      const result = await call(
        body({ ...turn(), [extra]: "forged" }),
        await tokenFor(),
      );
      expect(result.status).toBe(400);
      expect(local.chat).not.toHaveBeenCalled();
    },
  );

  it("JWT rejection precedes contextual/provider/quota work", async () => {
    const quota = jest.spyOn(app.get(AgentDailyQuotaGuard), "canActivate");
    const result = await call(body(turn()));
    expect(result.status).toBe(401);
    expect(quota).not.toHaveBeenCalled();
    expect(local.chat).not.toHaveBeenCalled();
    expect(object(result.json)).not.toHaveProperty("reply");
  });

  it.each<Record<string, string>>([
    {},
    { origin: "https://invalid.example", "x-rf-import-ui": "1" },
    { origin: ORIGIN },
  ])(
    "UI rejection precedes throttle/quota and does not require an outcome: %j",
    async (headers) => {
      const throttle = jest.spyOn(
        app.get(AgentChatThrottleGuard),
        "canActivate",
      );
      const quota = jest.spyOn(app.get(AgentDailyQuotaGuard), "canActivate");
      const result = await call(body(turn()), await tokenFor(), headers);
      expect(result.status).toBe(403);
      expect(throttle).not.toHaveBeenCalled();
      expect(quota).not.toHaveBeenCalled();
      expect(local.chat).not.toHaveBeenCalled();
    },
  );

  it("presented JWT without exp stays valid only on the generic route", async () => {
    const token = new JwtService({
      secret: process.env.JWT_SECRET ?? "dev-secret-change-me",
    }).sign(
      {
        sub: world.users.owner.id,
        tenantId: world.tenantId,
        sv: 0,
      },
      { noTimestamp: true },
    );
    expect(
      (await call({ messages: [{ role: "user", content: "Oi" }] }, token, {}))
        .status,
    ).toBe(201);
    jest.mocked(local.chat).mockClear();
    expect((await call(body(turn()), token)).status).toBe(401);
    expect(local.chat).not.toHaveBeenCalled();
  });

  it.each(["quota", "pipe", "throttle"] as const)(
    "PENDING is never activated when the later %s rejects",
    async (failure) => {
      const bridge = bridgeFrom(app);
      const activate = jest.spyOn(bridge, "contextForRequest");
      const release = jest.spyOn(bridge, "release");
      const agent = jest.spyOn(app.get(AgentService), "chat");
      if (failure === "quota") {
        await db.agentDailyQuota.upsert({
          where: {
            tenantId_dayKey: {
              tenantId: world.tenantId,
              dayKey: clock.current.toISOString().slice(0, 10),
            },
          },
          create: {
            tenantId: world.tenantId,
            dayKey: clock.current.toISOString().slice(0, 10),
            count: 30,
          },
          update: { count: 30 },
        });
      }
      const pendingTurn: ImportChatTurnV1 = {
        ...turn(),
        intent: "ANSWER",
        focus: {
          id: "question-amount",
          field: "amountCents",
          lineIds: ["line-unknown"],
        },
        scope: { kind: "LINES", lineIds: ["line-unknown"] },
      };
      const token = await tokenFor();
      if (failure === "throttle") {
        for (let i = 0; i < 30; i++) {
          expect(
            (await call({ ...body(pendingTurn), unrelated: true }, token))
              .status,
          ).toBe(400);
        }
      }
      const payload =
        failure === "pipe"
          ? { ...body(pendingTurn), unrelated: true }
          : body(pendingTurn);
      const result = await call(payload, token);
      expect(result.status).toBe(failure === "pipe" ? 400 : 429);
      expect(activate).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
      expect(local.chat).not.toHaveBeenCalled();
      expect(bridge.contextForRequest({ ...request })).toBeNull();
    },
  );

  it.each(["success", "error"] as const)(
    "ACTIVE is request-bound and finally revoked on %s",
    async (path) => {
      const bridge = bridgeFrom(app);
      const activate = jest.spyOn(bridge, "contextForRequest");
      const release = jest.spyOn(bridge, "release");
      const reads = jest.spyOn(ImportSessionService.prototype, "getSession");
      const token = await tokenFor();
      const claims: unknown = new JwtService().decode(token);
      const exp = object(claims).exp;
      if (typeof exp !== "number") throw new Error("Test token has no exp");
      const payload = body(
        path === "error" ? { ...turn(), sessionId: "missing-session" } : turn(),
      );
      const result = await call(payload, token);
      expect(activate).toHaveBeenCalledTimes(1);
      const admission = activate.mock.results[0]?.value;
      if (!admission || typeof admission !== "object")
        throw new Error("No ACTIVE admission");
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(admission);
      expect(activate.mock.calls[0]?.[0]).toBe(request);
      expect(bridge.contextForRequest({ ...request })).toBeNull();
      await expect(
        bridge.read(admission, { kind: "SESSION" }),
      ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
      expect(reads).toHaveBeenCalled();
      const auth = reads.mock.calls[0]![0];
      expect(auth.presentedSessionVersion).toBe(0);
      expect(auth.tokenExpiresAt).toBe(new Date(exp * 1000).toISOString());
      expect(Object.isFrozen(auth)).toBe(true);
      expect(() => assertMintedImportContext(auth)).not.toThrow();
      expect(() => assertImportAuthForRequest(request, auth)).not.toThrow();
      expect(() => assertImportAuthForRequest({ ...request }, auth)).toThrow();
      expect(() => assertMintedImportContext({ ...auth })).toThrow();
      expect(local.chat).not.toHaveBeenCalled();
      if (path === "error") {
        expect(result.status).toBe(404);
        expect(object(result.json).importOutcome).toMatchObject({
          version: 1,
          turnId: TURN_ID,
          kind: "ERROR",
          code: "NOT_FOUND",
          acknowledgment: "NONE",
          ref: null,
        });
        expect(Object.keys(object(result.json))).toEqual(["importOutcome"]);
      } else {
        expect(result.status).toBe(201);
        expect(object(result.json).importOutcome).toEqual({
          version: 1,
          turnId: TURN_ID,
          kind: "REVISED_SESSION",
          acknowledgment: "NONE",
          ref: { sessionId, revision: 1 },
        });
      }
    },
  );
});
