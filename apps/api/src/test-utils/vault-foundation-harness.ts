import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  setTimeout as realTimeout,
  clearTimeout as realClear,
} from "node:timers";
import type { ImportArtifact, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { ImportSessionClock } from "../imports/import-session/import-session.capability";
import {
  startVaultBoot,
  type VaultBootHandle,
} from "../imports/import-session/vault/vault-boot";
import * as lockProof from "../imports/import-session/vault/vault-lock";
import type { VaultErrno } from "../imports/import-session/vault/vault-durability";
import {
  connectVaultTestDatabase,
  spyVaultOpen,
  treeOf,
} from "./import-session-vault-harness";

// Temporary declaration-only boundary, copied from the mediated corrigendum.
// Replace loaders with direct imports at the immutable GREEN checkpoint, not before.
export type VaultKey = `R:${string}` | `A:${string}`;
export type VaultFdOwner = Readonly<{
  tenantId: string;
  ownerProjectId: string;
  ownerUserId: string;
}>;
export type VaultFdLease = Readonly<{
  signal: AbortSignal;
  done: Promise<void>;
  exit(): void;
}>;
export type VaultAdmission =
  | Readonly<{ ok: true; lease: VaultFdLease }>
  | Readonly<{ ok: false; reason: "FENCED" }>;
export interface Registry {
  enter(key: VaultKey, owner: VaultFdOwner): VaultAdmission;
  fence(key: VaultKey): void;
  abortAndDrain(
    key: VaultKey,
    timeoutMs: number,
  ): Promise<"DRAINED" | "TIMEOUT">;
  releaseFence(key: VaultKey): void;
  snapshotUploads(): readonly (VaultFdOwner & { refId: string })[];
}
export type VaultDeclaredMime =
  | "application/pdf"
  | "text/csv"
  | "text/plain"
  | "application/vnd.ms-excel"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/x-ofx"
  | "application/vnd.ofx"
  | "image/png"
  | "image/jpeg"
  | "image/webp";
export type VaultUploadClaim = Readonly<
  VaultFdOwner & {
    sessionId: string;
    refId: string;
    uploadGeneration: 2;
    temporaryStorageKey: string;
    declaredBytes: number;
    declaredMime: VaultDeclaredMime;
    uploadSessionVersion: number;
    tokenExpiresAtMs: number;
    uploadTokenExpiresAtMs: number;
    uploadLeaseExpiresAtMs: number;
    sessionExpiresAtMs: number;
    claimedAtMs: number;
    claimedAtMonotonicMs: number;
  }
>;
export type VaultArtifactRead = Readonly<
  VaultFdOwner & {
    sessionId: string;
    refId: string;
    artifactId: string;
    storageKey: string;
  }
>;
export type StoredVaultUpload = Readonly<{
  storageKey: string;
  documentSha256: string;
  verifiedBytes: number;
  detectedFormat: ImportArtifact["detectedFormat"];
}>;
export type CapturedVaultPurge = Readonly<
  {
    tenantId: string;
    ownerProjectId: string;
    id: string;
    sourceKey: string;
    trashKey: string;
  } & (
    | { kind: "ref"; key: `R:${string}`; temporaryStorageKey: string }
    | { kind: "artifact"; key: `A:${string}`; storageKey: string }
  )
>;
export type VaultIoErrorKind =
  | "UNAVAILABLE"
  | "FENCED"
  | "INVALID_CAPTURE"
  | "ANOMALY"
  | "FS_ERROR"
  | "STREAM_ERROR"
  | "SIZE_MISMATCH"
  | "UNSUPPORTED_DOCUMENT"
  | "DEADLINE_EXCEEDED"
  | "IDLE_TIMEOUT"
  | "HEADROOM_INSUFFICIENT";
export type VaultIoStep =
  | "runtime"
  | "capture"
  | "recheck"
  | "headroom"
  | "mkdir"
  | "open"
  | "stream"
  | "sync-file"
  | "close-file"
  | "sync-directory"
  | "close-directory"
  | "lstat-source"
  | "lstat-trash"
  | "rename"
  | "remove-trash"
  | "remove-owner"
  | "absence-proof";
export interface Storage {
  writeClaim(
    claim: VaultUploadClaim,
    source: Readable,
    recheck: (claim: VaultUploadClaim) => Promise<void>,
  ): Promise<StoredVaultUpload>;
  withArtifactReader<T>(
    capture: VaultArtifactRead,
    recheck: (capture: VaultArtifactRead) => Promise<void>,
    consume: (source: Readable) => Promise<T>,
  ): Promise<T>;
  eraseCaptured(capture: CapturedVaultPurge): Promise<void>;
}
export type VaultPurgeTarget = Readonly<{
  kind: "ref" | "artifact";
  tenantId: string;
  ownerProjectId: string;
  id: string;
}>;
export type VaultPurgeResult =
  | "PURGED"
  | "NOT_ELIGIBLE"
  | "STALE_CAPTURE"
  | "DRAIN_TIMEOUT";
export interface Purger {
  purge(target: VaultPurgeTarget): Promise<VaultPurgeResult>;
}
type RegistryCtor = new () => Registry;
type StorageCtor = new (
  boot: VaultBootHandle,
  registry: Registry,
  clock: ImportSessionClock,
) => Storage;
type PurgerCtor = new (
  prisma: PrismaService,
  clock: ImportSessionClock,
  boot: VaultBootHandle,
  registry: Registry,
  storage: Storage,
  drainTimeoutMs: number,
) => Purger;
type IoErrorCtor = new (failure: {
  kind: VaultIoErrorKind;
  step: VaultIoStep;
  code?: VaultErrno;
  closeCode?: VaultErrno;
}) => Error & {
  kind: VaultIoErrorKind;
  step: VaultIoStep;
  code?: VaultErrno;
  closeCode?: VaultErrno;
};

function loadExport<T>(module: string, name: string): T {
  const path = join(
    __dirname,
    "../imports/import-session/vault",
    `${module}.ts`,
  );
  expect({ module, export: name, present: existsSync(path) }).toEqual({
    module,
    export: name,
    present: true,
  });
  // No catch: a transitive MODULE_NOT_FOUND is a runtime defect, never absent-export RED.
  const loaded: Record<string, unknown> = require(path);
  expect({ module, export: name, type: typeof loaded[name] }).toEqual({
    module,
    export: name,
    type: "function",
  });
  return loaded[name] as T;
}
export const loadRegistry = () =>
  loadExport<RegistryCtor>("vault-fd-registry", "VaultFdRegistry");
export const loadStorage = () =>
  loadExport<StorageCtor>("vault-storage", "VaultStorage");
export const loadPurger = () =>
  loadExport<PurgerCtor>("vault-purger", "PurgeCoordinator");
export const loadIoError = () =>
  loadExport<IoErrorCtor>("vault-storage", "VaultIoError");
export const NOW = Date.parse("2026-10-07T15:00:00.000Z");
export const REF = "11111111-1111-4111-8111-111111111111";
export const REF2 = "22222222-2222-4222-8222-222222222222";
export const ART = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ART2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const OWNER = {
  tenantId: "qa-vault-t",
  ownerProjectId: "qa-vault-p",
  ownerUserId: "qa-vault-u",
};
export const PDF = Buffer.from(
  "%PDF-1.4\n% deterministic private fixture\n%%EOF\n",
);
export const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const errno = (code: string) =>
  Object.assign(new Error("synthetic private OS failure"), { code });

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export async function bounded<T>(
  promise: Promise<T>,
  label = "instrument barrier",
): Promise<T> {
  let timer: ReturnType<typeof realTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = realTimeout(
          () => reject(new Error(`Unreached ${label}`)),
          2500,
        );
      }),
    ]);
  } finally {
    if (timer) realClear(timer);
  }
}
export function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
export async function rejected(
  promise: Promise<unknown>,
  kind?: VaultIoErrorKind,
) {
  const result = await bounded(outcome(promise));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failure, not success");
  if (kind) expect(result.error).toMatchObject({ kind });
  return result.error;
}
export async function readAll(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export interface IoEvent {
  op: string;
  path: string;
  to?: string;
}
export function observeIo(
  root: string,
  options: {
    afterOpen?: (path: string, handle: FileHandle) => Promise<void>;
    beforeClose?: (path: string, handle: FileHandle) => Promise<void>;
    beforeSync?: (path: string) => Promise<void>;
    afterRename?: (from: string, to: string) => Promise<void>;
    afterRemove?: (path: string) => Promise<void>;
    beforeLstat?: (path: string) => Promise<void>;
  } = {},
) {
  const events: IoEvent[] = [];
  const callbackErrors: { op: string; path: string; error: unknown }[] = [];
  const owned = new Map<
    FileHandle,
    { path: string; originalClose: () => Promise<void>; closed: boolean }
  >();
  const spies: jest.SpyInstance[] = [];
  const inRoot = (path: string) => path === root || path.startsWith(`${root}/`);
  const decorate = (path: string, handle: FileHandle) => {
    if (owned.has(handle)) return;
    const entry = {
      path,
      originalClose: handle.close.bind(handle),
      closed: false,
    };
    owned.set(handle, entry);
    events.push({ op: "open", path });
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      events.push({ op: "sync:start", path });
      try {
        await options.beforeSync?.(path);
      } catch (error) {
        callbackErrors.push({ op: "beforeSync", path, error });
        throw error;
      }
      await sync();
      events.push({ op: "sync:done", path });
    };
    handle.close = async () => {
      events.push({ op: "close:start", path });
      try {
        await options.beforeClose?.(path, handle);
      } catch (error) {
        callbackErrors.push({ op: "beforeClose", path, error });
        throw error;
      }
      await entry.originalClose();
      entry.closed = true;
      events.push({ op: "close:done", path });
    };
  };
  // Reuse exported real-open instrumentation; extend it only for required parent handles
  // and a held completion of the actual open (the old callback cannot await).
  const openSpy = spyVaultOpen(root, () => undefined);
  const realInstrumentedOpen = openSpy.getMockImplementation()!;
  openSpy.mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
    const handle: FileHandle = await realInstrumentedOpen(...args);
    const path = String(args[0]);
    if (inRoot(path)) {
      decorate(path, handle);
      await options.afterOpen?.(path, handle);
    }
    return handle;
  });
  spies.push(openSpy);
  const rename = fsp.rename.bind(fsp);
  spies.push(
    jest.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (inRoot(String(from)))
        events.push({ op: "rename:start", path: String(from), to: String(to) });
      await rename(from, to);
      if (inRoot(String(from))) {
        events.push({ op: "rename:done", path: String(from), to: String(to) });
        await options.afterRename?.(String(from), String(to));
      }
    }),
  );
  const rm = fsp.rm.bind(fsp);
  spies.push(
    jest.spyOn(fsp, "rm").mockImplementation(async (path, opts) => {
      if (inRoot(String(path)))
        events.push({ op: "rm:start", path: String(path) });
      await rm(path, opts);
      if (inRoot(String(path))) {
        events.push({ op: "rm:done", path: String(path) });
        await options.afterRemove?.(String(path));
      }
    }),
  );
  const lstat = fsp.lstat.bind(fsp);
  spies.push(
    jest.spyOn(fsp, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fsp.lstat>
    ) => {
      if (inRoot(String(args[0]))) {
        events.push({ op: "lstat", path: String(args[0]) });
        await options.beforeLstat?.(String(args[0]));
      }
      return lstat(...args);
    }) as typeof fsp.lstat),
  );
  const mkdir = fsp.mkdir.bind(fsp);
  spies.push(
    jest.spyOn(fsp, "mkdir").mockImplementation((async (
      ...args: Parameters<typeof fsp.mkdir>
    ) => {
      if (inRoot(String(args[0])))
        events.push({ op: "mkdir", path: String(args[0]) });
      return mkdir(...args);
    }) as typeof fsp.mkdir),
  );
  const rmdir = fsp.rmdir.bind(fsp);
  spies.push(
    jest.spyOn(fsp, "rmdir").mockImplementation(async (...args) => {
      if (inRoot(String(args[0])))
        events.push({ op: "rmdir", path: String(args[0]) });
      await rmdir(...args);
      if (inRoot(String(args[0])))
        events.push({ op: "rmdir:done", path: String(args[0]) });
    }),
  );
  return {
    events,
    callbackErrors,
    owned,
    restore: () => spies.reverse().forEach((spy) => spy.mockRestore()),
    closeRemaining: async () => {
      for (const [handle, entry] of owned) {
        if (!entry.closed && handle.fd !== -1) {
          await entry.originalClose();
          entry.closed = true;
          events.push({ op: "cleanup:real-close", path: entry.path });
        }
      }
    },
  };
}

