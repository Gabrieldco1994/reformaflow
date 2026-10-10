/** Real HTTP graph and canonical boot fixtures. Synthetic lock decisions are not Linux/OFD proof. */
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  cpSync,
  existsSync,
  promises as fsp,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { Prisma, PrismaClient } from "@prisma/client";
import passport from "passport";
import { JwtStrategy } from "../auth/jwt.strategy";
import { PrismaService } from "../prisma/prisma.service";
import type { ImportSessionClock } from "../imports/import-session/import-session.capability";
import { resolveUploadsRoots } from "../common/uploads-roots";
import {
  startVaultBoot,
  type VaultBootHandle,
  type VaultRuntime,
} from "../imports/import-session/vault/vault-boot";
import { VaultFdRegistry } from "../imports/import-session/vault/vault-fd-registry";
import { VaultStorage } from "../imports/import-session/vault/vault-storage";
import { PurgeCoordinator } from "../imports/import-session/vault/vault-purger";
import * as lockProof from "../imports/import-session/vault/vault-lock";
import { registerImportUploadFraming } from "../imports/import-session/vault/vault-framing";
import {
  bootRecoveryApp,
  RECOVERY_ORIGIN,
  UI_HEADERS,
  type RecoveryApp,
  type Reply,
} from "./import-session-recovery-harness";
import {
  FIXED_NOW,
  type ImportWorld,
  type WorldUser,
} from "./import-session-harness";

export { RECOVERY_ORIGIN, UI_HEADERS };
export type { RecoveryApp, Reply };

export const CANONICAL_VAULT = "canonical";
type DatabaseEvidence = {
  expected: string;
  directory: string;
  safe: boolean;
};
const databaseEvidence = new WeakMap<PrismaClient, DatabaseEvidence>();

export class VaultFixtureDatabaseError extends Error {}

async function databaseFileGate(
  evidence: DatabaseEvidence,
  directory: string,
  phase: string,
): Promise<void> {
  evidence.safe = false;
  const args = ["-nP", "-a", "-p", String(process.pid), "-F0pftn"];
  const capture = spawnSync("lsof", args, {
    encoding: "utf8",
    timeout: 2500,
  });
  const allowed = [
    evidence.expected,
    `${evidence.expected}-journal`,
    `${evidence.expected}-wal`,
    `${evidence.expected}-shm`,
  ];
  const records: { fd: string; type?: string; path?: string }[] = [];
  let failure: string | undefined;
  const observed: string[] = [];
  try {
    if (
      capture.status !== 0 ||
      capture.error ||
      typeof capture.stdout !== "string" ||
      capture.stderr !== ""
    )
      throw new Error("database lsof capture unavailable");
    let pidSeen = false;
    for (const raw of capture.stdout.split("\0")) {
      const field = raw.replace(/^\n/, "");
      if (!field) continue;
      const value = field.slice(1);
      if (field[0] === "p") {
        if (pidSeen || value !== String(process.pid))
          throw new Error("ambiguous lsof process");
        pidSeen = true;
      } else if (field[0] === "f") {
        if (!pidSeen || !value) throw new Error("ambiguous lsof descriptor");
        records.push({ fd: value });
      } else if (field[0] === "t" || field[0] === "n") {
        const record = records[records.length - 1];
        if (!record) throw new Error("lsof field without descriptor");
        const key = field[0] === "t" ? "type" : "path";
        if (record[key] !== undefined)
          throw new Error("duplicate lsof descriptor field");
        record[key] = value;
      } else throw new Error("unrecognized lsof field");
    }
    if (!pidSeen) throw new Error("missing lsof process");
    for (const record of records) {
      if (!record.type) throw new Error("descriptor without a type");
      if (
        record.path &&
        /\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?(?: \(deleted\))?$/i.test(
          record.path,
        ) &&
        record.type !== "REG"
      )
        throw new Error("ambiguous database descriptor");
      if (record.type !== "REG") continue;
      if (!record.path) throw new Error("descriptor without a path");
      if (
        !/\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?(?: \(deleted\))?$/i.test(
          record.path,
        )
      )
        continue;
      if (!isAbsolute(record.path))
        throw new Error("ambiguous database descriptor");
      const canonical = realpathSync(record.path);
      observed.push(canonical);
      if (!allowed.includes(canonical))
        throw new Error("unexpected open database file");
    }
    if (!observed.includes(evidence.expected))
      throw new Error("expected database is not demonstrably open");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const diagnostic = join(directory, `${phase}-db-files.json`);
  await fsp.writeFile(
    diagnostic,
    JSON.stringify({
      command: "lsof",
      args,
      pid: process.pid,
      phase,
      status: capture.status,
      signal: capture.signal,
      error: capture.error?.message,
      stdout: capture.stdout,
      stderr: capture.stderr,
      allowed,
      observed,
      connectionEvidence: evidence.directory,
      failure: failure ?? null,
    }),
    { flag: "wx", mode: 0o600 },
  );
  if (failure)
    throw new VaultFixtureDatabaseError(`${failure}; evidence: ${diagnostic}`);
  evidence.safe = true;
}

export function vaultTestDatabaseIsSafe(setup: PrismaClient): boolean {
  return databaseEvidence.get(setup)?.safe === true;
}

export async function connectVaultTestDatabase(
  setup: PrismaClient,
): Promise<string> {
  const guard: {
    REPO_ROOT: string;
    applyTestDatabaseUrl(): string;
  } = require("../../../../scripts/test-db-env.cjs");
  const url = guard.applyTestDatabaseUrl();
  const root =
    process.env.VAULT_ATTACHMENT_TEST_EVIDENCE_DIR ??
    join(guard.REPO_ROOT, ".agents/attachment-http-evidence");
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fsp.mkdtemp(join(root, "database-"));
  const evidence = {
    expected: realpathSync(url.slice("file:".length)),
    directory,
    safe: false,
  };
  databaseEvidence.set(setup, evidence);
  try {
    await setup.$connect();
    await databaseFileGate(evidence, directory, "connected-before-seed");
    return directory;
  } catch (error) {
    try {
      await setup.$disconnect();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Vault database connection and cleanup failed",
      );
    }
    throw error;
  }
}

