const dbGuard: {
  REPO_ROOT: string;
} = require("../../../../../scripts/test-db-env.cjs");

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Logger, ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { AppModule } from "../../app.module";
import { AuthService } from "../../auth/auth.service";
import {
  INCLUDE_SOFT_DELETED,
  PrismaService,
} from "../../prisma/prisma.service";
import {
  createBody,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
  type WorldUser,
} from "../../test-utils/import-session-harness";
import { seedApplied } from "../../test-utils/import-session-recovery-harness";
import {
  canonicalVaultFixture,
  createVaultTestDatabase,
  finishVaultFixture,
  UI_HEADERS,
} from "../../test-utils/import-session-vault-harness";
import {
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
} from "./import-session.capability";
import { registerImportUploadFraming } from "./vault/vault-framing";
import { IMPORT_VAULT_GATE, ImportVaultGate } from "./vault/vault-state";

type Reply = { status: number; text: string; json: any };

type RunningApp = {
  app: INestApplication;
  prisma: PrismaService;
  capability: ImportSessionCapability;
  gate: ImportVaultGate;
  tokenFor(user: WorldUser): Promise<string>;
  call(
    method: string,
    path: string,
    options?: {
      token?: string;
      headers?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<Reply>;
  close(): Promise<void>;
};

const previousEnvironment = new Map<string, string | undefined>();
const managedEnvironment = [
  "AUTH_ENABLE_REGISTER",
  "CORS_ORIGIN",
  "IMPORT_SESSION_INTAKE_MODE",
  "IMPORT_VAULT_DRAIN_TIMEOUT_MS",
  "IMPORT_VAULT_ENABLED",
  "IMPORT_VAULT_HEADROOM_BYTES",
  "IMPORT_VAULT_IDLE_TIMEOUT_MS",
  "IMPORT_VAULT_LOCK_FD",
  "PRIVATE_UPLOADS_DIR",
  "UPLOADS_DIR",
  "VAULT_DIR",
] as const;

function setEnvironment(key: string, value: string | undefined) {
  if (!previousEnvironment.has(key))
    previousEnvironment.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnvironment() {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment.clear();
}

async function startApp(options: {
  mode?: "csv";
  runtime: "live" | "unavailable";
}): Promise<RunningApp> {
  const fixture = await canonicalVaultFixture(undefined, 2_000);
  for (const key of managedEnvironment) setEnvironment(key, undefined);
  for (const [key, value] of Object.entries(fixture.env))
    setEnvironment(key, value);
  setEnvironment(
    "IMPORT_SESSION_INTAKE_MODE",
    options.mode === "csv" ? "csv" : undefined,
  );
  if (options.runtime === "unavailable")
    setEnvironment("IMPORT_VAULT_ENABLED", "false");
  setEnvironment("AUTH_ENABLE_REGISTER", "1");
  setEnvironment("CORS_ORIGIN", "http://localhost:3000");

  let app: INestApplication | undefined;
  try {
    // Deliberately no provider override: this is the production AppModule graph.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.enableCors({ origin: "http://localhost:3000", credentials: true });
    registerImportUploadFraming(app);
    await app.listen(0, "127.0.0.1");

    const prisma = app.get(PrismaService);
    const auth = app.get(AuthService);
    const capability = app.get<ImportSessionCapability>(
      IMPORT_SESSION_CAPABILITY,
    );
    const gate = app.get<ImportVaultGate>(IMPORT_VAULT_GATE);
    expect(prisma).toBeInstanceOf(PrismaService);
    expect(capability).toBe(
      app.get<ImportSessionCapability>(IMPORT_SESSION_CAPABILITY),
    );
    expect(gate).toBe(app.get<ImportVaultGate>(IMPORT_VAULT_GATE));

    const port = (app.getHttpServer().address() as AddressInfo).port;
    return {
      app,
      prisma,
      capability,
      gate,
      tokenFor: async (user) =>
        auth.issueToken(
          await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
        ),
      call: (method, path, options = {}) =>
        new Promise<Reply>((resolve, reject) => {
          const payload =
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body);
          const headers: Record<string, string> = {
            ...(options.headers ?? {}),
          };
          if (payload !== undefined) {
            headers["content-type"] = "application/json";
            headers["content-length"] = String(Buffer.byteLength(payload));
          }
          if (options.token) headers.authorization = `Bearer ${options.token}`;
          const request = http.request(
            {
              host: "127.0.0.1",
              port,
              method,
              path,
              headers,
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(chunk));
              response.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json: unknown = null;
                try {
                  json = JSON.parse(text);
                } catch {
                  // Generic Nest failures are still asserted by status/text.
                }
                resolve({
                  status: response.statusCode ?? 0,
                  text,
                  json,
                });
              });
            },
          );
          request.on("error", reject);
          if (payload !== undefined) request.write(payload);
          request.end();
        }),
      close: () =>
        finishVaultFixture(
          () => app?.close(),
          () => fixture.close(),
          restoreEnvironment,
        ),
    };
  } catch (error) {
    await finishVaultFixture(
      () => app?.close(),
      () => fixture.close(),
      restoreEnvironment,
    );
    throw error;
  }
}

