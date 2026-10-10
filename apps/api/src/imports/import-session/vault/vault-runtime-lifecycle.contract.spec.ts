require("../../../../../../scripts/test-db-env.cjs");

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as ts from "typescript";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  assertLifecycleBoot,
  assertLifecycleRegistry,
  bootVaultApp,
  CANONICAL_VAULT,
  canonicalVaultFixture,
  finishVaultFixture,
  getVaultGate,
  loadVaultGate,
  type RecoveryApp,
} from "../../../test-utils/import-session-vault-harness";
import {
  ART,
  REF,
  OWNER,
  PDF,
  bounded,
  fixture,
  gate as deferred,
  outcome,
  readAll,
} from "../../../test-utils/vault-foundation-harness";
import { ImportSessionModule } from "../import-session.module";
import { ImportChatBridge } from "../import-chat.bridge";
import { ImportChatGuard } from "../import-chat.guard";
import { VaultFdRegistry } from "./vault-fd-registry";
import * as storageModule from "./vault-storage";
import * as purgerModule from "./vault-purger";
import { parseVaultConfig } from "./vault.config";
import { startVaultBoot } from "./vault-boot";
import * as writerModule from "../import-session.writer";
import type { AuthenticatedImportContext } from "../import-session.contract";
import type { ImportSessionClock } from "../import-session.capability";
import { ImportSessionError } from "../import-session.errors";
import { authFor } from "../../../test-utils/import-session-harness";

const SECOND = "22222222-2222-4222-8222-222222222222";
const VALID = {
  IMPORT_VAULT_ENABLED: "true",
  IMPORT_VAULT_LOCK_FD: "99",
  VAULT_DIR: "/private-fixture",
  IMPORT_VAULT_IDLE_TIMEOUT_MS: "2000",
  IMPORT_VAULT_HEADROOM_BYTES: "1",
};

async function runtime(drain = 37) {
  loadVaultGate();
  const f = await fixture(2000, drain);
  let os: Awaited<ReturnType<typeof canonicalVaultFixture>> | undefined;
  try {
    os = await canonicalVaultFixture(f.root, drain);
    const authority = os.createGate(f.db, f.clock);
    assertLifecycleBoot(authority.boot);
    assertLifecycleRegistry(authority.registry);
    await bounded(authority.boot.settled);
    expect(authority.boot.state()).toBe("ON");
    return {
      f,
      os,
      authority,
      async finish() {
        await finishVaultFixture(
          () => authority.boot.revoke("SHUTDOWN"),
          () => jest.useRealTimers(),
          () => f.finish(),
          () => os?.close(),
        );
      },
    };
  } catch (error) {
    try {
      await finishVaultFixture(
        () => f.finish(),
        () => os?.close(),
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Runtime fixture setup failed",
      );
    }
    throw error;
  }
}

async function heldReadersAndWriter(
  r: Pick<Awaited<ReturnType<typeof runtime>>, "f" | "authority">,
) {
  const { f, authority } = r;
  await f.seedArtifact();
  await f.seedRef(REF, {
    state: "ATTACHED",
    artifactId: ART,
    reservedBytes: 0,
  });
  await f.seedRef(SECOND);
  await f.writeBlob();
  const readClose = f.gate(),
    writeClose = f.gate();
  const readHeld = f.gate(),
    writeHeld = f.gate();
  const handles = new Map<string, FileHandle>();
  const io = f.io({
    beforeClose: async (path, handle) => {
      if (!path.endsWith("/blob")) return;
      handles.set(path, handle);
      if (path.includes(SECOND)) {
        writeHeld.release();
        await writeClose.promise;
      } else {
        readHeld.release();
        await readClose.promise;
      }
    },
  });
  const reader = outcome(
    f.track(
      authority.storage.withArtifactReader(
        f.readCapture(),
        f.recheckRead,
        (stream) => readAll(stream),
      ),
    ),
  );
  const writer = outcome(
    f.track(
      authority.storage.writeClaim(
        f.claim({ refId: SECOND, temporaryStorageKey: `t/${SECOND}` }),
        Readable.from([PDF]),
        f.recheck,
      ),
    ),
  );
  await bounded(
    Promise.all([readHeld.promise, writeHeld.promise]),
    "actual R and A close entry",
  );
  expect(handles.size).toBe(2);
  expect([...handles.values()].every((h) => h.fd >= 0)).toBe(true);
  return { reader, writer, readClose, writeClose, handles, io };
}

interface AttemptWriterExports {
  runImportSessionWrite<T>(
    prisma: Pick<PrismaService, "$transaction">,
    clock: ImportSessionClock,
    scope: Readonly<Pick<AuthenticatedImportContext, "tenantId">>,
    work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
    assertCanStartAttempt?: () => undefined,
  ): Promise<T>;
}

type ActualWriterArguments = Parameters<
  typeof writerModule.runImportSessionWrite
>;
type ActualAttemptGuard = ActualWriterArguments extends [
  unknown,
  unknown,
  unknown,
  unknown,
  ...infer Tail,
]
  ? NonNullable<Tail[0]>
  : never;
// Missing-signature RED is separate; once declared, these inspect production types.
const actualWriterTyping: {
  acceptsAsyncGuard: [ActualAttemptGuard] extends [never]
    ? false
    : (() => Promise<undefined>) extends ActualAttemptGuard
      ? true
      : false;
  acceptsSyncGuard: [ActualAttemptGuard] extends [never]
    ? true
    : (() => undefined) extends ActualAttemptGuard
      ? true
      : false;
  acceptsTenantScope: [ActualAttemptGuard] extends [never]
    ? true
    : Readonly<
          Pick<AuthenticatedImportContext, "tenantId">
        > extends ActualWriterArguments[2]
      ? true
      : false;
} = {
  acceptsAsyncGuard: false,
  acceptsSyncGuard: true,
  acceptsTenantScope: true,
};

function assertAttemptWriter(
  value: unknown,
): asserts value is AttemptWriterExports {
  expect(value).toEqual(
    expect.objectContaining({
      runImportSessionWrite: expect.any(Function),
    }),
  );
}