export async function createVaultTestDatabase() {
  const guard: {
    REPO_ROOT: string;
    TEST_DB_PATH: string;
    applyTestDatabaseUrl(): string;
  } = require("../../../../scripts/test-db-env.cjs");
  const scratch = join(guard.REPO_ROOT, ".agents/attachment-qa");
  await fsp.mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await fsp.mkdtemp(join(scratch, "isolated-db-"));
  const file = join(directory, "test.db");
  await fsp.copyFile(guard.TEST_DB_PATH, file);
  await fsp.chmod(file, 0o600);
  const previous = process.env.TEST_DATABASE_URL;
  let setup: PrismaService | undefined;
  const close = () =>
    finishVaultFixture(
      () => setup?.$disconnect(),
      () => {
        if (previous === undefined) delete process.env.TEST_DATABASE_URL;
        else process.env.TEST_DATABASE_URL = previous;
        guard.applyTestDatabaseUrl();
      },
    );
  try {
    process.env.TEST_DATABASE_URL = `file:${file}`;
    guard.applyTestDatabaseUrl();
    setup = new PrismaService();
    const connectionEvidence = await connectVaultTestDatabase(setup);
    return { setup, file, directory, connectionEvidence, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Isolated vault database setup and cleanup failed",
      );
    }
    throw error;
  }
}

export type VaultShutdownResult = "DRAINED" | "TIMEOUT" | "UNCONFIGURED";
export interface LifecycleBoot extends VaultBootHandle {
  readonly stopped: AbortSignal;
  readonly drainTimeoutMs: number | null;
  revoke(reason: "LOCK_REPLACED" | "SHUTDOWN"): void;
  recheckLock(): Promise<
    | Readonly<{ ok: true; runtime: Readonly<VaultRuntime> }>
    | Readonly<{ ok: false }>
  >;
}
export interface LifecycleRegistry extends VaultFdRegistry {
  shutdown(timeoutMs: number | null): Promise<VaultShutdownResult>;
}
export interface GateContract {
  readonly boot: LifecycleBoot;
  readonly registry: LifecycleRegistry;
  readonly storage: VaultStorage;
  requirePurger(): PurgeCoordinator;
  shutdown(): Promise<VaultShutdownResult>;
  onModuleDestroy(): Promise<void>;
}
interface GateExports {
  IMPORT_VAULT_GATE: symbol;
  createImportVaultGate(
    prisma: PrismaService,
    clock: ImportSessionClock,
    env: NodeJS.ProcessEnv,
    cwd: string,
  ): GateContract;
}
function assertGateExports(value: unknown): asserts value is GateExports {
  expect(value).toEqual(
    expect.objectContaining({
      IMPORT_VAULT_GATE: expect.any(Symbol),
      ImportVaultGate: expect.any(Function),
      createImportVaultGate: expect.any(Function),
    }),
  );
}