// Test-only drain budget; this is not a production/SRE default.
export async function fixture(idleTimeoutMs = 5000, drainTimeoutMs = 37) {
  const guard: {
    REPO_ROOT: string;
    TEST_DB_PATH: string;
    applyTestDatabaseUrl(): string;
  } = require("../../../../scripts/test-db-env.cjs");
  const scratch = join(guard.REPO_ROOT, ".agents/vault-foundation");
  await fsp.mkdir(scratch, { recursive: true, mode: 0o700 });
  const dir = await fsp.mkdtemp(join(scratch, "vault-qa-"));
  await fsp.chmod(dir, 0o700);
  const dbPath = join(dir, "test.db");
  await fsp.copyFile(guard.TEST_DB_PATH, dbPath);
  await fsp.chmod(dbPath, 0o600);
  const previous = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = `file:${dbPath}`;
  guard.applyTestDatabaseUrl();
  const db = new PrismaService();
  try {
    await connectVaultTestDatabase(db);
  } catch (error) {
    if (previous === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previous;
    guard.applyTestDatabaseUrl();
    throw error;
  }
  const root = join(dir, "vault");
  await fsp.mkdir(root, { mode: 0o700 });
  await fsp.mkdir(join(root, "t"), { mode: 0o700 });
  await fsp.mkdir(join(root, "trash"), { mode: 0o700 });
  await fsp.writeFile(join(root, ".lock"), "", { mode: 0o600 });
  const roots = {
    publicDir: join(dir, "public"),
    privateDir: join(dir, "private"),
  };
  const borrowedLock = await fsp.open(join(root, ".lock"), constants.O_RDONLY);
  const identity = await borrowedLock.stat({ bigint: true });
  // Real boot/collector/borrowed FD; only the pure ownership verdict is synthetic.
  // This is not Linux/OFD evidence. The fixture, never production, closes its FD.
  const lock = jest
    .spyOn(lockProof, "decideLockProof")
    .mockImplementation((facts) => {
      expect(facts.lockFd).toBe(borrowedLock.fd);
      expect(facts.fd).toEqual({
        kind: "file",
        dev: identity.dev,
        ino: identity.ino,
      });
      expect(facts.path).toEqual({
        kind: "file",
        dev: identity.dev,
        ino: identity.ino,
      });
      return { ok: true };
    });
  let boot: VaultBootHandle;
  let booted = false;
  try {
    boot = startVaultBoot(
      {
        IMPORT_VAULT_ENABLED: "true",
        IMPORT_VAULT_LOCK_FD: String(borrowedLock.fd),
        VAULT_DIR: root,
        IMPORT_VAULT_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
        IMPORT_VAULT_HEADROOM_BYTES: "1",
        IMPORT_VAULT_DRAIN_TIMEOUT_MS: String(drainTimeoutMs),
      },
      roots,
    );
    await bounded(boot.settled, "canonical boot");
    expect(boot.state()).toBe("ON");
    expect(boot.runtime()?.config.rootDir).toBe(root);
    expect(lock).toHaveBeenCalledTimes(1);
    booted = true;
  } finally {
    lock.mockRestore();
    if (!booted) {
      await borrowedLock.close();
      await db.$disconnect();
    }
  }
  const clock = {
    value: NOW,
    now() {
      return new Date(this.value);
    },
  };
  await db.tenant.createMany({
    data: [
      { id: OWNER.tenantId, name: "Synthetic" },
      { id: "foreign-t", name: "Foreign synthetic" },
    ],
  });
  await db.user.create({
    data: {
      id: OWNER.ownerUserId,
      tenantId: OWNER.tenantId,
      username: "vault-qa",
      name: "Synthetic",
      role: "OWNER",
    },
  });
  await db.project.createMany({
    data: [
      {
        id: OWNER.ownerProjectId,
        tenantId: OWNER.tenantId,
        type: "PESSOAL",
        name: "Synthetic",
      },
      {
        id: "other-p",
        tenantId: OWNER.tenantId,
        type: "PESSOAL",
        name: "Other",
      },
      {
        id: "foreign-p",
        tenantId: "foreign-t",
        type: "PESSOAL",
        name: "Foreign",
      },
    ],
  });
  await db.creditCard.create({
    data: {
      id: "qa-card",
      tenantId: OWNER.tenantId,
      projectId: OWNER.ownerProjectId,
      institution: "ITAU",
      nickname: "Synthetic",
      last4: "0000",
    },
  });
  await db.importSession.create({
    data: {
      id: "qa-session",
      ...OWNER,
      cardId: "qa-card",
      kind: "CREATE_CARD_PURCHASES",
      state: "DRAFT",
      revision: 1,
      createRequestId: REF,
      createPayloadHash: "c".repeat(64),
      consentPolicyVersion: 1,
      consentedAt: new Date(NOW),
      lastUserEditAt: new Date(NOW),
      expiresAt: new Date(NOW + 604800000),
      draftJson:
        '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
    },
  });
  const gates: ReturnType<typeof gate>[] = [];
  const tasks: Promise<unknown>[] = [];
  const observers: ReturnType<typeof observeIo>[] = [];
  const makeGate = () => {
    const g = gate();
    gates.push(g);
    return g;
  };
  const track = <T>(p: Promise<T>) => {
    tasks.push(outcome(p));
    return p;
  };
  const io = (options?: Parameters<typeof observeIo>[1]) => {
    const observer = observeIo(root, options);
    observers.push(observer);
    return observer;
  };
  const locked = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE tenants SET id = id WHERE id = ${OWNER.tenantId}`;
      return work(tx);
    });
  const seedRef = async (
    id = REF,
    extra: Partial<Prisma.ImportSessionArtifactUncheckedCreateInput> = {},
  ) => {
    return db.importSessionArtifact.create({
      data: {
        id,
        tenantId: OWNER.tenantId,
        ownerProjectId: OWNER.ownerProjectId,
        sessionId: "qa-session",
        position: id === REF ? 0 : 1,
        fileName: "fixture.pdf",
        declaredMime: "application/pdf",
        declaredBytes: PDF.length,
        state: "RESERVED",
        temporaryStorageKey: `t/${id}`,
        reservedBytes: PDF.length,
        uploadGeneration: 2,
        uploadSessionVersion: 0,
        uploadTokenExpiresAt: new Date(NOW + 300000),
        uploadLeaseExpiresAt: new Date(NOW + 120000),
        verifiedAt: extra.state === "ATTACHED" ? new Date(NOW) : null,
        ...extra,
      },
    });
  };
  const seedArtifact = async (
    id = ART,
    refId = REF,
    extra: Partial<Prisma.ImportArtifactUncheckedCreateInput> = {},
  ) => {
    return db.importArtifact.create({
      data: {
        id,
        tenantId: OWNER.tenantId,
        ownerProjectId: OWNER.ownerProjectId,
        documentSha256: id === ART ? hash(PDF) : "d".repeat(64),
        verifiedBytes: PDF.length,
        detectedFormat: "PDF",
        state: "RAW_READY",
        storageKey: `t/${refId}/g2/blob`,
        ...extra,
      },
    });
  };
  const writeBlob = async (key = `t/${REF}/g2/blob`, bytes = PDF) => {
    await fsp.mkdir(dirname(join(root, key)), { recursive: true, mode: 0o700 });
    await fsp.writeFile(join(root, key), bytes, { mode: 0o600 });
  };
  const claim = (extra: Partial<VaultUploadClaim> = {}): VaultUploadClaim => ({
    ...OWNER,
    sessionId: "qa-session",
    refId: REF,
    uploadGeneration: 2,
    temporaryStorageKey: `t/${REF}`,
    declaredBytes: PDF.length,
    declaredMime: "application/pdf",
    uploadSessionVersion: 0,
    tokenExpiresAtMs: NOW + 300000,
    uploadTokenExpiresAtMs: NOW + 300000,
    uploadLeaseExpiresAtMs: NOW + 120000,
    sessionExpiresAtMs: NOW + 604800000,
    claimedAtMs: NOW,
    claimedAtMonotonicMs: performance.now(),
    ...extra,
  });
  const recheck = async (c: VaultUploadClaim) =>
    locked(async (tx) => {
      const ref = await tx.importSessionArtifact.findFirst({
        where: {
          tenantId: c.tenantId,
          ownerProjectId: c.ownerProjectId,
          sessionId: c.sessionId,
          id: c.refId,
          state: "RESERVED",
          uploadGeneration: c.uploadGeneration,
          temporaryPurgePending: false,
          temporaryStorageKey: c.temporaryStorageKey,
          uploadSessionVersion: c.uploadSessionVersion,
          uploadLeaseExpiresAt: { gt: clock.now() },
        },
      });
      const session = await tx.importSession.findFirst({
        where: {
          id: c.sessionId,
          tenantId: c.tenantId,
          ownerProjectId: c.ownerProjectId,
          ownerUserId: c.ownerUserId,
          state: { in: ["DRAFT", "NEEDS_INPUT"] },
          expiresAt: { gt: clock.now() },
        },
      });
      if (!ref || !session) throw new Error("TEST_AUTHORITY_FENCED");
    });
  const readCapture = (): VaultArtifactRead => ({
    ...OWNER,
    sessionId: "qa-session",
    refId: REF,
    artifactId: ART,
    storageKey: `t/${REF}/g2/blob`,
  });
  const recheckRead = async (c: VaultArtifactRead) =>
    locked(async (tx) => {
      const ref = await tx.importSessionArtifact.findFirst({
        where: {
          id: c.refId,
          tenantId: c.tenantId,
          ownerProjectId: c.ownerProjectId,
          sessionId: c.sessionId,
          artifactId: c.artifactId,
          state: "ATTACHED",
        },
      });
      const artifact = await tx.importArtifact.findFirst({
        where: {
          id: c.artifactId,
          tenantId: c.tenantId,
          ownerProjectId: c.ownerProjectId,
          storageKey: c.storageKey,
          state: { notIn: ["PURGING", "PURGED"] },
        },
      });
      const session = await tx.importSession.findFirst({
        where: {
          id: c.sessionId,
          tenantId: c.tenantId,
          ownerProjectId: c.ownerProjectId,
          ownerUserId: c.ownerUserId,
          expiresAt: { gt: clock.now() },
        },
      });
      if (!ref || !artifact || !session)
        throw new Error("TEST_READ_AUTHORITY_FENCED");
    });
  const target = (
    kind: "ref" | "artifact" = "ref",
    id = kind === "ref" ? REF : ART,
  ): VaultPurgeTarget => ({
    kind,
    id,
    tenantId: OWNER.tenantId,
    ownerProjectId: OWNER.ownerProjectId,
  });
  const rows = async () => ({
    refs: await db.importSessionArtifact.findMany({ orderBy: { id: "asc" } }),
    artifacts: await db.importArtifact.findMany({ orderBy: { id: "asc" } }),
    sessions: await db.importSession.findMany({ orderBy: { id: "asc" } }),
  });
  const snapshot = async (label: string, preservePhysical = false) => {
    const rootStat = await fsp.lstat(root).catch((error: unknown) => {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    });
    const entries = rootStat?.isDirectory() ? await treeOf(root) : [];
    const files = [];
    for (const path of entries) {
      const stat = await fsp.lstat(join(root, path));
      files.push({
        path,
        mode: stat.mode & 0o777,
        type: stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : "file",
        size: stat.size,
        sha256: stat.isFile()
          ? hash(await fsp.readFile(join(root, path)))
          : null,
      });
    }
    await fsp.writeFile(
      join(dir, `${label}.json`),
      JSON.stringify(
        {
          rootKind:
            rootStat === null
              ? "absent"
              : rootStat.isDirectory()
                ? "directory"
                : rootStat.isSymbolicLink()
                  ? "symlink"
                  : "file",
          rows: await rows(),
          files,
          events: observers.flatMap((o) => o.events),
          callbackErrors: observers.flatMap((o) =>
            o.callbackErrors.map(({ op, path, error }) => ({
              op,
              path,
              error:
                error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      stack: error.stack,
                    }
                  : error,
            })),
          ),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (preservePhysical) {
      // Call only after the operation settles: disconnect checkpoints this fixture's
      // SQLite connection before copying, while the failed vault handles stay owned.
      await db.$disconnect();
      try {
        const snapshotDb = join(dir, `${label}.db`);
        await fsp.copyFile(dbPath, snapshotDb);
        await fsp.chmod(snapshotDb, 0o600);
        // Node's lazy async cp caches promise-method spies after their restoration.
        // Copy only settled evidence, outside the product's observed async IO.
        cpSync(root, join(dir, `${label}-vault`), {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      } finally {
        await db.$connect();
      }
    }
  };
  await snapshot("before");
  return {
    dir,
    root,
    roots,
    db,
    boot,
    borrowedLock,
    clock,
    gate: makeGate,
    track,
    io,
    locked,
    seedRef,
    seedArtifact,
    writeBlob,
    claim,
    recheck,
    readCapture,
    recheckRead,
    target,
    rows,
    snapshot,
    async finish() {
      for (const g of gates) g.release();
      try {
        await bounded(Promise.all(tasks), "owned IO shutdown");
      } finally {
        try {
          for (const o of observers.reverse()) {
            o.restore();
            await o.closeRemaining();
          }
          await snapshot("after");
        } finally {
          await borrowedLock.close();
          await db.$disconnect();
          await fsp.chmod(dbPath, 0o600);
          if (previous === undefined) delete process.env.TEST_DATABASE_URL;
          else process.env.TEST_DATABASE_URL = previous;
          guard.applyTestDatabaseUrl();
        }
      }
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const noDestruction = (events: IoEvent[]) =>
  expect(
    events.filter((e) => ["rename:start", "rm:start", "rmdir"].includes(e.op)),
  ).toEqual([]);
export async function absent(path: string) {
  await expect(fsp.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}