// Declaration-only RED boundary; direct production types replace it at immutable GREEN.
function attemptWriter() {
  const file = ts.createSourceFile(
    "import-session.writer.ts",
    fs.readFileSync(join(__dirname, "../import-session.writer.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = file.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "runImportSessionWrite",
  );
  const guard = declaration?.parameters[4];
  expect({
    optionalAttemptGuard: guard
      ? !!(guard.questionToken || guard.initializer)
      : false,
  }).toEqual({ optionalAttemptGuard: true });
  const exports: unknown = writerModule;
  assertAttemptWriter(exports);
  return exports.runImportSessionWrite;
}

function observeWriter(db: PrismaService) {
  const transactions = jest.spyOn(db, "$transaction");
  const state: {
    active: boolean;
    actions: string[];
    locks: { query: string; parameters: unknown; rows: number }[];
    beforeLock?: () => Promise<void>;
  } = { active: true, actions: [], locks: [] };
  db.$use(async (params, next) => {
    if (!state.active) return next(params);
    state.actions.push(`${params.model ?? "raw"}.${params.action}`);
    if (params.action !== "executeRaw") return next(params);
    const args: unknown = params.args;
    expect(args).toEqual([
      ["UPDATE tenants SET id = id WHERE id = ", ""],
      OWNER.tenantId,
    ]);
    if (!Array.isArray(args) || !Array.isArray(args[0]))
      throw new Error("native tagged SQL middleware arguments absent");
    const query = args[0].join("?");
    const parameters: unknown = args.slice(1);
    await state.beforeLock?.();
    const rows: number = await next(params);
    expect(rows).toBe(1);
    state.locks.push({ query, parameters, rows });
    return rows;
  });
  return {
    state,
    transactions,
    assertAttempts(count: number) {
      expect(transactions).toHaveBeenCalledTimes(count);
      expect(state.locks).toHaveLength(count);
      for (const call of transactions.mock.calls)
        expect(call[1]).toEqual({ maxWait: 5000, timeout: 20000 });
    },
    stop() {
      state.active = false;
      transactions.mockRestore();
    },
  };
}

async function writerEvidence(
  f: Awaited<ReturnType<typeof fixture>>,
  audit: ReturnType<typeof observeWriter>,
  label: string,
  detail: object,
) {
  audit.state.active = false;
  await fsp.writeFile(
    join(f.dir, `${label}-writer.json`),
    JSON.stringify(
      {
        ...detail,
        transactions: audit.transactions.mock.calls.length,
        actions: audit.state.actions,
        nativeLocks: audit.state.locks,
        committedTenant: await f.db.tenant.findUniqueOrThrow({
          where: { id: OWNER.tenantId },
        }),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  audit.stop();
  await f.snapshot(label, true);
}

describe("P05 WRITER mediated retry seam", () => {
  async function legacy() {
    const f = await fixture();
    try {
      const user = await f.db.user.findUniqueOrThrow({
        where: { id: OWNER.ownerUserId },
      });
      return {
        f,
        auth: authFor(user, {
          expiresAt: new Date(f.clock.now().getTime() + 60_000),
        }),
        before: await f.db.tenant.findUniqueOrThrow({
          where: { id: OWNER.tenantId },
        }),
      };
    } catch (error) {
      await f.finish();
      throw error;
    }
  }

  it("WRITER declaration RED requires the optional fifth argument before guarded behavioral cases can run", () => {
    expect(attemptWriter()).toBe(writerModule.runImportSessionWrite);
    expect(actualWriterTyping).toEqual({
      acceptsAsyncGuard: false,
      acceptsSyncGuard: true,
      acceptsTenantScope: true,
    });
  });

  it("WRITER CONTROL omitted guard preserves successful real lock, clock and committed work", async () => {
    const { f, auth } = await legacy();
    const audit = observeWriter(f.db);
    const work = jest.fn(async (tx: Prisma.TransactionClient, now: Date) => {
      expect(now).toEqual(f.clock.now());
      const row = await tx.tenant.update({
        where: { id: OWNER.tenantId },
        data: { name: "writer-success" },
      });
      return { id: row.id, name: row.name };
    });
    try {
      expect(
        await f.track(
          writerModule.runImportSessionWrite(f.db, f.clock, auth, work),
        ),
      ).toEqual({ id: OWNER.tenantId, name: "writer-success" });
      audit.assertAttempts(1);
      expect(work).toHaveBeenCalledTimes(1);
      audit.state.active = false;
      expect(
        await f.db.tenant.findUniqueOrThrow({
          where: { id: OWNER.tenantId },
        }),
      ).toMatchObject({ id: OWNER.tenantId, name: "writer-success" });
      await writerEvidence(f, audit, "writer-success", {
        workCalls: work.mock.calls.length,
      });
    } finally {
      audit.stop();
      await f.finish();
    }
  });

  it.each([
    ["SQLITE_BUSY", () => new Error("SQLITE_BUSY: reversible fixture retry")],
    [
      "P2034",
      () =>
        new Prisma.PrismaClientKnownRequestError("fixture conflict", {
          code: "P2034",
          clientVersion: "qa-fixture",
        }),
    ],
    [
      "P2002",
      () =>
        new Prisma.PrismaClientKnownRequestError("fixture unique conflict", {
          code: "P2002",
          clientVersion: "qa-fixture",
        }),
    ],
  ] as const)(
    "WRITER CONTROL omitted guard preserves %s rollback then retry-success",
    async (_kind, makeError) => {
      const { f, auth, before } = await legacy();
      const audit = observeWriter(f.db);
      let calls = 0;
      const work = async (tx: Prisma.TransactionClient, now: Date) => {
        calls++;
        expect(now).toEqual(f.clock.now());
        expect(
          await tx.tenant.findUniqueOrThrow({ where: { id: OWNER.tenantId } }),
        ).toEqual(before);
        await tx.tenant.update({
          where: { id: OWNER.tenantId },
          data: { name: `writer-attempt-${calls}` },
        });
        if (calls === 1) throw makeError();
        return calls;
      };
      try {
        expect(
          await f.track(
            writerModule.runImportSessionWrite(f.db, f.clock, auth, work),
          ),
        ).toBe(2);
        audit.assertAttempts(2);
        expect(calls).toBe(2);
        audit.state.active = false;
        expect(
          await f.db.tenant.findUniqueOrThrow({
            where: { id: OWNER.tenantId },
          }),
        ).toMatchObject({ name: "writer-attempt-2" });
        await writerEvidence(f, audit, `writer-retry-${_kind}`, {
          workCalls: calls,
          before,
        });
      } finally {
        audit.stop();
        await f.finish();
      }
    },
  );

  it.each([
    ["ordinary", () => new Error("synthetic nonretryable failure")],
    [
      "P2025",
      () =>
        new Prisma.PrismaClientKnownRequestError("fixture not found", {
          code: "P2025",
          clientVersion: "qa-fixture",
        }),
    ],
  ] as const)(
    "WRITER CONTROL omitted guard preserves %s nonretryable identity and rollback",
    async (_kind, makeError) => {
      const { f, auth, before } = await legacy();
      const audit = observeWriter(f.db);
      const failure = makeError();
      const work = jest.fn(async (tx: Prisma.TransactionClient) => {
        await tx.tenant.update({
          where: { id: OWNER.tenantId },
          data: { name: "must-rollback" },
        });
        throw failure;
      });
      try {
        await expect(
          f.track(
            writerModule.runImportSessionWrite(f.db, f.clock, auth, work),
          ),
        ).rejects.toBe(failure);
        audit.assertAttempts(1);
        expect(work).toHaveBeenCalledTimes(1);
        audit.state.active = false;
        expect(
          await f.db.tenant.findUniqueOrThrow({
            where: { id: OWNER.tenantId },
          }),
        ).toEqual(before);
        await writerEvidence(f, audit, `writer-nonretry-${_kind}`, {
          workCalls: work.mock.calls.length,
          before,
        });
      } finally {
        audit.stop();
        await f.finish();
      }
    },
  );

  it("WRITER CONTROL omitted guard exhausts exactly three real attempts, preserves deadlines and rolls every update back", async () => {
    const { f, auth, before } = await legacy();
    const audit = observeWriter(f.db);
    const work = jest.fn(async (tx: Prisma.TransactionClient) => {
      expect(
        await tx.tenant.findUniqueOrThrow({ where: { id: OWNER.tenantId } }),
      ).toEqual(before);
      await tx.tenant.update({
        where: { id: OWNER.tenantId },
        data: { name: "must-never-commit" },
      });
      throw new Error("SQLITE_BUSY: exhaust mediated existing budget");
    });
    try {
      const result = await outcome(
        f.track(writerModule.runImportSessionWrite(f.db, f.clock, auth, work)),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("exhausted writer unexpectedly committed");
      expect(result.error).toBeInstanceOf(ImportSessionError);
      expect(result.error).toMatchObject({
        code: "RETRYABLE_WRITE_CONFLICT",
        status: 503,
        retryable: true,
      });
      audit.assertAttempts(3);
      expect(work).toHaveBeenCalledTimes(3);
      audit.state.active = false;
      expect(
        await f.db.tenant.findUniqueOrThrow({ where: { id: OWNER.tenantId } }),
      ).toEqual(before);
      await writerEvidence(f, audit, "writer-exhaustion", {
        workCalls: work.mock.calls.length,
        before,
      });
    } finally {
      audit.stop();
      await f.finish();
    }
  });

  it("WRITER stop after the first real lock and reversible update rejects before retry dispatch, even with work recheck retained", async () => {
    const write = attemptWriter();
    const r = await runtime();
    const audit = observeWriter(r.f.db);
    const captured = r.authority.boot.runtime();
    const terminal = new storageModule.VaultIoError({
      kind: "UNAVAILABLE",
      step: "runtime",
    });
    const assertLive = (): undefined => {
      if (
        r.authority.boot.stopped.aborted ||
        r.authority.boot.runtime() !== captured
      )
        throw terminal;
      return undefined;
    };
    const guard = jest.fn(assertLive);
    const before = await r.f.db.tenant.findUniqueOrThrow({
      where: { id: OWNER.tenantId },
    });
    const work = jest.fn(async (tx: Prisma.TransactionClient) => {
      assertLive();
      await tx.tenant.update({
        where: { id: OWNER.tenantId },
        data: { name: "retry-must-rollback" },
      });
      r.authority.boot.revoke("SHUTDOWN");
      throw new Error("SQLITE_BUSY: first real transaction must roll back");
    });
    try {
      await expect(
        r.f.track(
          write(r.f.db, r.f.clock, { tenantId: OWNER.tenantId }, work, guard),
        ),
      ).rejects.toBe(terminal);
      expect(r.authority.boot.stopped.aborted).toBe(true);
      audit.assertAttempts(1);
      expect(guard).toHaveBeenCalledTimes(2);
      expect(work).toHaveBeenCalledTimes(1);
      expect(
        audit.state.actions.filter((a) => a === "Tenant.update"),
      ).toHaveLength(1);
      audit.state.active = false;
      expect(
        await r.f.db.tenant.findUniqueOrThrow({
          where: { id: OWNER.tenantId },
        }),
      ).toEqual(before);
      await writerEvidence(r.f, audit, "writer-stop-before-retry", {
        guardCalls: guard.mock.calls.length,
        workCalls: work.mock.calls.length,
        before,
      });
    } finally {
      audit.stop();
      await r.finish();
    }
  });

  it("WRITER stopped before the first attempt emits zero transaction, SQL or work", async () => {
    const write = attemptWriter();
    const r = await runtime();
    const terminal = new storageModule.VaultIoError({
      kind: "UNAVAILABLE",
      step: "runtime",
    });
    await r.authority.shutdown();
    const audit = observeWriter(r.f.db);
    const guard = jest.fn((): undefined => {
      if (r.authority.boot.stopped.aborted) throw terminal;
      return undefined;
    });
    const work = jest.fn(async () => "must-not-run");
    try {
      await expect(
        r.f.track(
          write(r.f.db, r.f.clock, { tenantId: OWNER.tenantId }, work, guard),
        ),
      ).rejects.toBe(terminal);
      audit.assertAttempts(0);
      expect(audit.state.actions).toEqual([]);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(work).not.toHaveBeenCalled();
      await writerEvidence(r.f, audit, "writer-stopped-first", {
        guardCalls: guard.mock.calls.length,
        workCalls: work.mock.calls.length,
      });
    } finally {
      audit.stop();
      await r.finish();
    }
  });

  it("WRITER an already-dispatched real transaction may emit its lock; the preserved work recheck denies effects", async () => {
    const write = attemptWriter();
    const r = await runtime();
    const audit = observeWriter(r.f.db),
      entered = deferred(),
      resume = deferred();
    const captured = r.authority.boot.runtime();
    const terminal = new storageModule.VaultIoError({
      kind: "UNAVAILABLE",
      step: "runtime",
    });
    const assertLive = (): undefined => {
      if (
        r.authority.boot.stopped.aborted ||
        r.authority.boot.runtime() !== captured
      )
        throw terminal;
      return undefined;
    };
    const guard = jest.fn(assertLive);
    const before = await r.f.db.tenant.findUniqueOrThrow({
      where: { id: OWNER.tenantId },
    });
    audit.state.beforeLock = async () => {
      entered.release();
      await resume.promise;
    };
    const work = jest.fn(async (tx: Prisma.TransactionClient) => {
      assertLive();
      await tx.tenant.update({
        where: { id: OWNER.tenantId },
        data: { name: "must-not-write-after-stop" },
      });
    });
    let pending: Promise<void> | undefined;
    try {
      pending = r.f.track(
        write(r.f.db, r.f.clock, { tenantId: OWNER.tenantId }, work, guard),
      );
      await bounded(
        Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("writer finished before native lock barrier");
          }),
        ]),
      );
      expect(audit.transactions).toHaveBeenCalledTimes(1);
      expect(audit.state.locks).toEqual([]);
      await r.authority.shutdown();
      resume.release();
      await expect(bounded(pending)).rejects.toBe(terminal);
      audit.assertAttempts(1);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledTimes(1);
      expect(audit.state.actions.filter((a) => a === "Tenant.update")).toEqual(
        [],
      );
      audit.state.active = false;
      expect(
        await r.f.db.tenant.findUniqueOrThrow({
          where: { id: OWNER.tenantId },
        }),
      ).toEqual(before);
      await writerEvidence(r.f, audit, "writer-already-dispatched", {
        guardCalls: guard.mock.calls.length,
        workCalls: work.mock.calls.length,
        before,
      });
    } finally {
      resume.release();
      if (pending) await bounded(outcome(pending));
      audit.stop();
      await r.finish();
    }
  });

  it("WRITER a guard error containing SQLITE_BUSY propagates unchanged without entering the retry classifier", async () => {
    const write = attemptWriter();
    const { f } = await legacy();
    const audit = observeWriter(f.db);
    const failure = new Error(
      "SQLITE_BUSY: terminal pre-attempt guard, not a write failure",
    );
    expect(writerModule.isRetryableWriteFailure(failure)).toBe(true);
    const guard = jest.fn((): undefined => {
      throw failure;
    });
    const work = jest.fn(async () => "must-not-run");
    try {
      await expect(
        f.track(
          write(f.db, f.clock, { tenantId: OWNER.tenantId }, work, guard),
        ),
      ).rejects.toBe(failure);
      audit.assertAttempts(0);
      expect(audit.state.actions).toEqual([]);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(work).not.toHaveBeenCalled();
      await writerEvidence(f, audit, "writer-guard-busy", {
        guardCalls: guard.mock.calls.length,
        workCalls: work.mock.calls.length,
      });
    } finally {
      audit.stop();
      await f.finish();
    }
  });
});

describe("P05 independent runtime and lifecycle seams", () => {
  it.each([
    undefined,
    "",
    "-1",
    "-0",
    "+1",
    "1.0",
    "1e3",
    "0x25",
    "1_000",
    " 1",
    "1 ",
    "2147483648",
    "9007199254740992",
    "Infinity",
    "NaN",
  ])(
    "R03 missing/invalid drain %s is OFF before probes or timers",
    async (value) => {
      const env = { ...VALID, IMPORT_VAULT_DRAIN_TIMEOUT_MS: value };
      expect(parseVaultConfig(env)).toEqual({
        configured: false,
        reason: "DRAIN_TIMEOUT_UNSET",
      });
      const spies: jest.SpyInstance[] = [];
      try {
        const stat = jest.spyOn(fs, "fstat");
        spies.push(stat);
        const open = jest.spyOn(fsp, "open");
        spies.push(open);
        const timer = jest.spyOn(global, "setTimeout");
        spies.push(timer);
        const boot = startVaultBoot(env, {
          publicDir: "/public-fixture",
          privateDir: "/private-uploads-fixture",
        });
        expect(boot.state()).toBe("OFF");
        expect(boot.reason).toBe("DRAIN_TIMEOUT_UNSET");
        expect(boot.runtime()).toBeNull();
        expect(stat).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(timer).not.toHaveBeenCalled();
      } finally {
        await finishVaultFixture(
          ...spies.reverse().map((spy) => () => spy.mockRestore()),
        );
      }
    },
  );

  it.each(["0", "1", "00037", "2147483647"])(
    "R04 literal drain boundary %s is syntax, not production approval",
    (value) => {
      expect(
        parseVaultConfig({ ...VALID, IMPORT_VAULT_DRAIN_TIMEOUT_MS: value }),
      ).toMatchObject({
        configured: true,
        drainTimeoutMs: Number(value),
        idleTimeoutMs: 2000,
      });
    },
  );

  it("CONTROL FLAG_OFF and prior configuration precedence are unchanged", () => {
    expect(
      parseVaultConfig({
        IMPORT_VAULT_ENABLED: "false",
        IMPORT_VAULT_DRAIN_TIMEOUT_MS: "-1",
      }),
    ).toEqual({ configured: false, reason: "FLAG_OFF" });
    expect(parseVaultConfig({ ...VALID, IMPORT_VAULT_LOCK_FD: "0" })).toEqual({
      configured: false,
      reason: "NO_LOCK_FD",
    });
  });

  it("R01 single private gate binds identical instances and caches one real purger", async () => {
    const exports = loadVaultGate();
    const f = await fixture();
    let api: RecoveryApp | undefined;
    const Storage = storageModule.VaultStorage,
      Purger = purgerModule.PurgeCoordinator;
    const storage = jest
      .spyOn(storageModule, "VaultStorage")
      .mockImplementation((...args) => new Storage(...args));
    const purger = jest
      .spyOn(purgerModule, "PurgeCoordinator")
      .mockImplementation((...args) => new Purger(...args));
    try {
      api = await bootVaultApp(f.db, {
        vault: CANONICAL_VAULT,
        vaultDir: f.root,
      });
      const authority = getVaultGate(api);
      expect(storage).toHaveBeenCalledTimes(1);
      expect(storage).toHaveBeenCalledWith(
        authority.boot,
        authority.registry,
        api.clock,
      );
      expect(authority.requirePurger()).toBe(authority.requirePurger());
      expect(purger).toHaveBeenCalledTimes(1);
      expect(purger).toHaveBeenCalledWith(
        api.app.get(PrismaService),
        api.clock,
        authority.boot,
        authority.registry,
        authority.storage,
        37,
      );
      const providers: { provide?: unknown }[] = Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        ImportSessionModule,
      );
      expect(
        providers.filter((p) => p.provide === exports.IMPORT_VAULT_GATE),
      ).toHaveLength(1);
      expect(
        providers.some(
          (p) =>
            p.provide === "IMPORT_VAULT_STATE" ||
            p.provide === "IMPORT_VAULT_GATE",
        ),
      ).toBe(false);
      expect(
        Reflect.getMetadata(MODULE_METADATA.EXPORTS, ImportSessionModule) ?? [],
      ).toEqual([ImportChatGuard, ImportChatBridge]);
    } finally {
      storage.mockRestore();
      purger.mockRestore();
      try {
        await api?.close();
      } finally {
        await f.finish();
      }
    }
  });

  it("pending canonical boot blocks Nest initialization until bounded settlement", async () => {
    loadVaultGate();
    const f = await fixture(),
      os = await canonicalVaultFixture(f.root);
    const held = f.gate(),
      entered = f.gate();
    const native = fsp.lstat.bind(fsp);
    const spy = jest.spyOn(fsp, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fsp.lstat>
    ) => {
      if (String(args[0]) === join(f.root, ".lock")) {
        entered.release();
        await held.promise;
      }
      return native(...args);
    }) as typeof fsp.lstat);
    let api: RecoveryApp | undefined;
    try {
      let initialized = false;
      const pending = bootVaultApp(f.db, {
        vault: CANONICAL_VAULT,
        fixture: os,
        settleBoot: false,
      }).then((value) => {
        initialized = true;
        return value;
      });
      await bounded(entered.promise);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(initialized).toBe(false);
      held.release();
      api = await bounded(pending, "HTTP init after held real probe");
      const boot = getVaultGate(api).boot;
      expect(boot.state()).toBe("ON");
    } finally {
      held.release();
      spy.mockRestore();
      try {
        await api?.close();
      } finally {
        await f.finish();
      }
    }
  });

  it.each(
    (["lock", "root", "sync-close", "statfs"] as const).flatMap((stage) => [
      { stage, lateError: false },
      { stage, lateError: true },
    ]),
  )(
    "R05 revocation beats late native $stage, lateError=$lateError, without closing borrowed lock",
    async ({ stage, lateError }) => {
      const os = await canonicalVaultFixture();
      const held = deferred(),
        entered = deferred(),
        completed = deferred();
      const reported = deferred();
      let observedStage = false;
      let realCloseCompleted = false;
      const nativeLstat = fsp.lstat.bind(fsp),
        nativeStatfs = fsp.statfs.bind(fsp),
        nativeOpen = fsp.open.bind(fsp);
      const owned: FileHandle[] = [];
      const spies: jest.SpyInstance[] = [];
      const nativeError = Logger.prototype.error;
      spies.push(
        jest.spyOn(Logger.prototype, "error").mockImplementation(function (
          this: Logger,
          ...args
        ) {
          if (
            args[0] &&
            typeof args[0] === "object" &&
            "late" in args[0] &&
            args[0].late === true
          )
            reported.release();
          return nativeError.apply(this, args);
        }),
      );
      const lateFailure = () => {
        if (lateError) throw Object.assign(new Error(os.root), { code: "EIO" });
      };
      if (stage === "lock" || stage === "root")
        spies.push(
          jest.spyOn(fsp, "lstat").mockImplementation((async (
            ...args: Parameters<typeof fsp.lstat>
          ) => {
            if (
              String(args[0]) ===
              (stage === "lock" ? join(os.root, ".lock") : os.root)
            ) {
              observedStage = true;
              entered.release();
              await held.promise;
              try {
                const value = await nativeLstat(...args);
                lateFailure();
                return value;
              } finally {
                completed.release();
              }
            }
            return nativeLstat(...args);
          }) as typeof fsp.lstat),
        );
      if (stage === "statfs")
        spies.push(
          jest.spyOn(fsp, "statfs").mockImplementation((async (
            ...args: Parameters<typeof fsp.statfs>
          ) => {
            observedStage = true;
            entered.release();
            await held.promise;
            try {
              const value = await nativeStatfs(...args);
              lateFailure();
              return value;
            } finally {
              completed.release();
            }
          }) as typeof fsp.statfs),
        );
      if (stage === "sync-close")
        spies.push(
          jest.spyOn(fsp, "open").mockImplementation(async (...args) => {
            const handle = await nativeOpen(...args);
            if (String(args[0]) === join(os.root, "t")) {
              owned.push(handle);
              const close = handle.close.bind(handle);
              handle.close = async () => {
                observedStage = true;
                entered.release();
                await held.promise;
                try {
                  await close();
                  realCloseCompleted = true;
                  lateFailure();
                } finally {
                  completed.release();
                }
              };
            }
            return handle;
          }),
        );
      const boot = os.startBoot();
      try {
        assertLifecycleBoot(boot);
        await bounded(entered.promise, stage);
        boot.revoke("SHUTDOWN");
        expect([
          boot.state(),
          boot.reason,
          boot.runtime(),
          boot.stopped.aborted,
        ]).toEqual(["OFF", "SHUTDOWN", null, true]);
        await bounded(boot.settled);
        held.release();
        await bounded(completed.promise, "actual late native completion");
        if (lateError)
          await bounded(reported.promise, "late error is reported");
        if (stage === "sync-close") expect(realCloseCompleted).toBe(true);
        boot.revoke("LOCK_REPLACED");
        expect(boot.reason).toBe("SHUTDOWN");
        expect(boot.runtime()).toBeNull();
        expect(os.borrowed.fd).toBeGreaterThanOrEqual(3);
      } finally {
        held.release();
        await bounded(boot.settled);
        if (observedStage)
          await bounded(completed.promise, "late native cleanup");
        for (const handle of owned) if (handle.fd !== -1) await handle.close();
        spies.reverse().forEach((s) => s.mockRestore());
        await os.close();
      }
    },
  );

  it("R06 a newly observed real file identity fails even when the synthetic lock decision is positive", async () => {
    const r = await runtime();
    let replacement: FileHandle | undefined;
    let redirected: jest.SpyInstance | undefined;
    try {
      const handle = await fsp.open(
        join(r.os.dir, "replacement"),
        "wx+",
        0o600,
      );
      replacement = handle;
      const native = fs.fstat.bind(fs);
      redirected = jest.spyOn(fs, "fstat").mockImplementation(((
        ...args: Parameters<typeof fs.fstat>
      ) => {
        if (args[0] === r.os.borrowed.fd) args[0] = handle.fd;
        return native(...args);
      }) as typeof fs.fstat);
      const before = r.authority.boot.runtime();
      expect((await replacement.stat({ bigint: true })).ino).not.toBe(
        before?.lockIdentity.ino,
      );
      expect(await bounded(r.authority.boot.recheckLock())).toEqual({
        ok: false,
      });
      expect(redirected).toHaveBeenCalled();
      expect([
        r.authority.boot.state(),
        r.authority.boot.reason,
        r.authority.boot.runtime(),
        r.authority.boot.stopped.aborted,
      ]).toEqual(["OFF", "LOCK_REPLACED", null, true]);
      expect(r.os.borrowed.fd).toBeGreaterThanOrEqual(3);
    } finally {
      await finishVaultFixture(
        () => redirected?.mockRestore(),
        () => replacement?.close(),
        () => r.finish(),
      );
    }
  });

  it.each(["denied", "io-error", "late-error"] as const)(
    "R07 recheck %s fails closed, never resurrects and never reprobes after stop",
    async (mode) => {
      const r = await runtime();
      const held = r.f.gate(),
        entered = r.f.gate(),
        completed = r.f.gate();
      const native = fsp.lstat.bind(fsp);
      const spy = jest.spyOn(fsp, "lstat").mockImplementation((async (
        ...args: Parameters<typeof fsp.lstat>
      ) => {
        if (String(args[0]) === join(r.f.root, ".lock") && mode !== "denied") {
          entered.release();
          if (mode === "late-error") await held.promise;
          completed.release();
          throw Object.assign(new Error(r.f.root), { code: "EACCES" });
        }
        return native(...args);
      }) as typeof fsp.lstat);
      try {
        if (mode === "denied") r.os.proof.denial = "LOCK_NOT_OWNED";
        const work = r.authority.boot.recheckLock();
        if (mode === "late-error") {
          await bounded(entered.promise);
          r.authority.boot.revoke("SHUTDOWN");
          expect(
            await bounded(
              work,
              "recheck waiter wakes without syscall completion",
            ),
          ).toEqual({ ok: false });
          held.release();
          await bounded(completed.promise);
        } else expect(await bounded(work)).toEqual({ ok: false });
        expect(r.authority.boot.reason).toBe(
          mode === "denied"
            ? "LOCK_NOT_OWNED"
            : mode === "io-error"
              ? "LOCK_CHECK_ERROR"
              : "SHUTDOWN",
        );
        expect(r.authority.boot.runtime()).toBeNull();
        expect(r.authority.boot.stopped.aborted).toBe(true);
        const calls = spy.mock.calls.length;
        expect(await r.authority.boot.recheckLock()).toEqual({ ok: false });
        expect(spy).toHaveBeenCalledTimes(calls);
      } finally {
        held.release();
        spy.mockRestore();
        await r.finish();
      }
    },
  );

  it("R08 concurrent rechecks collect once and return only the original frozen runtime", async () => {
    const r = await runtime();
    const held = r.f.gate(),
      entered = r.f.gate();
    const native = fsp.lstat.bind(fsp);
    let collections = 0;
    const spy = jest.spyOn(fsp, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fsp.lstat>
    ) => {
      if (String(args[0]) === join(r.f.root, ".lock")) {
        collections++;
        entered.release();
        await held.promise;
      }
      return native(...args);
    }) as typeof fsp.lstat);
    try {
      const original = r.authority.boot.runtime();
      const first = r.authority.boot.recheckLock(),
        second = r.authority.boot.recheckLock();
      await bounded(entered.promise);
      expect(collections).toBe(1);
      held.release();
      for (const result of await bounded(Promise.all([first, second]))) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.runtime).toBe(original);
      }
      expect(collections).toBe(1);
      expect(Object.isFrozen(original)).toBe(true);
    } finally {
      held.release();
      spy.mockRestore();
      await r.finish();
    }
  });

  it("R09 global seal precedes R/A abort callbacks and cannot be undone by releaseFence", async () => {
    const registry = new VaultFdRegistry();
    assertLifecycleRegistry(registry);
    const first = registry.enter(`R:${REF}`, OWNER),
      second = registry.enter(`A:${ART}`, OWNER);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("initial admission failed");
    const attempts: unknown[] = [];
    for (const item of [first, second])
      item.lease.signal.addEventListener("abort", () => {
        attempts.push(
          registry.enter(`R:${SECOND}`, OWNER),
          registry.enter(`A:${SECOND}`, OWNER),
        );
      });
    try {
      const work = registry.shutdown(37);
      expect(attempts).toEqual(Array(4).fill({ ok: false, reason: "FENCED" }));
      expect(first.lease.signal.aborted && second.lease.signal.aborted).toBe(
        true,
      );
      registry.releaseFence(`R:${REF}`);
      expect(registry.enter(`R:${REF}`, OWNER)).toEqual({
        ok: false,
        reason: "FENCED",
      });
      expect(registry.shutdown(1000)).toBe(work);
      first.lease.exit();
      second.lease.exit();
      expect(await bounded(work)).toBe("DRAINED");
    } finally {
      first.lease.exit();
      second.lease.exit();
    }
  });

  it("R09 unconfigured drain retains outstanding leases; empty drain needs no timer", async () => {
    const registry = new VaultFdRegistry();
    assertLifecycleRegistry(registry);
    const item = registry.enter(`R:${REF}`, OWNER);
    if (!item.ok) throw new Error("initial admission failed");
    try {
      expect(await registry.shutdown(null)).toBe("UNCONFIGURED");
      expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF }]);
      expect(item.lease.signal.aborted).toBe(true);
      expect(registry.enter(`A:${ART}`, OWNER)).toEqual({
        ok: false,
        reason: "FENCED",
      });
    } finally {
      item.lease.exit();
    }
    const empty = new VaultFdRegistry();
    assertLifecycleRegistry(empty);
    const timer = jest.spyOn(global, "setTimeout");
    try {
      expect(await empty.shutdown(null)).toBe("DRAINED");
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });

  it("R10/R14 purge finally removes its fence but cannot reopen global shutdown; both use the explicit 37ms budget", async () => {
    const r = await runtime();
    await r.f.seedRef(REF, { state: "FAILED", temporaryPurgePending: true });
    await r.f.writeBlob();
    const lease = r.authority.registry.enter(`R:${REF}`, OWNER);
    if (!lease.ok) throw new Error("initial admission failed");
    const entered = r.f.gate();
    const native = r.authority.registry.abortAndDrain.bind(
      r.authority.registry,
    );
    const drain = jest
      .spyOn(r.authority.registry, "abortAndDrain")
      .mockImplementation((...args) => {
        entered.release();
        return native(...args);
      });
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      let settled = false;
      const purge = r.authority
        .requirePurger()
        .purge(r.f.target())
        .then((value) => {
          settled = true;
          return value;
        });
      await bounded(entered.promise);
      expect(drain).toHaveBeenCalledWith(`R:${REF}`, 37);
      const shutdown = r.authority.shutdown();
      await jest.advanceTimersByTimeAsync(36);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await bounded(purge)).toBe("DRAIN_TIMEOUT");
      expect(await bounded(shutdown)).toBe("TIMEOUT");
      expect(r.authority.registry.enter(`R:${REF}`, OWNER)).toEqual({
        ok: false,
        reason: "FENCED",
      });
      expect(r.authority.registry.enter(`A:${ART}`, OWNER)).toEqual({
        ok: false,
        reason: "FENCED",
      });
      expect(r.authority.registry.snapshotUploads()).toEqual([
        { ...OWNER, refId: REF },
      ]);
      expect((await r.f.rows()).refs[0].reservedBytes).toBe(PDF.length);
      expect(await fsp.readFile(join(r.f.root, `t/${REF}/g2/blob`))).toEqual(
        PDF,
      );
    } finally {
      lease.lease.exit();
      drain.mockRestore();
      await r.finish();
    }
  });

  it("R11 DRAINED waits for BOTH real R and A bound closes, not callback completion", async () => {
    const r = await runtime();
    try {
      const held = await heldReadersAndWriter(r);
      let drained = false;
      const work = r.authority.shutdown().then((result) => {
        drained = true;
        return result;
      });
      expect(drained).toBe(false);
      held.readClose.release();
      await bounded(held.reader);
      expect(drained).toBe(false);
      expect(r.authority.registry.snapshotUploads()).toHaveLength(1);
      held.writeClose.release();
      await bounded(held.writer);
      expect(await bounded(work)).toBe("DRAINED");
      expect([...held.handles.values()].every((h) => h.fd === -1)).toBe(true);
      expect(
        held.io.events.filter(
          (e) => e.op === "close:done" && e.path.endsWith("/blob"),
        ),
      ).toHaveLength(2);
      expect(r.authority.registry.snapshotUploads()).toEqual([]);
    } finally {
      await r.finish();
    }
  });

  it("R11/R15 shutdown drains without database availability; timeout preserves real handles and committed charge", async () => {
    const r = await runtime();
    let observing = false;
    const queries: string[] = [];
    r.f.db.$use(async (params, next) => {
      if (observing) queries.push(params.action);
      return next(params);
    });
    try {
      const held = await heldReadersAndWriter(r);
      const before = await r.f.rows();
      await r.f.db.$disconnect();
      const connect = jest.spyOn(r.f.db, "$connect");
      const transaction = jest.spyOn(r.f.db, "$transaction");
      observing = true;
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        let finished = false;
        const hook = r.authority.onModuleDestroy().then(() => {
          finished = true;
        });
        expect(r.authority.boot.stopped.aborted).toBe(true);
        expect(r.authority.registry.enter(`A:${SECOND}`, OWNER)).toEqual({
          ok: false,
          reason: "FENCED",
        });
        await jest.advanceTimersByTimeAsync(36);
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await bounded(hook);
        expect(await r.authority.shutdown()).toBe("TIMEOUT");
        expect([...held.handles.values()].every((h) => h.fd >= 0)).toBe(true);
        expect(queries).toEqual([]);
        expect(connect).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        observing = false;
        connect.mockRestore();
        transaction.mockRestore();
        jest.useRealTimers();
      }
      expect(await r.f.rows()).toEqual(before);
      held.readClose.release();
      held.writeClose.release();
      await bounded(Promise.all([held.reader, held.writer]));
      expect([...held.handles.values()].every((h) => h.fd === -1)).toBe(true);
    } finally {
      observing = false;
      await r.finish();
    }
  });

  it.each(["disconnected", "concurrent-destruction"] as const)(
    "R15 real Nest hook drains with Prisma %s, without assuming destruction order",
    async (mode) => {
      loadVaultGate();
      const f = await fixture();
      let api: RecoveryApp | undefined;
      let closing: ReturnType<typeof outcome<void>> | undefined;
      let held: Awaited<ReturnType<typeof heldReadersAndWriter>> | undefined;
      let watching = false;
      let fakeClock = false;
      const observed: string[] = [];
      const spies: jest.SpyInstance[] = [];
      const finishClose = async () => {
        if (!closing) return;
        let pending = true;
        const settled = closing.then((result) => {
          pending = false;
          return result;
        });
        // Prisma/Nest and the evidence capture can enqueue timers after native I/O.
        const advanceTeardown = (async () => {
          while (pending) {
            if (fakeClock) await jest.runOnlyPendingTimersAsync();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })();
        try {
          const [result] = await bounded(
            Promise.all([settled, advanceTeardown]),
            "Nest hook integration, not a signal-delivery SLA",
          );
          if (!result.ok) throw result.error;
        } finally {
          pending = false;
          await advanceTeardown;
        }
      };
      try {
        api = await bootVaultApp(f.db, {
          vault: CANONICAL_VAULT,
          vaultDir: f.root,
        });
        const authority = getVaultGate(api);
        held = await heldReadersAndWriter({ f, authority });
        const active = held;
        const prisma = api.app.get(PrismaService);
        if (mode === "disconnected") await prisma.$disconnect();
        prisma.$use(async (params, next) => {
          if (watching) observed.push(params.action);
          return next(params);
        });
        const reconnect = jest.spyOn(prisma, "$connect");
        spies.push(reconnect);
        const nativeHook = authority.onModuleDestroy.bind(authority);
        let hookResolved = false;
        let hookWork: Promise<void> | undefined;
        let monotonicAtShutdown: number | undefined;
        const hook = jest
          .spyOn(authority, "onModuleDestroy")
          .mockImplementation(() => {
            jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
            fakeClock = true;
            monotonicAtShutdown = performance.now();
            hookWork = nativeHook().then(() => {
              hookResolved = true;
            });
            return hookWork;
          });
        spies.push(hook);
        const stopped = f.gate();
        authority.boot.stopped.addEventListener(
          "abort",
          () => stopped.release(),
          { once: true },
        );
        watching = true;
        closing = outcome(api.close());
        await bounded(stopped.promise, "standard Nest hook reaches gate");
        expect(hook).toHaveBeenCalledTimes(1);
        expect(hookResolved).toBe(false);
        expect(authority.registry.enter(`R:${REF}`, OWNER)).toEqual({
          ok: false,
          reason: "FENCED",
        });
        const drainedAtClosedHandles: boolean[] = [];
        const drainResults: string[] = [];
        const drain = authority.shutdown().then((result) => {
          drainResults.push(result);
          drainedAtClosedHandles.push(
            [...active.handles.values()].every((h) => h.fd === -1),
          );
          return result;
        });
        held.readClose.release();
        await bounded(held.reader);
        expect(drainedAtClosedHandles).toEqual([]);
        expect(drainResults).toEqual([]);
        expect(hookResolved).toBe(false);
        held.writeClose.release();
        await bounded(held.writer);
        expect(await bounded(drain)).toBe("DRAINED");
        if (!hookWork) throw new Error("Nest did not invoke the runtime hook");
        await bounded(hookWork);
        expect(drainResults).toEqual(["DRAINED"]);
        expect(drainedAtClosedHandles).toEqual([true]);
        expect(hookResolved).toBe(true);
        expect(performance.now()).toBe(monotonicAtShutdown);
        expect([...held.handles.values()].every((h) => h.fd === -1)).toBe(true);
        await finishClose();
        expect(observed).toEqual([]);
        expect(reconnect).not.toHaveBeenCalled();
      } finally {
        held?.readClose.release();
        held?.writeClose.release();
        await finishVaultFixture(
          async () => {
            if (held) await bounded(Promise.all([held.reader, held.writer]));
          },
          async () => {
            if (!closing && api) closing = outcome(api.close());
            await finishClose();
          },
          () => {
            if (fakeClock) jest.useRealTimers();
            fakeClock = false;
            watching = false;
          },
          ...spies.reverse().map((spy) => () => spy.mockRestore()),
          () => f.finish(),
        );
      }
    },
  );

  it("R15 signal registration is explicit standard Nest hooks, not inferred from app.close", () => {
    const file = ts.createSourceFile(
      "main.ts",
      fs.readFileSync(join(__dirname, "../../../main.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const signals: string[][] = [];
    const custom: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        if (node.expression.name.text === "enableShutdownHooks") {
          const arg = node.arguments[0];
          expect(arg && ts.isArrayLiteralExpression(arg)).toBe(true);
          if (arg && ts.isArrayLiteralExpression(arg))
            signals.push(
              arg.elements
                .map((value) =>
                  ts.isStringLiteral(value) ? value.text : "NON_LITERAL",
                )
                .sort(),
            );
        }
        if (
          node.expression.expression.getText(file) === "process" &&
          ["on", "once", "addListener"].includes(node.expression.name.text) &&
          node.arguments.some(
            (arg) =>
              ts.isStringLiteral(arg) &&
              ["SIGTERM", "SIGINT"].includes(arg.text),
          )
        )
          custom.push(node.getText(file));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(signals).toEqual([["SIGINT", "SIGTERM"]]);
    expect(custom).toEqual([]);
  });
  it("R12 lock loss wakes an idle A consumer and closes an actual late R open without writing", async () => {
    const r = await runtime();
    const late = r.f.gate(),
      opened = r.f.gate(),
      reading = r.f.gate();
    let lateHandle: FileHandle | undefined;
    let writes: jest.SpyInstance | undefined;
    try {
      await r.f.seedArtifact();
      await r.f.seedRef(REF, { state: "ATTACHED", artifactId: ART });
      await r.f.seedRef(SECOND);
      await r.f.writeBlob();
      r.f.io({
        afterOpen: async (path, handle) => {
          if (path.endsWith(`${SECOND}/g2/blob`)) {
            lateHandle = handle;
            writes = jest.spyOn(handle, "write");
            opened.release();
            await late.promise;
          }
        },
      });
      const reader = outcome(
        r.f.track(
          r.authority.storage.withArtifactReader(
            r.f.readCapture(),
            r.f.recheckRead,
            async (stream) => {
              await new Promise<void>((resolve) => {
                stream.once("error", () => resolve());
                stream.once("close", () => resolve());
                reading.release();
                if (stream.destroyed) resolve();
              });
            },
          ),
        ),
      );
      const writer = outcome(
        r.f.track(
          r.authority.storage.writeClaim(
            r.f.claim({ refId: SECOND, temporaryStorageKey: `t/${SECOND}` }),
            Readable.from([PDF]),
            r.f.recheck,
          ),
        ),
      );
      await bounded(Promise.all([opened.promise, reading.promise]));
      r.os.proof.denial = "LOCK_NOT_OWNED";
      expect(await r.authority.boot.recheckLock()).toEqual({ ok: false });
      await bounded(reader, "idle reader released by stop");
      expect(lateHandle?.fd).toBeGreaterThanOrEqual(3);
      expect(r.authority.registry.snapshotUploads()).toHaveLength(1);
      late.release();
      expect((await bounded(writer)).ok).toBe(false);
      expect(writes).not.toHaveBeenCalled();
      expect(lateHandle?.fd).toBe(-1);
      expect(r.authority.registry.snapshotUploads()).toEqual([]);
      expect(r.os.borrowed.fd).toBeGreaterThanOrEqual(3);
    } finally {
      late.release();
      writes?.mockRestore();
      await r.finish();
    }
  });

  it.each(["before-rename", "after-rename", "before-release"] as const)(
    "R13 purge revocation %s retains charge and respects completed physical proof",
    async (stage) => {
      const r = await runtime(),
        entered = r.f.gate(),
        held = r.f.gate();
      let erase: jest.SpyInstance | undefined;
      try {
        await r.f.seedRef(REF, {
          state: "FAILED",
          temporaryPurgePending: true,
        });
        await r.f.writeBlob();
        const io = r.f.io({
          beforeLstat: async (path) => {
            if (
              stage === "before-rename" &&
              path === join(r.f.root, `t/${REF}`)
            ) {
              entered.release();
              await held.promise;
            }
          },
          afterRename: async () => {
            if (stage === "after-rename") {
              entered.release();
              await held.promise;
            }
          },
        });
        if (stage === "before-release") {
          const native = r.authority.storage.eraseCaptured.bind(
            r.authority.storage,
          );
          erase = jest
            .spyOn(r.authority.storage, "eraseCaptured")
            .mockImplementation(async (...args) => {
              const result = await native(...args);
              entered.release();
              await held.promise;
              return result;
            });
        }
        const work = outcome(
          r.f.track(r.authority.requirePurger().purge(r.f.target())),
        );
        await bounded(entered.promise);
        r.authority.boot.revoke("LOCK_REPLACED");
        held.release();
        expect(await bounded(work)).toMatchObject({
          ok: false,
          error: { kind: "UNAVAILABLE" },
        });
        const row = (await r.f.rows()).refs[0];
        expect(row).toMatchObject({
          reservedBytes: PDF.length,
          temporaryPurgePending: true,
        });
        expect(row.temporaryStorageKey).not.toBeNull();
        expect(io.events.filter((e) => e.op === "rename:done")).toHaveLength(
          stage === "before-rename" ? 0 : 1,
        );
        expect(r.authority.registry.enter(`R:${REF}`, OWNER)).toEqual({
          ok: false,
          reason: "FENCED",
        });
      } finally {
        held.release();
        erase?.mockRestore();
        await r.finish();
      }
    },
  );

  it.each(["FLAG_OFF", "NO_LOCK_FD"] as const)(
    "ADDENDUM already-aborted %s binds synchronous R/A seal without a lost event",
    async (reason) => {
      loadVaultGate();
      const f = await fixture();
      let os: Awaited<ReturnType<typeof canonicalVaultFixture>> | undefined;
      const spies: jest.SpyInstance[] = [];
      try {
        os = await canonicalVaultFixture();
        os.arrangeOff(reason);
        const stat = jest.spyOn(fs, "fstat");
        spies.push(stat);
        const open = jest.spyOn(fsp, "open");
        spies.push(open);
        const authority = os.createGate(f.db, f.clock);
        expect(authority.boot.stopped.aborted).toBe(true);
        expect(authority.boot.runtime()).toBeNull();
        expect(authority.registry.enter(`R:${REF}`, OWNER)).toEqual({
          ok: false,
          reason: "FENCED",
        });
        expect(authority.registry.enter(`A:${ART}`, OWNER)).toEqual({
          ok: false,
          reason: "FENCED",
        });
        expect(stat).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(() => authority.requirePurger()).toThrow(
          expect.objectContaining({ kind: "UNAVAILABLE", step: "runtime" }),
        );
      } finally {
        await finishVaultFixture(
          ...spies.reverse().map((spy) => () => spy.mockRestore()),
          () => os?.close(),
          () => f.finish(),
        );
      }
    },
  );

  it("cleanup attempts every owned release even when restoration fails", async () => {
    const events: string[] = [];
    const restoration = new Error("restore failed");
    const closing = new Error("close failed");
    const result = await outcome(
      finishVaultFixture(
        () => {
          events.push("restore");
          throw restoration;
        },
        async () => {
          events.push("close");
          throw closing;
        },
        () => {
          events.push("disconnect");
        },
      ),
    );
    expect(events).toEqual(["restore", "close", "disconnect"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("cleanup failures were swallowed");
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(result.error).toMatchObject({ errors: [restoration, closing] });
  });

  it("ADDENDUM an already-issued DB callback may finish after a bounded shutdown; no fictitious FAILED/refund", async () => {
    const r = await runtime(),
      entered = r.f.gate(),
      held = r.f.gate();
    const source = new PassThrough();
    try {
      await r.f.seedRef();
      const before = await r.f.rows();
      const work = outcome(
        r.f.track(
          r.authority.storage.writeClaim(r.f.claim(), source, () =>
            r.f.locked(async () => {
              entered.release();
              await held.promise;
            }),
          ),
        ),
      );
      await bounded(entered.promise);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      const shutdown = r.authority.shutdown();
      await jest.advanceTimersByTimeAsync(37);
      expect(await bounded(shutdown)).toBe("TIMEOUT");
      expect(r.authority.registry.snapshotUploads()).toHaveLength(1);
      jest.useRealTimers();
      held.release();
      expect((await bounded(work)).ok).toBe(false);
      expect(await r.f.rows()).toEqual(before);
      expect(r.authority.registry.snapshotUploads()).toEqual([]);
    } finally {
      source.destroy();
      held.release();
      await r.finish();
    }
  });
});