export function loadVaultGate(): GateExports {
  const file = join(
    __dirname,
    "../imports/import-session/vault/vault-state.ts",
  );
  expect({
    missingExportModule: existsSync(file) ? null : "vault-state.ts",
  }).toEqual({ missingExportModule: null });
  const value: unknown = require(file);
  assertGateExports(value);
  expect(typeof value.IMPORT_VAULT_GATE).toBe("symbol");
  expect(typeof value.createImportVaultGate).toBe("function");
  return value;
}

export function assertLifecycleBoot(
  boot: VaultBootHandle,
): asserts boot is LifecycleBoot {
  expect(boot).toHaveProperty("stopped", expect.any(AbortSignal));
  expect(boot).toHaveProperty("revoke", expect.any(Function));
  expect(boot).toHaveProperty("recheckLock", expect.any(Function));
  expect(boot).toHaveProperty("drainTimeoutMs");
}

export function assertLifecycleRegistry(
  registry: VaultFdRegistry,
): asserts registry is LifecycleRegistry {
  expect(registry).toHaveProperty("shutdown", expect.any(Function));
}

type FixtureOffReason =
  | "FLAG_OFF"
  | "NO_LOCK_FD"
  | "FD_NOT_LOCKFILE"
  | "LOCK_NOT_OWNED"
  | "NO_FDINFO"
  | "BAD_ROOT"
  | "LOCK_REPLACED"
  | "FSYNC_CHECK_FAILED"
  | "HEADROOM_UNSET"
  | "IDLE_TIMEOUT_UNSET";
const liveProofs = new Map<number, { denial?: lockProof.LockProofReason }>();
let proofSpy: jest.SpyInstance | undefined;
const nativeDecision = lockProof.decideLockProof;
const knownListeners = new Set<number>();
const registeredGates = new WeakMap<INestApplication, GateContract>();
const liveHttpStrategies = new Map<INestApplication, JwtStrategy>();

function releaseHttpStrategy(app: INestApplication | undefined) {
  if (app) liveHttpStrategies.delete(app);
  const parent = [...liveHttpStrategies.values()].pop();
  // Passport's registry is process-wide, even when Nest apps have separate clients.
  if (parent) passport.use("jwt", parent);
  else passport.unuse("jwt");
}

export async function finishVaultFixture(...steps: Array<() => unknown>) {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Vault fixture cleanup failed");
}