function exactError(
  code: "CAPABILITY_DISABLED" | "NOT_FOUND",
  retryable: boolean,
) {
  return {
    code,
    retryable,
    sessionId: null,
    currentRevision: null,
    reason: null,
  };
}

describe("production CSV entry over the real AppModule", () => {
  let database: Awaited<ReturnType<typeof createVaultTestDatabase>>;
  let db: PrismaService;
  let running: RunningApp | undefined;
  let world: ImportWorld;
  let sequence = 0;

  beforeAll(async () => {
    jest.useFakeTimers({
      now: FIXED_NOW,
      doNotFake: [
        "nextTick",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    database = await createVaultTestDatabase();
    db = database.setup;
    const migrations = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*) AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    expect(Number(migrations[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(database.file).not.toMatch(/dev\.db$/);
    expect(database.file.startsWith(dbGuard.REPO_ROOT)).toBe(true);
  });

  beforeEach(async () => {
    jest.setSystemTime(FIXED_NOW);
    world = await seedImportWorld(db, `entry-production-${++sequence}`);
  });

  afterEach(async () => {
    try {
      await running?.close();
    } finally {
      running = undefined;
      jest.restoreAllMocks();
      restoreEnvironment();
    }
  });

  afterAll(async () => {
    try {
      await finishVaultFixture(
        () => running?.close(),
        () => database?.close(),
        restoreEnvironment,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  async function boot(options: {
    mode?: "csv";
    runtime: "live" | "unavailable";
  }) {
    running = await startApp(options);
    return running;
  }

  async function rows() {
    const where = {
      tenantId: { in: [world.tenantId, world.otherTenantId] },
    };
    const orderBy = { id: "asc" as const };
    return {
      sessions: await db.importSession.findMany({ where, orderBy }),
      references: await db.importSessionArtifact.findMany({ where, orderBy }),
      artifacts: await db.importArtifact.findMany({ where, orderBy }),
      observations: await db.importObservation.findMany({ where, orderBy }),
      expenses: await db.expense.findMany({
        where: { ...where, deletedAt: INCLUDE_SOFT_DELETED },
        orderBy,
      }),
      receipts: await db.receipt.findMany({
        where: { ...where, deletedAt: INCLUDE_SOFT_DELETED },
        orderBy,
      }),
      cash: await db.cashFlowEntry.findMany({
        where: { ...where, deletedAt: INCLUDE_SOFT_DELETED },
        orderBy,
      }),
      allocations: await db.rateioAllocation.findMany({ where, orderBy }),
    };
  }

  it("IMPORT_SESSION_INTAKE_MODE=csv plus a live vault emits only the versioned CSV entry", async () => {
    const app = await boot({ mode: "csv", runtime: "live" });
    expect(app.gate.boot.runtime()).not.toBeNull();
    expect(app.gate.boot.stopped.aborted).toBe(false);
    const token = await app.tokenFor(world.users.owner);

    const response = await app.call("GET", "/import-sessions", { token });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      items: [],
      nextCursor: null,
      entry: {
        version: 1,
        kind: "CARD_INVOICE",
        formats: ["CSV"],
      },
    });
  });

  it.each([
    {
      label: "intake mode off",
      mode: undefined,
      runtime: "live" as const,
      reason: "NOT_ENABLED",
      arrange: undefined,
    },
    {
      label: "vault runtime unavailable",
      mode: "csv" as const,
      runtime: "unavailable" as const,
      reason: "RUNTIME_UNAVAILABLE",
      arrange: undefined,
    },
    {
      label: "no qualified producer formats",
      mode: "csv" as const,
      runtime: "live" as const,
      reason: "NO_QUALIFIED_FORMAT",
      arrange: (app: RunningApp) =>
        jest.spyOn(app.capability, "newImportFormats").mockReturnValue([]),
    },
  ])(
    "$label has an exact bounded reason and CREATE collapses to the public 503",
    async ({ mode, runtime, reason, arrange }) => {
      const app = await boot({ mode, runtime });
      arrange?.(app);
      const token = await app.tokenFor(world.users.owner);
      const before = await rows();

      const page = await app.call("GET", "/import-sessions", { token });
      expect([page.status, page.json]).toEqual([
        200,
        {
          items: [],
          nextCursor: null,
          entry: { version: 1, kind: "UNAVAILABLE", reason },
        },
      ]);

      const create = await app.call("POST", "/import-sessions", {
        token,
        headers: UI_HEADERS,
        body: createBody(world.cards.pessoal),
      });
      expect([create.status, create.json]).toEqual([
        503,
        exactError("CAPABILITY_DISABLED", true),
      ]);
      expect(await rows()).toEqual(before);
    },
  );

  it.each([
    ["sparse", Array<"CSV">(1)],
    ["duplicate", ["CSV", "CSV"]],
    ["unknown", ["PRIVATE_STORAGE_FORMAT"]],
    ["non-array", "CSV"],
    ["null", null],
  ])(
    "malformed production format producer is a generic 500 with no partial page: %s",
    async (_label, formats) => {
      const app = await boot({ mode: "csv", runtime: "live" });
      jest
        .spyOn(app.capability, "newImportFormats")
        .mockReturnValue(formats as never);
      const log = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      const token = await app.tokenFor(world.users.owner);
      const before = await rows();

      const response = await app.call("GET", "/import-sessions", { token });

      expect([response.status, response.json]).toEqual([
        500,
        { statusCode: 500, message: "Internal server error" },
      ]);
      expect(response.json).not.toHaveProperty("entry");
      expect(response.json).not.toHaveProperty("items");
      expect(response.text).not.toContain("PRIVATE_STORAGE_FORMAT");
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "PRIVATE_STORAGE_FORMAT",
      );
      expect(await rows()).toEqual(before);
    },
  );

  it("keeps active recovery, detail, applied result, and cancellation readable while entry is off", async () => {
    const draft = await seedSession(db, world);
    const applied = await seedApplied(db, world, {
      owner: world.users.owner,
    });
    const app = await boot({ runtime: "live" });
    const token = await app.tokenFor(world.users.owner);

    const active = await app.call("GET", "/import-sessions?state=active", {
      token,
    });
    expect(active.status).toBe(200);
    expect(active.json.entry).toEqual({
      version: 1,
      kind: "UNAVAILABLE",
      reason: "NOT_ENABLED",
    });
    expect(active.json.items.map((item: { id: string }) => item.id)).toEqual([
      draft.id,
    ]);

    const detail = await app.call("GET", `/import-sessions/${draft.id}`, {
      token,
    });
    expect([detail.status, detail.json.id, detail.json.actions]).toEqual([
      200,
      draft.id,
      ["CANCEL"],
    ]);

    const result = await app.call(
      "GET",
      `/import-sessions/${applied.id}/result`,
      { token },
    );
    expect([result.status, result.json.state, result.json.receipt]).toEqual([
      200,
      "APPLIED",
      expect.objectContaining({ sessionId: applied.id }),
    ]);

    const cancelled = await app.call(
      "POST",
      `/import-sessions/${draft.id}/cancel`,
      {
        token,
        headers: UI_HEADERS,
        body: { expectedRevision: 1 },
      },
    );
    expect([
      cancelled.status,
      cancelled.json.state,
      cancelled.json.revision,
      cancelled.json.actions,
    ]).toEqual([200, "CANCELLED", 2, []]);
  });

  it("revocation after the positive list but before CREATE returns public 503 and changes no row", async () => {
    const app = await boot({ mode: "csv", runtime: "live" });
    const token = await app.tokenFor(world.users.owner);
    const listed = await app.call("GET", "/import-sessions", { token });
    expect(listed.json.entry).toEqual({
      version: 1,
      kind: "CARD_INVOICE",
      formats: ["CSV"],
    });
    const before = await rows();

    app.gate.boot.revoke("SHUTDOWN");
    expect(app.gate.boot.runtime()).toBeNull();
    expect(app.gate.boot.stopped.aborted).toBe(true);
    const create = await app.call("POST", "/import-sessions", {
      token,
      headers: UI_HEADERS,
      body: createBody(world.cards.pessoal),
    });

    expect([create.status, create.json]).toEqual([
      503,
      exactError("CAPABILITY_DISABLED", true),
    ]);
    expect(await rows()).toEqual(before);
  });

  it("production availability does not widen tenant, project, or card authority", async () => {
    const app = await boot({ mode: "csv", runtime: "live" });
    const ownerToken = await app.tokenFor(world.users.owner);
    const restrictedToken = await app.tokenFor(world.users.restricted);
    const before = await rows();

    const foreignTenant = await app.call("POST", "/import-sessions", {
      token: ownerToken,
      headers: UI_HEADERS,
      body: createBody(world.cards.foreign),
    });
    const forbiddenProject = await app.call("POST", "/import-sessions", {
      token: restrictedToken,
      headers: UI_HEADERS,
      body: createBody(world.cards.casa),
    });

    expect([foreignTenant.status, foreignTenant.json]).toEqual([
      404,
      exactError("NOT_FOUND", false),
    ]);
    expect([forbiddenProject.status, forbiddenProject.json]).toEqual([
      404,
      exactError("NOT_FOUND", false),
    ]);
    expect(await rows()).toEqual(before);
  });
});
