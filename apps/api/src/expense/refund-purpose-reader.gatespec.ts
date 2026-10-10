require("../../../../scripts/test-db-env.cjs");

/**
 * #704 GET refund-purpose — functional gate on the REAL AppModule (APP_GUARD/APP_INTERCEPTOR as
 * registered, real JwtAuthGuard + JwtStrategy, real HTTP over 127.0.0.1). TEST-ONLY, first slice:
 * guards, error boundary and application-level logging. No T1/T2/T3 here (no barrier, no timing,
 * no query log). Bearer path only: cookieParser / ValidationPipe / main.ts bootstrap are NOT
 * exercised and this is not a browser journey.
 *
 * Egress tripwire: installed in the app describe's beforeAll and restored in its afterAll (same
 * scope, so a `-t` filter that runs no app test installs nothing and leaks nothing). It is in place
 * BEFORE the AppModule graph, PrismaClient, PrismaService and the fixtures are loaded (all required
 * inside that hook). Limit: framework imports at the top of this file (@nestjs/*) load first.
 * fetch / https / tls / non-loopback connect and DNS fail immediately without leaving the process;
 * loopback is allowed because the client talks to our own server.
 *
 * Evidence: P704_GATE_EVIDENCE_DIR (mode 0600, synthetic ids only). The wrapper script must run
 * this file with `env -i`, redirect stdout/stderr to files and scan them (native engine output
 * bypasses process.stderr.write and is invisible to any in-process spy).
 *
 * File name is deliberate: `*.gatespec.ts` is NOT matched by the default jest testRegex
 * (`.*\.spec\.ts$`, so `npm test` never runs it without the hermetic env) and IS matched by
 * tsconfig.build.json's `**\/*spec.ts` exclusion (so nest build never emits it). Run it only via
 * the dedicated command: `jest --runInBand --testRegex 'refund-purpose-reader\.gatespec\.ts$'`
 * under `env -i` with a literal JWT_SECRET, UPLOADS_DIR and P704_GATE_EVIDENCE_DIR.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

// ── patch/restore primitives: a restore puts back EXACTLY the previous own descriptor ───────
type Restore = () => void;
type Fn = (...args: unknown[]) => unknown;
function patch(
  target: object,
  key: PropertyKey,
  replacement: unknown,
): Restore {
  const before = Object.getOwnPropertyDescriptor(target, key);
  if (before && (before.get || before.set)) {
    throw new Error(`${String(key)} is an accessor; refusing to patch it`);
  }
  Object.defineProperty(target, key, {
    value: replacement,
    writable: true,
    configurable: true,
    enumerable: before ? before.enumerable : true,
  });
  return () => {
    // Inherited before the patch => remove the own property so the prototype's function shows again.
    if (before) Object.defineProperty(target, key, before);
    else Reflect.deleteProperty(target, key);
  };
}
function fnOf(target: object, key: PropertyKey): Fn {
  const value: unknown = Reflect.get(target, key);
  if (typeof value !== "function") {
    throw new Error(`${String(key)} is not a function`);
  }
  return value as Fn;
}
// Attempts EVERY restore even when one throws, then reports all failures explicitly.
const restoreAll = (restores: Restore[]) => {
  const errors: unknown[] = [];
  for (const restore of [...restores].reverse()) {
    try {
      restore();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} restore(s) failed`);
  }
};

// ── egress tripwire (must stay above every application import) ──────────────────────────────
type Blocked = { channel: string; target: string; control: boolean };
const blocked: Blocked[] = [];
let inControl = false;
const tripwireOrder: string[] = [];
type TripwireEnv = {
  global: object;
  socketProto: object;
  https: object;
  tls: object;
  dns: object;
};
const realEnv = (): TripwireEnv => ({
  global: globalThis,
  socketProto: require("node:net").Socket.prototype,
  https: require("node:https"),
  tls: require("node:tls"),
  dns: require("node:dns"),
});
const REAL = (() => {
  const e = realEnv();
  return {
    fetch: Reflect.get(e.global, "fetch"),
    connect: Reflect.get(e.socketProto, "connect"),
    httpsRequest: Reflect.get(e.https, "request"),
    httpsGet: Reflect.get(e.https, "get"),
    tlsConnect: Reflect.get(e.tls, "connect"),
    dnsLookup: Reflect.get(e.dns, "lookup"),
  };
})();
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);
const hostOf = (input: unknown): string => {
  if (typeof input === "string") {
    try {
      return new URL(input).hostname;
    } catch {
      return input;
    }
  }
  if (input instanceof URL) return input.hostname;
  if (typeof input === "object" && input !== null) {
    const host = Reflect.get(input, "hostname") ?? Reflect.get(input, "host");
    if (typeof host === "string") return host;
  }
  return "localhost";
};
// Host a net connect() call targets; null = IPC path, which never leaves the machine.
const connectHost = (args: unknown[]): string | null => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "number")
    return typeof args[1] === "string" ? args[1] : "localhost";
  if (typeof first === "string") return null;
  if (typeof first === "object" && first !== null) {
    if (Reflect.get(first, "path")) return null;
    const host = Reflect.get(first, "hostname") ?? Reflect.get(first, "host");
    return typeof host === "string" ? host : "localhost";
  }
  return "localhost";
};
// Installs the tripwire and returns an idempotent restore; a failure part-way rolls back what was applied.
function installTripwire(env: TripwireEnv): Restore {
  const applied: Restore[] = [];
  const denied = (channel: string, target: string): Error => {
    blocked.push({ channel, target, control: inControl });
    return new Error(`egress tripwire: ${channel} -> ${target}`);
  };
  try {
    applied.push(
      patch(env.global, "fetch", (...a: unknown[]) =>
        Promise.reject(denied("fetch", hostOf(a[0]))),
      ),
    );
    const realConnect = fnOf(env.socketProto, "connect");
    applied.push(
      patch(
        env.socketProto,
        "connect",
        function (this: unknown, ...args: unknown[]) {
          const host = connectHost(args);
          if (host !== null && !LOOPBACK.has(host))
            throw denied("net.connect", host);
          return realConnect.apply(this, args);
        },
      ),
    );
    for (const name of ["request", "get"] as const) {
      fnOf(env.https, name);
      applied.push(
        patch(env.https, name, (...a: unknown[]) => {
          throw denied(`https.${name}`, hostOf(a[0]));
        }),
      );
    }
    fnOf(env.tls, "connect");
    applied.push(
      patch(env.tls, "connect", (...a: unknown[]) => {
        throw denied("tls.connect", hostOf(a[0]));
      }),
    );
    const realLookup = fnOf(env.dns, "lookup");
    applied.push(
      patch(
        env.dns,
        "lookup",
        function (this: unknown, hostname: string, ...rest: unknown[]) {
          if (!LOOPBACK.has(hostname)) throw denied("dns.lookup", hostname);
          return realLookup.call(this, hostname, ...rest);
        },
      ),
    );
  } catch (error) {
    try {
      restoreAll(applied);
    } catch (rollback) {
      throw new AggregateError(
        [error, rollback],
        "install failed and rollback failed",
      );
    }
    throw error;
  }
  let restored = false;
  return () => {
    if (restored) return;
    // Marked only after success: a partial failure stays retryable and visible.
    restoreAll(applied);
    restored = true;
  };
}
// Set by the app describe's beforeAll; nothing is installed at module load.
let restoreTripwire: Restore | undefined;

import { ConsoleLogger, Logger } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import type { INestApplication, Type } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { refundFixture } from "./__tests__/refund-purpose.fixture";

// Value imports that touch the application (PrismaClient/PrismaService/fixtures) are loaded inside
// the hook, after the tripwire is installed; nothing here is evaluated when no test is selected.
type Mods = {
  PrismaClient: typeof import("@prisma/client").PrismaClient;
  PrismaService: typeof import("../prisma/prisma.service").PrismaService;
  refundFixture: typeof import("./__tests__/refund-purpose.fixture").refundFixture;
  resetTenant: typeof import("../bank-account/__tests__/invoice-undo.fixtures").resetTenant;
  seedPessoal: typeof import("../bank-account/__tests__/invoice-undo.fixtures").seedPessoal;
};
function loadApp(): Mods {
  const client: typeof import("@prisma/client") = require("@prisma/client");
  const service: typeof import("../prisma/prisma.service") = require("../prisma/prisma.service");
  const fixture: typeof import("./__tests__/refund-purpose.fixture") = require("./__tests__/refund-purpose.fixture");
  const invoice: typeof import("../bank-account/__tests__/invoice-undo.fixtures") = require("../bank-account/__tests__/invoice-undo.fixtures");
  return {
    PrismaClient: client.PrismaClient,
    PrismaService: service.PrismaService,
    refundFixture: fixture.refundFixture,
    resetTenant: invoice.resetTenant,
    seedPessoal: invoice.seedPessoal,
  };
}

const exec = promisify(execFile);
const EVIDENCE_DIR = process.env["P704_GATE_EVIDENCE_DIR"];
const TENANT = "qa-gate704";
const FOREIGN = "qa-gate704-foreign";
const SENTINEL = "p704-gate-sentinel-secret";
const READ_FAILED = "Refund purpose read failed";
const CONTROL_PRIMARY = "QA-CONTROL primary error";
const ZERO_WINDOW = { primary: 0, staticCalls: 0, consoleCalls: 0, writes: 0 };
const LEVELS = ["log", "error", "warn", "debug", "verbose", "fatal"] as const;

let seq = 0;
const record = (name: string, data: unknown) => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  seq += 1;
  const text = JSON.stringify(
    data,
    (_k, v) => (typeof v === "bigint" ? Number(v) : v),
    2,
  ).replace(/c[a-z0-9]{24}/g, "<cuid>");
  writeFileSync(
    join(EVIDENCE_DIR, `${String(seq).padStart(3, "0")}-${name}.json`),
    text,
    {
      mode: 0o600,
    },
  );
};

// ── pass-through log capture: one PRIMARY emission per call, never summed across layers ─────
type Capture = {
  primary: Array<{ level: string; message: string }>;
  staticCalls: Array<{ level: string; message: string }>;
  consoleCalls: Array<{ method: string; message: string }>;
  writes: Array<{ stream: "stdout" | "stderr"; text: string }>;
};
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; log: Capture }> {
  const log: Capture = {
    primary: [],
    staticCalls: [],
    consoleCalls: [],
    writes: [],
  };
  const text = (v: unknown) => (typeof v === "string" ? v : String(v));
  const restores: Restore[] = [];
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  let done = false;
  try {
    for (const level of LEVELS) {
      const instance = fnOf(Logger.prototype, level);
      restores.push(
        patch(
          Logger.prototype,
          level,
          function (this: unknown, message: unknown, ...rest: unknown[]) {
            log.primary.push({ level, message: text(message) });
            return instance.call(this, message, ...rest);
          },
        ),
      );
      const stat = fnOf(Logger, level);
      restores.push(
        patch(
          Logger,
          level,
          function (this: unknown, message: unknown, ...rest: unknown[]) {
            log.staticCalls.push({ level, message: text(message) });
            return stat.call(this, message, ...rest);
          },
        ),
      );
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      const original = fnOf(console, method);
      restores.push(
        patch(console, method, (...a: unknown[]) => {
          log.consoleCalls.push({ method, message: a.map(text).join(" ") });
          return original.apply(console, a);
        }),
      );
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const original = fnOf(process[stream], "write");
      restores.push(
        patch(
          process[stream],
          "write",
          function (this: unknown, chunk: unknown, ...rest: unknown[]) {
            log.writes.push({ stream, text: text(chunk) });
            return original.call(this, chunk, ...rest);
          },
        ),
      );
    }
    value = await fn();
    done = true;
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    restoreAll(restores);
  } catch (restoreError) {
    throw failed
      ? new AggregateError(
          [failure, restoreError],
          "body failed and restore failed",
        )
      : restoreError;
  }
  if (failed) throw failure;
  if (!done) throw new Error("capture: body did not complete");
  return { value: value as T, log };
}
const quiet = (c: Capture) => ({
  primary: c.primary.length,
  staticCalls: c.staticCalls.length,
  consoleCalls: c.consoleCalls.length,
  writes: c.writes.length,
});

// ── loopback HTTP client (no dependency: node:http on 127.0.0.1) ────────────────────────────
type Reply = {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
};
const CLIENT_DEADLINE_MS = 2000;
// The deadline is well under Jest's 5s so a stuck response surfaces its own cause; only THIS
// request/response are destroyed, and their listeners and timer are released on every outcome.
function get(
  port: number,
  path: string,
  token?: string,
  deadlineMs = CLIENT_DEADLINE_MS,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let res: http.IncomingMessage | undefined;
    const chunks: Buffer[] = [];
    const swallow = () => undefined;
    const fail = (what: string, cause?: Error) =>
      settle(Object.assign(new Error(`GET ${path}: ${what}`), { cause }));
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const timer = setTimeout(
      () =>
        fail(
          `no complete response within ${deadlineMs}ms (${
            res
              ? `status ${res.statusCode} received, body incomplete`
              : "no response headers"
          })`,
        ),
      deadlineMs,
    );
    const onData = (c: Buffer) => chunks.push(c);
    const onEnd = () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: unknown = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      settle(undefined, {
        status: res?.statusCode ?? 0,
        headers: res?.headers ?? {},
        text: body,
        json,
      });
    };
    const onResError = (e: Error) => fail(`response error: ${e.message}`, e);
    const onAborted = () => fail("response aborted mid-body");
    const onResClose = () => {
      if (res && !res.complete) fail("response closed before completion");
    };
    const onReqError = (e: Error) => fail(`request error: ${e.message}`, e);
    const onResponse = (r: http.IncomingMessage) => {
      res = r;
      r.on("data", onData);
      r.on("end", onEnd);
      r.on("error", onResError);
      r.on("aborted", onAborted);
      r.on("close", onResClose);
    };
    function settle(error?: Error, reply?: Reply) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("error", onReqError);
      req.off("response", onResponse);
      if (res) {
        res.off("data", onData);
        res.off("end", onEnd);
        res.off("error", onResError);
        res.off("aborted", onAborted);
        res.off("close", onResClose);
        res.on("error", swallow);
      }
      // A destroyed request may still emit one late error; keep a no-op on our own objects only.
      req.on("error", swallow);
      if (error) {
        req.destroy();
        reject(error);
      } else if (reply) resolve(reply);
    }
    req.on("error", onReqError);
    req.on("response", onResponse);
    req.end();
  });
}

const hasOwn = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);
type StepFailure = { step: string; error: unknown };
async function bestEffort(
  steps: Array<[string, () => unknown]>,
): Promise<StepFailure[]> {
  const failures: StepFailure[] = [];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (error) {
      failures.push({ step, error });
    }
  }
  return failures;
}
// lsof NAME column -> the endpoints that are NOT strictly loopback. A `*` (wildcard) host is NOT
// loopback: it listens on every interface. Anything unparseable is reported, never assumed safe.
const LSOF_LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
function lsofOffLoopback(names: string[]): string[] {
  const hostOfEndpoint = (endpoint: string): string | null => {
    const m = /^(\[[^\]]+\]|[^:\s]+|\*):(\d+|\*)$/.exec(endpoint.trim());
    return m ? m[1]! : null;
  };
  return names.filter((name) => {
    const [local, remote] = name.replace(/\s+\(.*\)\s*$/, "").split("->");
    const hosts = [local, remote]
      .filter((e): e is string => e !== undefined)
      .map(hostOfEndpoint);
    return hosts.some((h) => h === null || !LSOF_LOOPBACK.has(h));
  });
}

const lifecycle: {
  installed: boolean;
  restored: boolean;
  ran: boolean;
  failed: string[];
} = { installed: false, restored: false, ran: false, failed: [] };

type CronRow = { name: string; lastFired: string | null; next: string };
type Boot = {
  moduleRef?: TestingModule;
  app?: INestApplication;
  jobs: CronRow[];
  log?: Capture;
  port: number;
};
let AppModuleRef!: Type<unknown>;
// Each resource is stored the moment it exists, BEFORE the awaits that can fail, so closeApp can
// always reach it. Limit: if compile() itself throws there is no reference to close.
async function bootApp(b: Boot, faultAfterInit?: () => void): Promise<void> {
  const { log } = await capture(async () => {
    AppModuleRef = require("../app.module").AppModule;
    b.moduleRef = await Test.createTestingModule({ imports: [AppModuleRef] })
      .setLogger(new ConsoleLogger())
      .compile();
    b.app = b.moduleRef.createNestApplication();
    await b.app.init();
    faultAfterInit?.();
    // Earliest boundary: nothing may have fired between init and here; then stop every job.
    const registry = b.app.get(SchedulerRegistry, { strict: false });
    b.jobs = [...registry.getCronJobs().entries()].map(([name, job]) => ({
      name,
      lastFired: job.lastDate()?.toISOString() ?? null,
      next: job.nextDate().toJSDate().toISOString(),
    }));
    for (const [, job] of registry.getCronJobs()) job.stop();
    await b.app.listen(0, "127.0.0.1");
    b.port = (b.app.getHttpServer().address() as { port: number }).port;
  });
  b.log = log;
}
const closeApp = (b: Boot) => (b.app ? b.app.close() : b.moduleRef?.close());

// Bounded AppModule setup/teardown deadline; not a per-request performance budget. (One run
// exceeded the default 5 s hook limit; the cause was not measured.)
const HOOK_TIMEOUT_MS = 60_000;

describe("#704 GET refund-purpose gate (real AppModule, real guards, real JWT)", () => {
  let mods!: Mods;
  let db!: PrismaClient;
  const boot: Boot = { jobs: [], port: 0 };
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let port = 0;
  let fx: Awaited<ReturnType<typeof refundFixture>>;
  let bootLog: Capture;
  let crons: CronRow[] = [];
  const url = (projectId: string, id: string) =>
    `/projects/${projectId}/expenses/${id}/refund-purpose`;
  const tokenFor = (
    user: { id: string; tenantId: string; username: string; role: string },
    sv = 0,
    opts: { secret?: string; expiresIn?: number } = {},
  ) =>
    jwt.sign(
      {
        sub: user.id,
        tenantId: user.tenantId,
        username: user.username,
        role: user.role,
        sv,
      },
      opts,
    );
  const owner = () => ({
    id: fx.requester.id,
    tenantId: TENANT,
    username: "owner",
    role: "OWNER",
  });
  const USERS = () => [
    fx.requester.id,
    `${TENANT}-nomodule`,
    `${TENANT}-scoped`,
    `${FOREIGN}-owner`,
  ];
  // JwtStrategy's debounced lastActivityAt write is fire-and-forget: arm it (null) before the
  // window and wait for ITS observable effect inside the window, so it cannot leak past the capture.
  const windowed = async <T>(
    fn: () => Promise<T>,
    expectWrittenFor: string[],
  ) => {
    await db.user.updateMany({
      where: { id: { in: USERS() } },
      data: { lastActivityAt: null },
    });
    return capture(async () => {
      const value = await fn();
      const deadline = Date.now() + 3000;
      for (const id of expectWrittenFor) {
        for (;;) {
          const u = await db.user.findUniqueOrThrow({ where: { id } });
          if (u.lastActivityAt) break;
          if (Date.now() > deadline)
            throw new Error("JWT activity write not observed");
          await new Promise((r) => setImmediate(r));
        }
      }
      return value;
    });
  };

  beforeAll(async () => {
    restoreTripwire = installTripwire(realEnv());
    lifecycle.installed = true;
    tripwireOrder.push("installed");
    expect(tripwireOrder).toEqual(["installed"]);
    // Hermetic-environment preconditions (the wrapper runs this under `env -i`).
    expect(
      Object.keys(process.env).filter((k) =>
        /^(GEMINI|GOOGLE|MODAL|OPENAI|ANTHROPIC)/i.test(k),
      ),
    ).toEqual([]);
    expect(process.env["JWT_SECRET"]).toBe("qa-gate704-test-only-secret");
    expect(process.env["NODE_ENV"]).toBe("test");
    expect(process.env["DATABASE_URL"]).toMatch(/test-worker-\d+\.db$/);
    expect(process.env["DATABASE_URL"]).not.toMatch(/dev\.db/);

    mods = loadApp();
    db = new mods.PrismaClient();
    await bootApp(boot);
    app = boot.app!;
    crons = boot.jobs;
    bootLog = boot.log!;
    port = boot.port;
    prisma = app.get(mods.PrismaService);
    jwt = app.get(JwtService, { strict: false });
    await db.user.deleteMany({ where: { tenantId: FOREIGN } });
    await mods.resetTenant(db, FOREIGN);
    fx = await mods.refundFixture(db, prisma, TENANT);
    await mods.seedPessoal(db, {
      tenantId: FOREIGN,
      projectId: `${FOREIGN}-personal`,
    });
    await db.user.createMany({
      data: [
        {
          id: `${FOREIGN}-owner`,
          tenantId: FOREIGN,
          username: "owner",
          name: "Foreign owner",
          role: "OWNER",
        },
        {
          id: `${TENANT}-nomodule`,
          tenantId: TENANT,
          username: "nomodule",
          name: "No module",
          role: "USER",
        },
        {
          id: `${TENANT}-scoped`,
          tenantId: TENANT,
          username: "scoped",
          name: "Scoped",
          role: "USER",
          allowedModules: JSON.stringify(["expenses"]),
          allowedProjects: JSON.stringify([fx.targetProjectId]),
        },
      ],
    });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    // Best-effort and ordered: one failing step never skips the rest (app close, disconnect and the
    // tripwire restore must always run); every failure is reported by name at the end.
    const errors = await bestEffort([
      [
        "db.user.deleteMany",
        () =>
          db?.user.deleteMany({
            where: { tenantId: { in: [TENANT, FOREIGN] } },
          }),
      ],
      ["fixture.cleanup", () => fx?.cleanup()],
      [
        "resetTenant(FOREIGN)",
        () => (db ? mods.resetTenant(db, FOREIGN) : undefined),
      ],
      ["app.close", () => closeApp(boot)],
      ["db.$disconnect", () => db?.$disconnect()],
      [
        "tripwire.restore",
        () => {
          if (!restoreTripwire) return;
          restoreTripwire();
          lifecycle.restored = true;
        },
      ],
      [
        "tripwire.verify-references",
        () => {
          // Identity, not just the flag: valid for any -t selection that ran this hook.
          const env = realEnv();
          const back = [
            Reflect.get(env.global, "fetch") === REAL.fetch,
            Reflect.get(env.socketProto, "connect") === REAL.connect,
            Reflect.get(env.https, "request") === REAL.httpsRequest,
            Reflect.get(env.https, "get") === REAL.httpsGet,
            Reflect.get(env.tls, "connect") === REAL.tlsConnect,
            Reflect.get(env.dns, "lookup") === REAL.dnsLookup,
          ];
          if (back.includes(false))
            throw new Error(`tripwire references not restored: ${back}`);
        },
      ],
    ]);
    lifecycle.ran = true;
    lifecycle.failed = errors.map((e) => e.step);
    record("teardown", lifecycle);
    if (errors.length > 0) {
      throw new AggregateError(
        errors.map((e) => e.error),
        `teardown failed at: ${errors.map((e) => e.step).join(", ")}`,
      );
    }
  }, HOOK_TIMEOUT_MS);

  // ── precondition: what the real AppModule registers ──────────────────────────────────────
  it("[registration] the AppModule registers exactly 4 APP_GUARD in order and 3 APP_INTERCEPTOR in order", () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppModuleRef,
    ) as Array<{
      provide: unknown;
      useClass: { name: string };
    }>;
    const namesOf = (token: unknown) =>
      providers.filter((p) => p.provide === token).map((p) => p.useClass.name);
    record("registration", {
      guards: namesOf(APP_GUARD),
      interceptors: namesOf(APP_INTERCEPTOR),
    });
    expect(namesOf(APP_GUARD)).toEqual([
      "JwtAuthGuard",
      "RolesGuard",
      "ModulesGuard",
      "ProjectAccessGuard",
    ]);
    expect(namesOf(APP_INTERCEPTOR)).toEqual([
      "FinancialScheduleResponseInterceptor",
      "RefundPurposePrivacyInterceptor",
      "ActivityLogInterceptor",
    ]);
  });

  // ── hermetic boot: jobs, sockets, files ───────────────────────────────────────────────────
  it("[boot] jobs were stopped before any ran; the boot window is observable; the DB is the disposable worker file", async () => {
    const database = (await prisma.$queryRawUnsafe(
      "PRAGMA database_list",
    )) as Array<{ name: string; file: string }>;
    record("boot", { crons, bootQuiet: quiet(bootLog), databases: database });
    // Two @Cron jobs exist (hourly price alerts, monthly financing window); none ran before being stopped.
    expect(crons).toHaveLength(2);
    expect(crons.every((c) => c.lastFired === null)).toBe(true);
    // Positive control of the capture: Nest's own boot output was seen through the pass-through spies.
    expect(bootLog.primary.length).toBeGreaterThan(0);
    expect(bootLog.writes.length).toBeGreaterThan(0);
    expect(database.map((d) => d.name)).toEqual(["main"]);
    expect(database[0]!.file).toBe(
      process.env["DATABASE_URL"]!.replace(/^file:/, ""),
    );
    expect(database[0]!.file).toMatch(/test-worker-1\.db$/);
    expect(blocked.filter((b) => !b.control)).toEqual([]);
  });

  it("[lsof] this PID only listens on 127.0.0.1, holds no non-loopback socket and opens no dev.db", async () => {
    const out = (
      await exec("lsof", ["-nP", "-p", String(process.pid)], {
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
    const rows = out.split("\n").slice(1).filter(Boolean);
    const inet = rows.filter((r) => /\bIPv[46]\b/.test(r));
    const files = rows.filter((r) => /\.db(-journal|-wal|-shm)?\s*$/.test(r));
    const nameOf = (r: string) => r.trim().split(/\s+/).slice(8).join(" ");
    record("lsof", {
      pid: process.pid,
      sockets: inet.map(nameOf),
      dbFiles: files.map((r) => nameOf(r).replace(/^.*\//, "")),
    });
    expect(lsofOffLoopback(inet.map(nameOf))).toEqual([]);
    expect(
      inet
        .map(nameOf)
        .some((n) => n.startsWith(`127.0.0.1:${port}`) && n.includes("LISTEN")),
    ).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(nameOf(f).replace(/^.*\//, "")).toMatch(
        /^test-worker-1\.db(-journal|-wal|-shm)?$/,
      );
    }
  });

  // ── guards, exactly as registered ─────────────────────────────────────────────────────────
  it("[401] no token, wrong-secret token, expired token and stale sessionVersion never reach the reader and emit nothing", async () => {
    const path = url(fx.projectId, fx.source.id);
    const { value: replies, log } = await windowed(
      async () => ({
        none: await get(port, path),
        wrongSecret: await get(
          port,
          path,
          tokenFor(owner(), 0, { secret: "not-the-server-secret" }),
        ),
        expired: await get(
          port,
          path,
          tokenFor(owner(), 0, { expiresIn: -10 }),
        ),
        staleSv: await get(port, path, tokenFor(owner(), 1)),
      }),
      [],
    );
    record("401", {
      window: quiet(log),
      ...Object.fromEntries(
        Object.entries(replies).map(([k, r]) => [
          k,
          {
            status: r.status,
            body: r.json,
            cc: r.headers["cache-control"] ?? null,
          },
        ]),
      ),
    });
    expect(
      Object.fromEntries(
        Object.entries(replies).map(([k, r]) => [k, [r.status, r.json]]),
      ),
    ).toEqual({
      none: [401, { message: "Unauthorized", statusCode: 401 }],
      wrongSecret: [401, { message: "Unauthorized", statusCode: 401 }],
      expired: [401, { message: "Unauthorized", statusCode: 401 }],
      staleSv: [
        401,
        { message: "Sessão encerrada", error: "Unauthorized", statusCode: 401 },
      ],
    });
    for (const r of Object.values(replies))
      expect(r.text).not.toContain(fx.source.id);
    expect(quiet(log)).toEqual(ZERO_WINDOW);
  });

  it("[403/404] module and project guards answer before the reader; the scoped-out 404 is byte-identical to the reader's own missing-source 404", async () => {
    const path = url(fx.projectId, fx.source.id);
    const sign = (
      id: string,
      tenantId: string,
      username: string,
      role: string,
    ) => tokenFor({ id, tenantId, username, role });
    const { value: replies, log } = await windowed(
      async () => ({
        noModule: await get(
          port,
          path,
          sign(`${TENANT}-nomodule`, TENANT, "nomodule", "USER"),
        ),
        scopedOut: await get(
          port,
          path,
          sign(`${TENANT}-scoped`, TENANT, "scoped", "USER"),
        ),
        foreignTenant: await get(
          port,
          path,
          sign(`${FOREIGN}-owner`, FOREIGN, "owner", "OWNER"),
        ),
        missingSource: await get(
          port,
          url(fx.projectId, "missing-source-id"),
          tokenFor(owner()),
        ),
        missingProject: await get(
          port,
          url("missing-project-id", fx.source.id),
          tokenFor(owner()),
        ),
      }),
      USERS(),
    );
    record("403-404", {
      window: quiet(log),
      ...Object.fromEntries(
        Object.entries(replies).map(([k, r]) => [
          k,
          {
            status: r.status,
            body: r.json,
            cc: r.headers["cache-control"] ?? null,
          },
        ]),
      ),
    });
    expect(
      Object.fromEntries(
        Object.entries(replies).map(([k, r]) => [k, [r.status, r.json]]),
      ),
    ).toEqual({
      noModule: [
        403,
        {
          message: 'Sem permissão para o módulo "expenses"',
          error: "Forbidden",
          statusCode: 403,
        },
      ],
      scopedOut: [
        404,
        {
          message: "Recurso não encontrado",
          error: "Not Found",
          statusCode: 404,
        },
      ],
      foreignTenant: [
        404,
        {
          message: "Projeto não encontrado",
          error: "Not Found",
          statusCode: 404,
        },
      ],
      missingSource: [
        404,
        {
          message: "Recurso não encontrado",
          error: "Not Found",
          statusCode: 404,
        },
      ],
      missingProject: [
        404,
        {
          message: "Projeto não encontrado",
          error: "Not Found",
          statusCode: 404,
        },
      ],
    });
    expect(replies.scopedOut.text).toBe(replies.missingSource.text);
    // Only the handler-level reply carries the header; guard-level denials do not (observation, see report).
    expect(replies.missingSource.headers["cache-control"]).toBe(
      "private, no-store",
    );
    for (const r of Object.values(replies)) {
      expect(r.text).not.toContain(fx.source.id);
      expect(r.text).not.toContain(fx.targetProjectId);
    }
    expect(quiet(log)).toEqual(ZERO_WINDOW);
  });

  // ── success path and application-level logging window ─────────────────────────────────────
  it("[200] a real owner reads the state: no-store header, exact body, and the request window emits NOTHING (no log, no console, no write)", async () => {
    const { value: reply, log } = await windowed(
      () => get(port, url(fx.projectId, fx.source.id), tokenFor(owner())),
      [fx.requester.id],
    );
    record("200", {
      status: reply.status,
      headers: { cc: reply.headers["cache-control"] },
      body: reply.json,
      window: quiet(log),
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("private, no-store");
    expect(reply.json).toEqual({
      sourceExpenseId: fx.source.id,
      assignment: null,
      actions: ["PREPARE"],
    });
    expect(quiet(log)).toEqual(ZERO_WINDOW);
  });

  it("[5xx] an APPLICATION error inside the reader is exactly ONE primary error emission with the constant text, a generic 500, and the cause reaches no channel", async () => {
    let fired = 0;
    const original = prisma.$transaction.bind(prisma) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    const spy = jest.spyOn(prisma, "$transaction").mockImplementation(((
      ...args: unknown[]
    ) => {
      if (new Error().stack?.includes("RefundPurposeService.read")) {
        fired += 1;
        return Promise.reject(new TypeError(SENTINEL));
      }
      return original(...args);
    }) as never);
    try {
      const { value: reply, log } = await windowed(
        () => get(port, url(fx.projectId, fx.source.id), tokenFor(owner())),
        [fx.requester.id],
      );
      record("5xx", {
        fired,
        status: reply.status,
        body: reply.json,
        primary: log.primary,
        staticCalls: log.staticCalls,
        consoleCalls: log.consoleCalls,
        writes: log.writes.map((w) => ({
          stream: w.stream,
          hasConstant: w.text.includes(READ_FAILED),
        })),
      });
      expect(fired).toBe(1);
      expect(reply.status).toBe(500);
      expect(reply.json).toEqual({
        statusCode: 500,
        message: "Internal Server Error",
      });
      expect(log.primary).toEqual([{ level: "error", message: READ_FAILED }]);
      expect(log.staticCalls).toEqual([]);
      expect(log.consoleCalls).toEqual([]);
      expect(log.writes).toHaveLength(1);
      expect(log.writes[0]!.stream).toBe("stderr");
      expect(log.writes[0]!.text).toContain(READ_FAILED);
      const everything = JSON.stringify([reply.text, log]);
      expect(everything).not.toContain(SENTINEL);
      expect(everything).not.toMatch(/TypeError|\.ts:\d+|node_modules/);
    } finally {
      spy.mockRestore();
    }
  });

  // ── the instruments must be able to see what they claim to exclude (positive controls) ────
  it("[instrument] extra instance log, static log, console call and raw stderr write are each detectable even next to a correct primary log", async () => {
    const outcome = await capture(async () => {
      new Logger("QA-extra").error(CONTROL_PRIMARY); // stands for the expected primary
      new Logger("QA-extra").log("extra instance line");
      Logger.warn("extra static line");
      console.info("extra console line");
      process.stderr.write("extra raw stderr line\n");
    });
    const log = outcome.log;
    record("instrument-controls", {
      primary: log.primary,
      staticCalls: log.staticCalls,
      consoleCalls: log.consoleCalls,
      writes: log.writes.length,
    });
    expect(log.primary).toEqual([
      { level: "error", message: CONTROL_PRIMARY },
      { level: "log", message: "extra instance line" },
    ]);
    expect(log.staticCalls).toEqual([
      { level: "warn", message: "extra static line" },
    ]);
    expect(log.consoleCalls).toEqual([
      { method: "info", message: "extra console line" },
    ]);
    expect(
      log.writes.filter((w) => w.text.includes("extra raw stderr line")),
    ).toHaveLength(1);
    // One emission is counted once: 2 primaries, though the ConsoleLogger wrote >= 2 lines downstream.
    expect(log.writes.length).toBeGreaterThanOrEqual(2);
  });

  it("[instrument] the egress tripwire blocks before any socket opens and still allows loopback", async () => {
    inControl = true;
    try {
      await expect(fetch("https://example.invalid/x")).rejects.toThrow(
        /egress tripwire: fetch/,
      );
      expect(() =>
        require("node:https").request({ host: "example.invalid" }),
      ).toThrow(/egress tripwire: https\.request/);
      expect(() => require("node:net").connect(80, "203.0.113.9")).toThrow(
        /egress tripwire: net\.connect/,
      );
      expect(() =>
        require("node:dns").lookup("example.invalid", () => undefined),
      ).toThrow(/egress tripwire: dns\.lookup/);
    } finally {
      inControl = false;
    }
    record("tripwire-controls", {
      blockedChannels: blocked.filter((b) => b.control).map((b) => b.channel),
    });
    expect(blocked.filter((b) => b.control).map((b) => b.channel)).toEqual([
      "fetch",
      "https.request",
      "net.connect",
      "dns.lookup",
    ]);
    // Loopback still works: this whole file is its proof; one more explicit request.
    expect((await get(port, url(fx.projectId, fx.source.id))).status).toBe(401);
  });

  it("[projects-shape] GET /projects has no rooms; GET /projects/:id has them (soft-deleted included), same JWT", async () => {
    const projectId = `${TENANT}-shape-project`;
    const activeRoom = `${TENANT}-shape-room-active`;
    const deletedRoom = `${TENANT}-shape-room-deleted`;
    await db.project.create({
      data: {
        id: projectId,
        tenantId: TENANT,
        type: "REFORMA",
        name: "Synthetic shape probe",
      },
    });
    try {
      await db.room.createMany({
        data: [
          {
            id: activeRoom,
            projectId,
            name: "Synthetic room active",
            order: 0,
          },
          {
            id: deletedRoom,
            projectId,
            name: "Synthetic room deleted",
            order: 1,
            deletedAt: new Date("2026-01-01T12:00:00Z"),
          },
        ],
      });
      const token = tokenFor(owner());
      const list = await get(port, "/projects", token);
      const detail = await get(port, `/projects/${projectId}`, token);
      const rows = list.json as Array<Record<string, unknown>>;
      const listed = rows.find((p) => p["id"] === projectId);
      const det = detail.json as Record<string, unknown> & {
        rooms: Array<Record<string, unknown>>;
      };
      record("projects-shape", {
        dbRooms: await db.room.count({ where: { projectId } }),
        list: { status: list.status, count: rows.length, items: rows },
        detail: { status: detail.status, body: detail.json },
      });
      expect(list.status).toBe(200);
      expect(detail.status).toBe(200);
      expect(listed).toBeDefined();
      expect(rows.filter((p) => "rooms" in p)).toEqual([]);
      expect(Object.keys(listed!).sort()).toEqual(
        Object.keys(det)
          .filter((k) => k !== "rooms" && k !== "_count")
          .sort(),
      );
      expect(det["_count"]).toBeDefined();
      expect(det.rooms.map((r) => [r["id"], r["deletedAt"]])).toEqual([
        [activeRoom, null],
        [deletedRoom, "2026-01-01T12:00:00.000Z"],
      ]);
    } finally {
      await db.room.deleteMany({ where: { projectId } });
      await db.project.delete({ where: { id: projectId } });
    }
  });

  it("[boot-failure] a failure after init and before listen keeps the app closable: the SAME bootApp/closeApp/bestEffort close it, run $disconnect, and stop the jobs", async () => {
    const b: Boot = { jobs: [], port: 0 };
    await expect(
      bootApp(b, () => {
        throw new Error("injected boot failure after init");
      }),
    ).rejects.toThrow("injected boot failure after init");
    // Both references existed BEFORE the failing step; the server never listened.
    expect(b.moduleRef).toBeDefined();
    expect(b.app).toBeDefined();
    expect(b.port).toBe(0);
    expect(b.app!.getHttpServer().listening).toBe(false);
    const registry = b.app!.get(SchedulerRegistry, { strict: false });
    const jobs = [...registry.getCronJobs().values()];
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.isActive)).toBe(true);
    const service = b.app!.get(mods.PrismaService);
    const closeBefore = Reflect.get(b.app!, "close");
    const disconnectBefore = Reflect.get(service, "$disconnect");
    const close = jest.spyOn(b.app!, "close");
    const disconnect = jest.spyOn(service, "$disconnect");
    const jobsActiveBefore = jobs.filter((j) => j.isActive).length;
    let failures: Awaited<ReturnType<typeof bestEffort>>;
    let closeCalls = -1;
    let disconnectCalls = -1;
    try {
      failures = await bestEffort([["app.close", () => closeApp(b)]]);
      closeCalls = close.mock.calls.length;
      disconnectCalls = disconnect.mock.calls.length;
      expect(close).toHaveBeenCalledTimes(1);
      // onModuleDestroy -> $disconnect, observed through a pass-through spy (real close ran).
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      disconnect.mockRestore();
    }
    expect(failures).toEqual([]);
    expect(Reflect.get(b.app!, "close")).toBe(closeBefore);
    expect(Reflect.get(service, "$disconnect")).toBe(disconnectBefore);
    // Prisma is deliberately not queried after close (it would reopen the connection).
    expect(jobs.some((j) => j.isActive)).toBe(false);
    record("boot-failure", {
      closeCalls,
      disconnectCalls,
      jobsActiveBefore,
      jobsActiveAfter: jobs.filter((j) => j.isActive).length,
      listening: b.app!.getHttpServer().listening,
    });
  });

  it("[egress] the application itself attempted no external connection during the whole file", () => {
    record("egress-final", { appAttempts: blocked.filter((b) => !b.control) });
    expect(blocked.filter((b) => !b.control)).toEqual([]);
  });
});

// ── harness lifecycle: runs AFTER the app suite's afterAll, so it sees what the suite left behind ─
describe("#704 gate harness lifecycle (no app)", () => {
  afterEach(() => jest.restoreAllMocks());
  // The client's own timer carries a unique deadline, so we watch exactly that handle: a global
  // timer count would also see keep-alive socket timers that are not ours.
  const watchTimer = (deadlineMs: number) => {
    const set = jest.spyOn(globalThis, "setTimeout");
    const clear = jest.spyOn(globalThis, "clearTimeout");
    return {
      created: () =>
        set.mock.calls.flatMap((c, i) =>
          c[1] === deadlineMs ? [set.mock.results[i]!.value] : [],
        ),
      cleared: () => clear.mock.calls.map((c) => c[0]),
      stop: () => {
        set.mockRestore();
        clear.mockRestore();
      },
    };
  };
  const settleTick = () => new Promise((r) => setImmediate(r));

  it("[lifecycle] whatever was selected, no tripwire patch outlives the suite: the REAL references are back, and restored === installed", () => {
    const env = realEnv();
    expect(Reflect.get(env.global, "fetch")).toBe(REAL.fetch);
    expect(Reflect.get(env.socketProto, "connect")).toBe(REAL.connect);
    expect(Reflect.get(env.https, "request")).toBe(REAL.httpsRequest);
    expect(Reflect.get(env.https, "get")).toBe(REAL.httpsGet);
    expect(Reflect.get(env.tls, "connect")).toBe(REAL.tlsConnect);
    expect(Reflect.get(env.dns, "lookup")).toBe(REAL.dnsLookup);
    // Last on purpose: a failed teardown step must still show whether the references came back.
    // installed:false/restored:false is the explicit "no app test was selected" signal, not a skip.
    expect(lifecycle.restored).toBe(lifecycle.installed);
    expect(lifecycle.failed).toEqual([]);
    expect(lifecycle.ran).toBe(lifecycle.installed);
    record("lifecycle-tripwire", { ...lifecycle });
  });

  it("[lifecycle] installTripwire restores own AND inherited properties exactly, is idempotent, and rolls back a failed install", () => {
    const orig = {
      fetch: () => "f",
      connect: () => "c",
      request: () => "r",
      get: () => "g",
      tlsConnect: () => "t",
      lookup: () => "l",
    };
    const proto = Object.create({ connect: orig.connect });
    const fake = (): TripwireEnv => ({
      global: { fetch: orig.fetch },
      socketProto: proto,
      https: { request: orig.request, get: orig.get },
      tls: { connect: orig.tlsConnect },
      dns: { lookup: orig.lookup },
    });
    const env = fake();
    const restore = installTripwire(env);
    expect(Reflect.get(env.global, "fetch")).not.toBe(orig.fetch);
    expect(Reflect.get(env.https, "request")).not.toBe(orig.request);
    expect(Reflect.get(env.dns, "lookup")).not.toBe(orig.lookup);
    expect(hasOwn(env.socketProto, "connect")).toBe(true);
    restore();
    restore();
    expect(Reflect.get(env.global, "fetch")).toBe(orig.fetch);
    expect(Reflect.get(env.https, "request")).toBe(orig.request);
    expect(Reflect.get(env.https, "get")).toBe(orig.get);
    expect(Reflect.get(env.tls, "connect")).toBe(orig.tlsConnect);
    expect(Reflect.get(env.dns, "lookup")).toBe(orig.lookup);
    // Inherited before => the own property is gone again, the prototype's function shows through.
    expect(hasOwn(env.socketProto, "connect")).toBe(false);
    expect(Reflect.get(env.socketProto, "connect")).toBe(orig.connect);

    // A failure while installing (tls.connect missing) must not leave the earlier patches behind.
    const broken = fake();
    Reflect.deleteProperty(broken.tls, "connect");
    expect(() => installTripwire(broken)).toThrow(/connect is not a function/);
    expect(Reflect.get(broken.global, "fetch")).toBe(orig.fetch);
    expect(Reflect.get(broken.https, "request")).toBe(orig.request);
    expect(hasOwn(broken.socketProto, "connect")).toBe(false);
    expect(Reflect.get(broken.dns, "lookup")).toBe(orig.lookup);
  });

  it("[lifecycle] capture puts back the exact prior console/stdout/stderr/Logger references, on success and when the body throws", async () => {
    const snapshot = () => ({
      instance: LEVELS.map((l) => Reflect.get(Logger.prototype, l)),
      static: LEVELS.map((l) => Reflect.get(Logger, l)),
      console: (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        Reflect.get(console, m),
      ),
      out: Reflect.get(process.stdout, "write"),
      err: Reflect.get(process.stderr, "write"),
      outOwn: hasOwn(process.stdout, "write"),
      errOwn: hasOwn(process.stderr, "write"),
    });
    const before = snapshot();
    let during: ReturnType<typeof snapshot> | undefined;
    await capture(async () => {
      during = snapshot();
    });
    expect(during!.out).not.toBe(before.out);
    expect(during!.console[1]).not.toBe(before.console[1]);
    expect(during!.instance[0]).not.toBe(before.instance[0]);
    expect(snapshot()).toEqual(before);
    for (const [i, ref] of before.console.entries()) {
      expect(
        Reflect.get(
          console,
          (["log", "info", "warn", "error", "debug"] as const)[i]!,
        ),
      ).toBe(ref);
    }
    expect(Reflect.get(process.stdout, "write")).toBe(before.out);

    await expect(
      capture(async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    expect(Reflect.get(process.stdout, "write")).toBe(before.out);
    expect(Reflect.get(process.stderr, "write")).toBe(before.err);
    expect(Reflect.get(console, "warn")).toBe(before.console[2]);
    expect(Reflect.get(Logger.prototype, "error")).toBe(before.instance[1]);
    expect(Reflect.get(Logger, "warn")).toBe(before.static[2]);
    expect(snapshot()).toEqual(before);
  });

  it("[lifecycle] bestEffort runs every step in order even when earlier ones fail, and names each failure", async () => {
    const ran: string[] = [];
    const failures = await bestEffort([
      [
        "a",
        () => {
          ran.push("a");
          throw new Error("boom-a");
        },
      ],
      [
        "b",
        async () => {
          ran.push("b");
        },
      ],
      [
        "c",
        async () => {
          ran.push("c");
          throw new Error("boom-c");
        },
      ],
      [
        "d",
        () => {
          ran.push("d");
        },
      ],
    ]);
    expect(ran).toEqual(["a", "b", "c", "d"]);
    expect(failures.map((f) => f.step)).toEqual(["a", "c"]);
    expect(failures.map((f) => (f.error as Error).message)).toEqual([
      "boom-a",
      "boom-c",
    ]);
  });

  it("[lsof-classifier] a wildcard listener, IPv6 wildcard/global, and a known remote endpoint are reported; only strict loopback passes (offline strings)", () => {
    const ok = [
      "127.0.0.1:3011 (LISTEN)",
      "[::1]:3011 (LISTEN)",
      "127.0.0.1:50000->127.0.0.1:3011 (ESTABLISHED)",
      "[::1]:50001->[::1]:3011 (ESTABLISHED)",
      "localhost:3011 (LISTEN)",
    ];
    const bad = [
      "*:3011 (LISTEN)",
      "[::]:3011 (LISTEN)",
      "0.0.0.0:3011 (LISTEN)",
      "127.0.0.1:50000->93.184.216.34:443 (ESTABLISHED)",
      "[::1]:50001->[2606:2800:220:1:248:1893:25c8:1946]:443 (ESTABLISHED)",
      "10.0.0.5:50002->127.0.0.1:3011 (ESTABLISHED)",
      "[2001:db8::1]:443 (LISTEN)",
      "not-an-endpoint",
    ];
    expect(lsofOffLoopback(ok)).toEqual([]);
    expect(lsofOffLoopback(bad)).toEqual(bad);
    expect(lsofOffLoopback([...ok, bad[0]!])).toEqual([bad[0]]);
  });

  it("[lifecycle] patch/restore keep the WHOLE descriptor for own and inherited properties and refuse accessors", () => {
    const proto = { inherited: () => "p" };
    const child: Record<string, unknown> = Object.create(proto);
    Object.defineProperty(child, "own", {
      value: () => "o",
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(child, "acc", {
      get: () => 1,
      enumerable: true,
      configurable: true,
    });
    const ownBefore = Object.getOwnPropertyDescriptor(child, "own");
    const protoBefore = Object.getOwnPropertyDescriptor(proto, "inherited");
    const accBefore = Object.getOwnPropertyDescriptor(child, "acc");

    const restoreOwn = patch(child, "own", () => "patched-own");
    const restoreInherited = patch(child, "inherited", () => "patched-inh");
    expect(Reflect.get(child, "own")).not.toBe(ownBefore!.value);
    expect(hasOwn(child, "inherited")).toBe(true);
    restoreInherited();
    restoreOwn();
    expect(Object.getOwnPropertyDescriptor(child, "own")).toEqual(ownBefore);
    expect(hasOwn(child, "inherited")).toBe(false);
    expect(Object.getOwnPropertyDescriptor(proto, "inherited")).toEqual(
      protoBefore,
    );
    expect(Reflect.get(child, "inherited")).toBe(protoBefore!.value);

    expect(() => patch(child, "acc", () => 2)).toThrow(/accessor/);
    expect(Object.getOwnPropertyDescriptor(child, "acc")).toEqual(accBefore);
    expect(Object.getOwnPropertyDescriptor(child, "acc")!.get).toBe(
      accBefore!.get,
    );
  });

  it("[lifecycle] restoreAll attempts EVERY restore when one fails and reports the failure explicitly; a failed tripwire restore leaves the rest restored and stays retryable", () => {
    const target: Record<string, unknown> = { a: "A", b: "B", c: "C" };
    const boom = new Error("injected restore failure");
    const ran: string[] = [];
    const restores: Restore[] = [
      patch(target, "a", "a2"),
      patch(target, "b", "b2"),
      patch(target, "c", "c2"),
    ];
    const [ra, rb, rc] = restores as [Restore, Restore, Restore];
    const failing: Restore[] = [
      () => {
        ran.push("a");
        ra();
      },
      () => {
        ran.push("b");
        throw boom;
      },
      () => {
        ran.push("c");
        rc();
      },
    ];
    void rb;
    let thrown: unknown;
    try {
      restoreAll(failing);
    } catch (error) {
      thrown = error;
    }
    // Reverse order, all three attempted, the middle one failed.
    expect(ran).toEqual(["c", "b", "a"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([boom]);
    expect((thrown as AggregateError).message).toBe("1 restore(s) failed");
    expect(target).toEqual({ a: "A", b: "b2", c: "C" });

    // Same through the real installer: freeze one target after install so ITS restore fails.
    const orig = {
      fetch: () => "f",
      connect: () => "c",
      request: () => "r",
      get: () => "g",
      tlsConnect: () => "t",
      lookup: () => "l",
    };
    const env: TripwireEnv = {
      global: { fetch: orig.fetch },
      socketProto: { connect: orig.connect },
      https: { request: orig.request, get: orig.get },
      tls: { connect: orig.tlsConnect },
      dns: { lookup: orig.lookup },
    };
    const restore = installTripwire(env);
    Object.defineProperty(env.tls, "connect", { configurable: false });
    for (let attempt = 0; attempt < 2; attempt++) {
      let failure: unknown;
      try {
        restore();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toHaveLength(1);
      expect((failure as AggregateError).errors[0]).toBeInstanceOf(TypeError);
    }
    // Everything else came back on the first attempt; the one that could not is still visibly patched.
    expect(Reflect.get(env.global, "fetch")).toBe(orig.fetch);
    expect(Reflect.get(env.socketProto, "connect")).toBe(orig.connect);
    expect(Reflect.get(env.https, "request")).toBe(orig.request);
    expect(Reflect.get(env.https, "get")).toBe(orig.get);
    expect(Reflect.get(env.dns, "lookup")).toBe(orig.lookup);
    expect(Reflect.get(env.tls, "connect")).not.toBe(orig.tlsConnect);
  });

  // ── capture / installTripwire error aggregation, on the REAL helpers ────────────────────────
  // The restore failure is injected by a temporary Object.defineProperty spy that throws ONLY for
  // one target+key and ONLY at the restore stage (current value is the wrapper, descriptor value
  // is the original). Everything else passes through; the spy is removed and the one property is
  // put back in `finally`, so nothing leaks into the other tests of this file.
  const CAPTURE_TARGETS = (): Array<[object, PropertyKey]> => [
    ...LEVELS.map((l): [object, PropertyKey] => [Logger.prototype, l]),
    ...LEVELS.map((l): [object, PropertyKey] => [Logger, l]),
    ...(["log", "info", "warn", "error", "debug"] as const).map(
      (m): [object, PropertyKey] => [console, m],
    ),
    [process.stdout, "write"],
    [process.stderr, "write"],
  ];
  const snapshotTargets = () =>
    CAPTURE_TARGETS().map(([t, k]) => ({
      t,
      k,
      d: Object.getOwnPropertyDescriptor(t, k),
    }));
  const withRestoreFailure = async (
    target: object,
    key: PropertyKey,
    injected: Error,
    run: () => Promise<unknown>,
  ): Promise<{ error: unknown; thrown: boolean; fired: number }> => {
    const realDefine = Object.defineProperty;
    const original: unknown = Reflect.get(target, key);
    const originalDescriptor = Object.getOwnPropertyDescriptor(target, key);
    let fired = 0;
    const spy = jest
      .spyOn(Object, "defineProperty")
      .mockImplementation((o, p, attrs) => {
        if (
          o === target &&
          p === key &&
          Reflect.get(o, p) !== original &&
          attrs.value === original
        ) {
          fired++;
          throw injected;
        }
        return realDefine(o, p, attrs);
      });
    try {
      let error: unknown;
      let thrown = false;
      try {
        await run();
      } catch (e) {
        thrown = true;
        error = e;
      }
      return { error, thrown, fired };
    } finally {
      spy.mockRestore();
      if (originalDescriptor && Reflect.get(target, key) !== original) {
        Object.defineProperty(target, key, originalDescriptor);
      }
    }
  };

  it("[lifecycle] capture: body error + restore error keeps BOTH, and every other target is still restored", async () => {
    const before = snapshotTargets();
    const injected = new Error("QA-injected restore failure");
    const bodyError = new Error("QA body failure");
    const res = await withRestoreFailure(
      Logger.prototype,
      "warn",
      injected,
      () =>
        capture(async () => {
          throw bodyError;
        }),
    );
    expect(res.fired).toBe(1);
    expect(res.thrown).toBe(true);
    expect(res.error).toBeInstanceOf(AggregateError);
    const agg = res.error as AggregateError;
    expect(agg.message).toBe("body failed and restore failed");
    expect(agg.errors).toHaveLength(2);
    expect(agg.errors[0]).toBe(bodyError);
    expect(agg.errors[1]).toBeInstanceOf(AggregateError);
    expect((agg.errors[1] as AggregateError).errors).toEqual([injected]);
    for (const { t, k, d } of before) {
      expect(Object.getOwnPropertyDescriptor(t, k)).toEqual(d);
    }
  });

  it("[lifecycle] capture: restore error only surfaces as the restore failure, not as a body failure", async () => {
    const before = snapshotTargets();
    const injected = new Error("QA-injected restore failure");
    const res = await withRestoreFailure(
      Logger.prototype,
      "warn",
      injected,
      () => capture(async () => "body ok"),
    );
    expect(res.fired).toBe(1);
    expect(res.thrown).toBe(true);
    expect(res.error).toBeInstanceOf(AggregateError);
    const agg = res.error as AggregateError;
    expect(agg.message).toBe("1 restore(s) failed");
    expect(agg.errors).toEqual([injected]);
    for (const { t, k, d } of before) {
      expect(Object.getOwnPropertyDescriptor(t, k)).toEqual(d);
    }
  });

  it("[lifecycle] installTripwire: install error + rollback error keeps BOTH, and the rest is rolled back", () => {
    const orig = {
      fetch: () => "f",
      connect: () => "c",
      request: () => "r",
      get: () => "g",
      tlsConnect: () => "t",
      lookup: () => "l",
    };
    const installError = new Error("QA-injected install failure at dns.lookup");
    const global = { fetch: orig.fetch };
    // Reading dns.lookup is the last install stage: make fetch un-restorable just before failing.
    const dns = new Proxy(
      { lookup: orig.lookup },
      {
        get(target, key, receiver) {
          if (key === "lookup") {
            Object.defineProperty(global, "fetch", { configurable: false });
            throw installError;
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    const env: TripwireEnv = {
      global,
      socketProto: { connect: orig.connect },
      https: { request: orig.request, get: orig.get },
      tls: { connect: orig.tlsConnect },
      dns,
    };
    let thrown: unknown;
    try {
      installTripwire(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const agg = thrown as AggregateError;
    expect(agg.message).toBe("install failed and rollback failed");
    expect(agg.errors).toHaveLength(2);
    expect(agg.errors[0]).toBe(installError);
    expect(agg.errors[1]).toBeInstanceOf(AggregateError);
    const rollback = agg.errors[1] as AggregateError;
    expect(rollback.errors).toHaveLength(1);
    expect(rollback.errors[0]).toBeInstanceOf(TypeError);
    expect(Reflect.get(env.socketProto, "connect")).toBe(orig.connect);
    expect(Reflect.get(env.https, "request")).toBe(orig.request);
    expect(Reflect.get(env.https, "get")).toBe(orig.get);
    expect(Reflect.get(env.tls, "connect")).toBe(orig.tlsConnect);
    expect(Reflect.get(global, "fetch")).not.toBe(orig.fetch);
  });

  const withServer = async (
    handler: http.RequestListener,
    run: (port: number, sockets: net.Socket[]) => Promise<void>,
  ) => {
    const sockets: net.Socket[] = [];
    const server = http.createServer(handler);
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await run((server.address() as net.AddressInfo).port, sockets);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  };
  const closedWithin = (s: net.Socket, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (s.destroyed) return resolve(true);
      const t = setTimeout(() => resolve(false), ms);
      s.once("close", () => {
        clearTimeout(t);
        resolve(true);
      });
    });

  it("[client] a server that never answers fails at OUR deadline with the cause, and destroys only its own socket", async () => {
    await withServer(
      () => undefined,
      async (port, sockets) => {
        const started = Date.now();
        await expect(get(port, "/hang", undefined, 150)).rejects.toThrow(
          /GET \/hang: no complete response within 150ms \(no response headers\)/,
        );
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(140);
        expect(elapsed).toBeLessThan(1500);
        expect(sockets).toHaveLength(1);
        expect(await closedWithin(sockets[0]!, 1000)).toBe(true);
      },
    );
  });

  it("[client] a response that stops mid-body fails at the deadline naming the status, and a socket reset mid-body fails at once", async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { "content-length": "100" });
        res.write("abc");
        if (req.url === "/reset") setTimeout(() => req.socket.destroy(), 20);
      },
      async (port, sockets) => {
        await expect(get(port, "/stall", undefined, 200)).rejects.toThrow(
          /GET \/stall: no complete response within 200ms \(status 200 received, body incomplete\)/,
        );
        expect(await closedWithin(sockets[0]!, 1000)).toBe(true);
        const started = Date.now();
        await expect(get(port, "/reset", undefined, 1500)).rejects.toThrow(
          /GET \/reset: (response aborted mid-body|response closed before completion|response error: .*)/,
        );
        expect(Date.now() - started).toBeLessThan(1000);
      },
    );
  });

  it("[client] failing one request destroys only that request: a concurrent one on another socket still completes, and a success leaves no timer", async () => {
    await withServer(
      (req, res) => {
        if (req.url === "/slow-ok")
          setTimeout(() => res.end(JSON.stringify({ ok: true })), 400);
      },
      async (port, sockets) => {
        const timer = watchTimer(1777);
        const healthy = get(port, "/slow-ok", undefined, 1777);
        await settleTick();
        await expect(get(port, "/hang", undefined, 100)).rejects.toThrow(
          /GET \/hang: no complete response within 100ms/,
        );
        expect(sockets).toHaveLength(2);
        const reply = await healthy;
        expect(reply.status).toBe(200);
        expect(reply.json).toEqual({ ok: true });
        // Exactly one of the two server-side sockets was destroyed by the client: the hung one.
        expect(await closedWithin(sockets[1]!, 1000)).toBe(true);
        expect(sockets[0]!.destroyed).toBe(false);
        await settleTick();
        try {
          expect(timer.created()).toHaveLength(1);
          expect(timer.cleared()).toContain(timer.created()[0]);
        } finally {
          timer.stop();
        }
      },
    );
  });
});