export async function canonicalVaultFixture(
  root?: string,
  drainTimeoutMs = 37,
) {
  const guard: {
    REPO_ROOT: string;
  } = require("../../../../scripts/test-db-env.cjs");
  const scratch = join(guard.REPO_ROOT, ".agents/attachment-qa");
  await fsp.mkdir(scratch, { recursive: true, mode: 0o700 });
  const dir = await fsp.mkdtemp(join(scratch, "canonical-"));
  const vault = root ?? join(dir, "vault");
  await fsp.mkdir(vault, { recursive: true, mode: 0o700 });
  await fsp.chmod(vault, 0o700);
  for (const child of ["t", "trash"])
    await fsp.mkdir(join(vault, child), { recursive: true, mode: 0o700 });
  const lockPath = join(vault, ".lock");
  if (!existsSync(lockPath))
    await fsp.writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
  const borrowed = await fsp.open(lockPath, constants.O_RDONLY);
  const borrowedFd = borrowed.fd;
  const gates: GateContract[] = [];
  let syncSpy: jest.SpyInstance | undefined;
  const close = () =>
    finishVaultFixture(
      ...gates.map((gate) => () => gate.shutdown()),
      () => expect(borrowed.fd).not.toBe(-1),
      () => syncSpy?.mockRestore(),
      () => liveProofs.delete(borrowedFd),
      () => borrowed.close(),
      () => {
        if (liveProofs.size === 0) {
          try {
            proofSpy?.mockRestore();
          } finally {
            proofSpy = undefined;
          }
        }
      },
    );
  try {
    const identity = await borrowed.stat({ bigint: true });
    const proof: { denial?: lockProof.LockProofReason } = {};
    liveProofs.set(borrowed.fd, proof);
    if (!proofSpy)
      proofSpy = jest
        .spyOn(lockProof, "decideLockProof")
        .mockImplementation((facts) => {
          const entry =
            facts.lockFd === null ? undefined : liveProofs.get(facts.lockFd);
          if (!entry) return nativeDecision(facts);
          expect(facts.fd.kind).toBe("file");
          expect(facts.path.kind).toBe("file");
          return entry.denial
            ? { ok: false, reason: entry.denial }
            : { ok: true };
        });
    const env: NodeJS.ProcessEnv = {
      IMPORT_VAULT_ENABLED: "true",
      IMPORT_VAULT_LOCK_FD: String(borrowed.fd),
      VAULT_DIR: vault,
      IMPORT_VAULT_IDLE_TIMEOUT_MS: "2000",
      IMPORT_VAULT_HEADROOM_BYTES: "1",
      // Explicit fixture budget, not an approved production value.
      IMPORT_VAULT_DRAIN_TIMEOUT_MS: String(drainTimeoutMs),
      UPLOADS_DIR: join(dir, "public"),
      PRIVATE_UPLOADS_DIR: join(dir, "private"),
    };
    return {
      dir,
      root: vault,
      env,
      borrowed,
      identity,
      proof,
      roots: resolveUploadsRoots(env, dir),
      startBoot: () => startVaultBoot(env, resolveUploadsRoots(env, dir)),
      createGate(prisma: PrismaService, clock: ImportSessionClock) {
        const gate = loadVaultGate().createImportVaultGate(
          prisma,
          clock,
          env,
          dir,
        );
        gates.push(gate);
        return gate;
      },
      arrangeOff(reason: FixtureOffReason) {
        switch (reason) {
          case "FLAG_OFF":
            env.IMPORT_VAULT_ENABLED = "false";
            break;
          case "NO_LOCK_FD":
            delete env.IMPORT_VAULT_LOCK_FD;
            break;
          case "BAD_ROOT":
            env.VAULT_DIR = "not-absolute";
            break;
          case "HEADROOM_UNSET":
            delete env.IMPORT_VAULT_HEADROOM_BYTES;
            break;
          case "IDLE_TIMEOUT_UNSET":
            delete env.IMPORT_VAULT_IDLE_TIMEOUT_MS;
            break;
          case "FD_NOT_LOCKFILE":
          case "LOCK_NOT_OWNED":
          case "NO_FDINFO":
            proof.denial = reason;
            break;
          case "LOCK_REPLACED":
            break;
          case "FSYNC_CHECK_FAILED": {
            const open = fsp.open.bind(fsp);
            syncSpy = jest
              .spyOn(fsp, "open")
              .mockImplementation(
                async (...args: Parameters<typeof fsp.open>) => {
                  const handle = await open(...args);
                  if (String(args[0]) === join(vault, "t"))
                    jest.spyOn(handle, "sync").mockRejectedValue(
                      Object.assign(new Error("fixture sync failure"), {
                        code: "EIO",
                      }),
                    );
                  return handle;
                },
              );
          }
        }
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Vault fixture setup failed",
      );
    }
    throw error;
  }
}

export interface VaultBoot {
  writes?: boolean;
  /** `"real"` installs NO override: the shipped default (config absent) must be OFF. */
  vault?: typeof CANONICAL_VAULT | "real" | { offReason: FixtureOffReason };
  /** Additional real graph dependencies, never a substitute vault authority. */
  overrides?: ReadonlyArray<{ token: string | symbol; value: unknown }>;
  /** Mirrors main.ts: CORS and the real framing registrar both precede listen. */
  framing?: boolean;
  /**
   * Vault root through the REAL configuration (`VAULT_DIR`, as the SRE provisions it). Set for the
   * life of the app and restored on close; the tests never inject a storage provider.
   */
  vaultDir?: string;
  fixture?: Awaited<ReturnType<typeof canonicalVaultFixture>>;
  settleBoot?: boolean;
  beforeListen?: (app: INestApplication) => void | Promise<void>;
}

/** Realpath of a fresh temp dir: what the writer sees whether or not it resolves symlinks. */
export const canonicalDir = (dir: string) => realpathSync(dir);

export async function bootVaultApp(
  setup: PrismaClient,
  boot: VaultBoot = {},
): Promise<RecoveryApp> {
  const guard: {
    REPO_ROOT: string;
    applyTestDatabaseUrl(): string;
  } = require("../../../../scripts/test-db-env.cjs");
  guard.applyTestDatabaseUrl();
  const evidence =
    process.env.VAULT_ATTACHMENT_TEST_EVIDENCE_DIR ??
    join(guard.REPO_ROOT, ".agents/attachment-http-evidence");
  await fsp.mkdir(evidence, { recursive: true, mode: 0o700 });
  const attempt = await fsp.mkdtemp(join(evidence, "http-"));
  const connection = databaseEvidence.get(setup);
  let fixture = boot.fixture;
  const previous = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined) => {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const restoreEnv = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const capture = async (label: string) => {
    if (!connection?.safe)
      throw new VaultFixtureDatabaseError("unsafe database: capture refused");
    const database = connection.expected;
    await setup.$disconnect();
    try {
      await fsp.copyFile(database, join(attempt, `${label}.db`));
      await fsp.chmod(join(attempt, `${label}.db`), 0o600);
      const root = fixture?.root ?? boot.vaultDir;
      if (root && existsSync(root))
        cpSync(root, join(attempt, `${label}-vault`), {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
        });
    } finally {
      await setup.$connect();
    }
  };
  let booted: RecoveryApp;
  let initializingApp: INestApplication | undefined;
  try {
    if (!connection?.safe)
      throw new VaultFixtureDatabaseError(
        "missing pre-seed database-file evidence",
      );
    const module =
      (boot.vault ?? "real") === "real" ? undefined : loadVaultGate();
    if (module) {
      fixture ??= await canonicalVaultFixture(boot.vaultDir);
      if (typeof boot.vault === "object")
        fixture.arrangeOff(boot.vault.offReason);
      for (const key of new Set([
        ...Object.keys(fixture.env),
        "IMPORT_VAULT_LOCK_FD",
        "IMPORT_VAULT_HEADROOM_BYTES",
        "IMPORT_VAULT_IDLE_TIMEOUT_MS",
      ]))
        setEnv(key, fixture.env[key]);
    } else {
      for (const key of [
        "IMPORT_VAULT_ENABLED",
        "IMPORT_VAULT_LOCK_FD",
        "VAULT_DIR",
        "IMPORT_VAULT_IDLE_TIMEOUT_MS",
        "IMPORT_VAULT_HEADROOM_BYTES",
        "IMPORT_VAULT_DRAIN_TIMEOUT_MS",
      ])
        setEnv(key, undefined);
    }
    booted = await bootRecoveryApp(setup, {
      writesEnabled: boot.writes ?? true,
      overrides: boot.overrides,
      beforeListen: async (app) => {
        initializingApp = app;
        liveHttpStrategies.set(app, app.get(JwtStrategy));
        connection.safe = false;
        if (boot.framing) {
          app.enableCors({ origin: [RECOVERY_ORIGIN], credentials: true });
          registerImportUploadFraming(app);
        }
        await app.init();
        await databaseFileGate(
          connection,
          attempt,
          "initialized-before-listen",
        );
        const args = [
          "-nP",
          "-a",
          "-p",
          String(process.pid),
          "-iTCP",
          "-sTCP:LISTEN",
          "-Fpn",
        ];
        const check = spawnSync("lsof", args, { encoding: "utf8" });
        await fsp.writeFile(
          join(attempt, "lsof.json"),
          JSON.stringify({
            command: "lsof",
            args,
            status: check.status,
            stdout: check.stdout,
            stderr: check.stderr,
          }),
          { mode: 0o600 },
        );
        expect([0, 1]).toContain(check.status);
        for (const entry of check.stdout
          .split("\n")
          .filter((line) => line.startsWith("n"))) {
          const port = Number(entry.slice(entry.lastIndexOf(":") + 1));
          expect(knownListeners.has(port)).toBe(true);
        }
        if (module) {
          const gate = app.get<GateContract>(module.IMPORT_VAULT_GATE, {
            strict: false,
          });
          registeredGates.set(app, gate);
          if (boot.settleBoot !== false) {
            await gate.boot.settled;
            if (
              typeof boot.vault === "object" &&
              boot.vault.offReason === "LOCK_REPLACED"
            )
              gate.boot.revoke("LOCK_REPLACED");
            if (typeof boot.vault === "object") {
              expect(gate.boot.state()).toBe("OFF");
              expect(gate.boot.reason).toBe(boot.vault.offReason);
            } else {
              expect(gate.boot.state()).toBe("ON");
              expect(gate.boot.runtime()?.config.rootDir).toBe(fixture!.root);
              expect(gate.boot.runtime()?.lockIdentity).toEqual({
                dev: fixture!.identity.dev,
                ino: fixture!.identity.ino,
              });
            }
          }
        }
        await boot.beforeListen?.(app);
      },
    });
  } catch (error) {
    try {
      await finishVaultFixture(
        async () => {
          await initializingApp?.close();
          if (connection?.safe) await capture("failed-boot");
        },
        () => fixture?.close(),
        restoreEnv,
        () => releaseHttpStrategy(initializingApp),
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Vault HTTP fixture setup failed",
      );
    }
    throw error;
  }
  const port = (booted.app.getHttpServer().address() as AddressInfo).port;
  knownListeners.add(port);
  const close = booted.close;
  return {
    ...booted,
    close: async () => {
      await finishVaultFixture(
        async () => {
          await close();
          await capture("closed");
        },
        () => knownListeners.delete(port),
        () => fixture?.close(),
        restoreEnv,
        () => releaseHttpStrategy(booted.app),
      );
    },
  };
}

/**
 * Observes the REAL filesystem calls of the writer: wraps `fs.promises.open` (the writer must call
 * it by property, which ts-jest CJS output does for both `fsp.open` and a named import) for paths
 * under `<root>/t/<refId>/`, and hands the test the real FileHandle to decorate (e.g. hold its
 * `close`). Scoped to a test: the caller restores it. No production SPI, no production pause.
 */
export function spyVaultOpen(
  root: string,
  onOpen: (refId: string, handle: FileHandle) => void,
): jest.SpyInstance {
  const original = fsp.open.bind(fsp);
  const prefix = `${join(root, "t")}/`;
  return jest.spyOn(fsp, "open").mockImplementation((async (
    ...args: Parameters<typeof fsp.open>
  ) => {
    const handle = await original(...args);
    const path = String(args[0]);
    if (path.startsWith(prefix)) {
      const refId = path.slice(prefix.length).split("/")[0]!;
      onOpen(refId, handle);
    }
    return handle;
  }) as typeof fsp.open);
}

/** Every path under `root` (sorted, relative): the "no filesystem effect" oracle. */
export async function treeOf(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(path);
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
    }
  };
  await walk(root, "");
  return out.sort();
}

/** The bytes that really sit on disk for a retained artifact (`root/<storage_key>`). */
export async function readStoredBlob(root: string, storageKey: string) {
  expect(storageKey).not.toMatch(/(^|\/)\.\.(\/|$)|^\//);
  return fsp.readFile(join(root, storageKey));
}

/** Permission bits of the stored blob (the design pins 0600). */
export async function storedMode(root: string, storageKey: string) {
  return (await fsp.stat(join(root, storageKey))).mode & 0o777;
}

/** True only when production really registered the token: an ignored override proves nothing. */
export function getVaultGate(api: RecoveryApp): GateContract {
  return api.app.get<GateContract>(loadVaultGate().IMPORT_VAULT_GATE, {
    strict: false,
  });
}
export function seamHonored(api: RecoveryApp) {
  const gate = getVaultGate(api);
  return registeredGates.get(api.app) === gate && gate.boot.runtime() !== null;
}

export const MIB = 1024 * 1024;
export const FIFTY_MIB = 50 * MIB;
export const TEN_MIB = 10 * MIB;

/**
 * A structurally valid single-page PDF of EXACTLY `size` bytes (>= 400): header, one padding
 * comment carrying `salt` (distinct salt => distinct sha256), three objects, a correct xref table
 * and trailer. Full PDF parsing is B2b; this passes magic sniff and any tail/xref inspection.
 */
export function pdfBytes(size: number, salt: string = randomUUID()): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
  ];
  const head = "%PDF-1.4\n";
  const tail = (offsets: number[], xrefAt: number) =>
    `xref\n0 4\n0000000000 65535 f \n${offsets
      .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
      .join(
        "",
      )}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const fixed =
    head.length + objects.join("").length + tail([0, 0, 0], 0).length;
  // The startxref digits vary with the padding; size the comment against the real result.
  for (let pad = Math.max(size - fixed - 8, 3); pad <= size; pad++) {
    const comment = `%${salt}`.padEnd(pad - 1, "x").slice(0, pad - 1) + "\n";
    let at = head.length + comment.length;
    const offsets = objects.map((o) => {
      const here = at;
      at += o.length;
      return here;
    });
    const text = head + comment + objects.join("") + tail(offsets, at);
    if (text.length === size) return Buffer.from(text, "latin1");
    if (text.length > size) break;
  }
  throw new Error(`pdfBytes: cannot build ${size} bytes`);
}
export const sha256Hex = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");

/** Raw TCP request text: the only way to send framing Node's HTTP client refuses to produce. */
export function rawSocket(
  api: RecoveryApp,
  requestText: string,
  options: { keepSending?: () => Buffer | null; closeWithinMs?: number } = {},
): Promise<{ status: number; text: string; closedByServer: boolean }> {
  const port = (api.app.getHttpServer().address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const received: Buffer[] = [];
    let closed = false;
    const deadline = setTimeout(() => {
      socket.destroy();
      finish();
    }, options.closeWithinMs ?? 4000);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearInterval(pump);
      const text = Buffer.concat(received).toString("utf8");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(text);
      resolve({
        status: match ? Number(match[1]) : 0,
        text,
        closedByServer: closed,
      });
    };
    const pump = setInterval(() => {
      const chunk = options.keepSending?.();
      if (chunk && !socket.destroyed) socket.write(chunk);
    }, 40);
    socket.on("data", (d) => received.push(d));
    socket.on("close", () => {
      closed = true;
      finish();
    });
    socket.on("error", (error) => {
      if (!finished && received.length === 0) {
        finished = true;
        clearTimeout(deadline);
        clearInterval(pump);
        reject(error);
      }
    });
    socket.write(requestText);
    if (!options.keepSending) setTimeout(() => socket.end(), 300);
  });
}

export interface RawOptions {
  token?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

/** Raw HTTP (no automatic JSON): needed for octet-stream PUTs and hostile framing. */
export type RawReply = Reply & { headers: http.IncomingHttpHeaders };

export function rawCall(
  api: RecoveryApp,
  method: string,
  path: string,
  options: RawOptions = {},
): Promise<RawReply> {
  const port = (api.app.getHttpServer().address() as AddressInfo).port;
  return new Promise<RawReply>((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers["authorization"] = `Bearer ${options.token}`;
    let settled = false;
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        const done = () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({
            status: res.statusCode ?? 0,
            text,
            json,
            headers: res.headers,
          });
        };
        res.on("end", done);
        // A rejection answered before the body was read may be followed by a reset.
        res.on("error", done);
        res.on("close", done);
      },
    );
    // Only a failure with NO response is an error; a reset after the answer is expected.
    req.on("error", (error) => {
      if (!settled && !req.destroyed) reject(error);
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export const reservePath = (sessionId: string) =>
  `/import-sessions/${sessionId}/attachments`;
export const contentPath = (sessionId: string, attachmentId: string) =>
  `/import-sessions/${sessionId}/attachments/${attachmentId}/content`;

export interface FileSeed {
  id: string;
  fileName: string;
  declaredBytes: number;
  mime: string;
}

export function fileSeed(overrides: Partial<FileSeed> = {}): FileSeed {
  return {
    id: randomUUID(),
    fileName: "fatura.pdf",
    declaredBytes: 1000,
    mime: "application/pdf",
    ...overrides,
  };
}

export function reserve(
  api: RecoveryApp,
  token: string,
  sessionId: string,
  files: unknown,
  options: {
    expectedRevision?: number;
    headers?: Record<string, string>;
    query?: string;
    body?: unknown;
  } = {},
): Promise<Reply> {
  return api.call("POST", `${reservePath(sessionId)}${options.query ?? ""}`, {
    token,
    headers: options.headers ?? UI_HEADERS,
    body: options.body ?? {
      expectedRevision: options.expectedRevision ?? 1,
      files,
    },
  });
}

export interface PutOptions {
  token?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  /** Skips the default octet-stream framing headers. */
  bareHeaders?: Record<string, string>;
  query?: string;
}

/** PUT of raw bytes with correct framing unless the caller overrides individual headers. */
export function putContent(
  api: RecoveryApp,
  sessionId: string,
  attachmentId: string,
  options: PutOptions = {},
): Promise<Reply> {
  const body = options.body ?? pdfBytes(1000);
  const headers: Record<string, string> = options.bareHeaders ?? {
    ...UI_HEADERS,
    "content-type": "application/octet-stream",
    "content-length": String(body.length),
    ...(options.headers ?? {}),
  };
  return rawCall(
    api,
    "PUT",
    `${contentPath(sessionId, attachmentId)}${options.query ?? ""}`,
    { token: options.token, headers, body },
  );
}

export function getContent(
  api: RecoveryApp,
  token: string | undefined,
  sessionId: string,
  attachmentId: string,
  query = "",
): Promise<RawReply> {
  return rawCall(
    api,
    "GET",
    `${contentPath(sessionId, attachmentId)}${query}`,
    { token },
  );
}

/** The exact wire of `ImportSessionErrorV1`: nothing else may ever cross the boundary. */
export function wireError(
  code: string,
  extra: {
    retryable?: boolean;
    sessionId?: string | null;
    currentRevision?: number | null;
    reason?: string | null;
  } = {},
) {
  return {
    code,
    retryable: extra.retryable ?? false,
    sessionId: extra.sessionId ?? null,
    currentRevision: extra.currentRevision ?? null,
    reason: extra.reason ?? null,
  };
}

export const RETRYABLE_ERRORS = new Set([
  "RETRYABLE_WRITE_CONFLICT",
  "CAPABILITY_DISABLED",
]);

export const wire = (
  code: string,
  extra: Parameters<typeof wireError>[1] = {},
) => wireError(code, { retryable: RETRYABLE_ERRORS.has(code), ...extra });

// -- seeding ----------------------------------------------------------------------------

export interface RefSeed {
  id?: string;
  position?: number;
  state?: string;
  fileName?: string;
  declaredBytes?: number;
  generation?: number;
  reservedBytes?: number;
  temporaryStorageKey?: string | null;
  temporaryPurgePending?: boolean;
  artifactId?: string | null;
  verifiedAt?: Date | null;
  releasedAt?: Date | null;
  sessionVersion?: number;
  tokenExpiresAt?: Date | null;
  leaseExpiresAt?: Date | null;
  updatedAt?: Date;
}

export const SECOND = 1000;
export const inSeconds = (seconds: number, from: Date = FIXED_NOW) =>
  new Date(from.getTime() + seconds * SECOND);

/** A RESERVED (claimable, generation 1) ref unless overridden; lease/token in the future. */
export async function seedRef(
  setup: PrismaClient,
  session: { id: string; tenantId: string; ownerProjectId: string },
  owner: WorldUser,
  seed: RefSeed = {},
) {
  const id = seed.id ?? randomUUID();
  const declaredBytes = seed.declaredBytes ?? 1000;
  const state = seed.state ?? "RESERVED";
  const reserved = state === "RESERVED";
  const data: Prisma.ImportSessionArtifactUncheckedCreateInput = {
    id,
    tenantId: session.tenantId,
    ownerProjectId: session.ownerProjectId,
    sessionId: session.id,
    artifactId: seed.artifactId ?? null,
    position: seed.position ?? 0,
    fileName: seed.fileName ?? "fatura.pdf",
    declaredMime: "application/pdf",
    declaredBytes,
    state,
    temporaryStorageKey:
      seed.temporaryStorageKey === undefined
        ? reserved
          ? `t/${id}`
          : null
        : seed.temporaryStorageKey,
    reservedBytes: seed.reservedBytes ?? (reserved ? declaredBytes : 0),
    uploadGeneration: seed.generation ?? (reserved ? 1 : 0),
    uploadSessionVersion: seed.sessionVersion ?? owner.sessionVersion,
    uploadTokenExpiresAt:
      seed.tokenExpiresAt === undefined ? inSeconds(3600) : seed.tokenExpiresAt,
    uploadLeaseExpiresAt:
      seed.leaseExpiresAt === undefined
        ? reserved
          ? inSeconds(600)
          : null
        : seed.leaseExpiresAt,
    verifiedAt: seed.verifiedAt ?? null,
    releasedAt: seed.releasedAt ?? null,
    temporaryPurgePending: seed.temporaryPurgePending ?? false,
  };
  if (seed.updatedAt) data.updatedAt = seed.updatedAt;
  await setup.importSessionArtifact.create({ data });
  return id;
}

/** A retained canonical artifact (blob still on disk) for an owner project. */
export async function seedArtifact(
  setup: PrismaClient,
  session: { tenantId: string; ownerProjectId: string },
  seed: { id?: string; verifiedBytes?: number; state?: string } = {},
) {
  const id = seed.id ?? randomUUID();
  const state = seed.state ?? "RAW_READY";
  await setup.importArtifact.create({
    data: {
      id,
      tenantId: session.tenantId,
      ownerProjectId: session.ownerProjectId,
      documentSha256: randomUUID().replace(/-/g, "").padEnd(64, "a"),
      verifiedBytes: seed.verifiedBytes ?? 1000,
      detectedFormat: "PDF",
      state,
      storageKey: state === "PURGED" ? null : `t/${randomUUID()}/g2/blob`,
    },
  });
  return id;
}

/** Deterministic dump of every ref of a session: the zero-effect oracle. */
export async function refsOf(setup: PrismaClient, sessionId: string) {
  return setup.importSessionArtifact.findMany({
    where: { sessionId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
}

export async function sessionDigest(setup: PrismaClient, sessionId: string) {
  const row = await setup.importSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
  return {
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    state: row.state,
    draftJson: row.draftJson,
  };
}

/** Everything a spec needs to prove "nothing happened" for one session. */
export async function fullDigest(setup: PrismaClient, sessionId: string) {
  return {
    session: await sessionDigest(setup, sessionId),
    refs: await refsOf(setup, sessionId),
  };
}

export const bytes = (n: number, fill = 0x25) => Buffer.alloc(n, fill);

export type { ImportWorld, WorldUser };
