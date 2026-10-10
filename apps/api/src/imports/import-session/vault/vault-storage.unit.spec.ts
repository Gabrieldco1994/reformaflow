import { existsSync, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../../test-utils/import-session-harness";
import { startVaultBoot, type VaultBootHandle } from "./vault-boot";
import * as lock from "./vault-lock";
import type { FileHandle } from "node:fs/promises";
import type { TestRegistry } from "./vault-fd-registry.unit.spec";

export type TestClaim = {
  tenantId: string;
  ownerProjectId: string;
  ownerUserId: string;
  sessionId: string;
  refId: string;
  uploadGeneration: 2;
  temporaryStorageKey: string;
  declaredBytes: number;
  declaredMime: "application/pdf";
  uploadSessionVersion: number;
  tokenExpiresAtMs: number;
  uploadTokenExpiresAtMs: number;
  uploadLeaseExpiresAtMs: number;
  sessionExpiresAtMs: number;
  claimedAtMs: number;
  claimedAtMonotonicMs: number;
};
export type TestStored = {
  storageKey: string;
  documentSha256: string;
  verifiedBytes: number;
  detectedFormat: string;
};
export type TestRead = Pick<
  TestClaim,
  "tenantId" | "ownerProjectId" | "ownerUserId" | "sessionId" | "refId"
> & { artifactId: string; storageKey: string };
export type TestStorage = {
  writeClaim(
    claim: TestClaim,
    source: Readable,
    recheck: (claim: TestClaim) => Promise<void>,
  ): Promise<TestStored>;
  withArtifactReader<T>(
    capture: TestRead,
    recheck: (capture: TestRead) => Promise<void>,
    consume: (source: Readable) => Promise<T>,
  ): Promise<T>;
  eraseCaptured(capture: object): Promise<void>;
};
function load<T extends object>(name: string): T {
  expect(existsSync(join(__dirname, `${name}.ts`))).toBe(true);
  return jest.requireActual<T>(`./${name}`);
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
describe("foundation storage: real handles, current DB recheck and fixed claim deadline", () => {
  let borrowedLock: FileHandle | undefined;
  const setup = new PrismaClient(),
    prisma = new PrismaService(),
    clock = new MutableClock();
  let world: ImportWorld,
    root: string,
    boot: VaultBootHandle,
    registry: TestRegistry,
    storage: TestStorage,
    claim: TestClaim;
  const bytes = Buffer.from("%PDF-1.4\nsynthetic document\n");
  beforeAll(async () => {
    world = await seedImportWorld(setup, `foundation-storage-${randomUUID()}`);
  });
  beforeEach(async () => {
    const Registry = load<{ VaultFdRegistry: new () => TestRegistry }>(
      "vault-fd-registry",
    ).VaultFdRegistry;
    const Storage = load<{
      VaultStorage: new (
        b: VaultBootHandle,
        r: TestRegistry,
        c: MutableClock,
      ) => TestStorage;
    }>("vault-storage").VaultStorage;
    clock.current = new Date("2026-09-28T15:00:00Z");
    const base = resolve(
      __dirname,
      "../../../../../../.agents/vault-foundation-fs",
    );
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    root = await fs.mkdtemp(join(base, "storage-"));
    await fs.mkdir(join(root, "t"), { mode: 0o700 });
    await fs.mkdir(join(root, "trash"), { mode: 0o700 });
    await fs.writeFile(join(root, ".lock"), "", { mode: 0o600 });
    // Only Linux lock ownership is synthetic; root/statfs/sync/close are real.
    jest.spyOn(lock, "decideLockProof").mockReturnValue({ ok: true });
    borrowedLock = await fs.open(join(root, ".lock"), "r");
    boot = startVaultBoot(
      {
        IMPORT_VAULT_ENABLED: "true",
        IMPORT_VAULT_LOCK_FD: String(borrowedLock.fd),
        VAULT_DIR: root,
        IMPORT_VAULT_IDLE_TIMEOUT_MS: "4294967296",
        IMPORT_VAULT_HEADROOM_BYTES: "1",
        IMPORT_VAULT_DRAIN_TIMEOUT_MS: "37",
      },
      { publicDir: `${root}-public`, privateDir: `${root}-private` },
    );
    await boot.settled;
    expect(boot.state()).toBe("ON");
    registry = new Registry();
    storage = new Storage(boot, registry, clock);
    const session = await seedSession(setup, world);
    const refId = randomUUID(),
      now = clock.now().getTime();
    claim = {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      ownerUserId: world.users.owner.id,
      sessionId: session.id,
      refId,
      uploadGeneration: 2,
      temporaryStorageKey: `t/${refId}`,
      declaredBytes: bytes.length,
      declaredMime: "application/pdf",
      uploadSessionVersion: 0,
      tokenExpiresAtMs: now + 120000,
      uploadTokenExpiresAtMs: now + 120000,
      uploadLeaseExpiresAtMs: now + 120000,
      sessionExpiresAtMs: session.expiresAt.getTime(),
      claimedAtMs: now,
      claimedAtMonotonicMs: performance.now(),
    };
    await setup.importSessionArtifact.create({
      data: {
        id: refId,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: session.id,
        position: 0,
        fileName: "synthetic.pdf",
        declaredMime: "application/pdf",
        declaredBytes: bytes.length,
        reservedBytes: bytes.length,
        state: "RESERVED",
        uploadGeneration: 2,
        temporaryStorageKey: claim.temporaryStorageKey,
        uploadLeaseExpiresAt: new Date(now + 120000),
      },
    });
  });
  afterEach(async () => {
    await borrowedLock?.close();
    borrowedLock = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await setup.$disconnect();
  });
  async function recheck(c: TestClaim) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE tenants SET id=id WHERE id=${c.tenantId}`;
      const row = await tx.importSessionArtifact.findFirst({
        where: {
          id: c.refId,
          tenantId: c.tenantId,
          ownerProjectId: c.ownerProjectId,
          sessionId: c.sessionId,
          state: "RESERVED",
          uploadGeneration: 2,
          temporaryPurgePending: false,
        },
      });
      if (!row) throw new Error("captured authority fenced");
    });
  }
  it("writes actual bytes/hash/modes and only releases its slot after owned directory closes", async () => {
    const held = gate(),
      entered = gate();
    const open = fs.open.bind(fs);
    jest
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]) === join(root, "t", claim.refId, "g2")) {
          const close = handle.close.bind(handle);
          jest.spyOn(handle, "close").mockImplementation(async () => {
            entered.release();
            await held.promise;
            await close();
          });
        }
        return handle;
      });
    const task = storage.writeClaim(claim, Readable.from([bytes]), recheck);
    try {
      await entered.promise;
      expect(registry.snapshotUploads()).toHaveLength(1);
      held.release();
      const stored = await task;
      expect(stored).toMatchObject({
        verifiedBytes: bytes.length,
        documentSha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(await fs.readFile(join(root, stored.storageKey))).toEqual(bytes);
      expect((await fs.stat(join(root, stored.storageKey))).mode & 0o777).toBe(
        0o600,
      );
      expect(
        (await fs.stat(join(root, "t", claim.refId, "g2"))).mode & 0o777,
      ).toBe(0o700);
      expect(registry.snapshotUploads()).toEqual([]);
    } finally {
      held.release();
      await task.catch(() => undefined);
    }
  });
  it("fresh recheck rejects after enter and before any filesystem open/mkdir", async () => {
    await setup.importSessionArtifact.update({
      where: { id: claim.refId },
      data: { state: "FAILED", temporaryPurgePending: true },
    });
    const open = jest.spyOn(fs, "open"),
      mkdir = jest.spyOn(fs, "mkdir");
    const callback = jest.fn(async (c: TestClaim) => {
      expect(registry.snapshotUploads()).toHaveLength(1);
      await recheck(c);
    });
    await expect(
      storage.writeClaim(claim, Readable.from([bytes]), callback),
    ).rejects.toThrow("captured authority fenced");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(registry.snapshotUploads()).toEqual([]);
  });
  it("late open after fence is really closed without writing; drain waits for that close", async () => {
    const opened = gate(),
      deliver = gate(),
      closing = gate(),
      closeGate = gate();
    const open = fs.open.bind(fs);
    let writes = 0;
    jest
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith("/blob")) {
          jest.spyOn(handle, "write").mockImplementation(() => {
            writes++;
            throw new Error("forbidden write");
          });
          const close = handle.close.bind(handle);
          jest.spyOn(handle, "close").mockImplementation(async () => {
            closing.release();
            await closeGate.promise;
            await close();
          });
          opened.release();
          await deliver.promise;
        }
        return handle;
      });
    const task = storage.writeClaim(claim, Readable.from([bytes]), recheck);
    const rejection = expect(task).rejects.toMatchObject({ kind: "FENCED" });
    try {
      await opened.promise;
      registry.fence(`R:${claim.refId}`);
      const drain = registry.abortAndDrain(`R:${claim.refId}`, 1000);
      deliver.release();
      await closing.promise;
      expect(registry.snapshotUploads()).toHaveLength(1);
      expect(writes).toBe(0);
      closeGate.release();
      await rejection;
      await expect(drain).resolves.toBe("DRAINED");
    } finally {
      deliver.release();
      closeGate.release();
      await task.catch(() => undefined);
    }
  });
  it.each(["short", "long", "wrong magic"] as const)(
    "rejects %s without publishing or destructive cleanup",
    async (kind) => {
      const input =
        kind === "short"
          ? bytes.subarray(0, -1)
          : kind === "long"
            ? Buffer.concat([bytes, Buffer.from("x")])
            : Buffer.alloc(bytes.length);
      await expect(
        storage.writeClaim(claim, Readable.from([input]), recheck),
      ).rejects.toMatchObject({
        kind: kind === "wrong magic" ? "UNSUPPORTED_DOCUMENT" : "SIZE_MISMATCH",
      });
      expect(registry.snapshotUploads()).toEqual([]);
      expect(await fs.stat(join(root, "t", claim.refId))).toBeDefined();
    },
  );
  it.each(["monotonic", "wall"] as const)(
    "does not renew the captured %s deadline at storage entry",
    async (which) => {
      if (which === "monotonic") {
        jest
          .spyOn(performance, "now")
          .mockReturnValue(claim.claimedAtMonotonicMs + 120000);
        clock.current = new Date(claim.claimedAtMs - 10000);
      } else clock.current = new Date(claim.claimedAtMs + 120000);
      const open = jest.spyOn(fs, "open");
      await expect(
        storage.writeClaim(claim, Readable.from([bytes]), recheck),
      ).rejects.toMatchObject({ kind: "DEADLINE_EXCEEDED" });
      expect(open).not.toHaveBeenCalled();
    },
  );
  it("refuses state-only ON/null runtime before admission or recheck", async () => {
    const Storage = load<{
      VaultStorage: new (
        b: VaultBootHandle,
        r: TestRegistry,
        c: MutableClock,
      ) => TestStorage;
    }>("vault-storage").VaultStorage;
    storage = new Storage({ ...boot, runtime: () => null }, registry, clock);
    const check = jest.fn(recheck);
    await expect(
      storage.writeClaim(claim, Readable.from([bytes]), check),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    expect(check).not.toHaveBeenCalled();
    expect(registry.snapshotUploads()).toEqual([]);
  });
  it("streams exactly 10MiB; large configured idle never becomes a timer delay", async () => {
    const large = Buffer.alloc(10 * 1024 * 1024, 32);
    bytes.copy(large);
    claim = { ...claim, declaredBytes: large.length };
    await setup.importSessionArtifact.update({
      where: { id: claim.refId },
      data: { declaredBytes: large.length, reservedBytes: large.length },
    });
    const timer = jest.spyOn(global, "setTimeout");
    const stored = await storage.writeClaim(
      claim,
      Readable.from([large.subarray(0, 19), large.subarray(19)]),
      recheck,
    );
    expect(stored.verifiedBytes).toBe(10485760);
    expect(stored.documentSha256).toBe(
      createHash("sha256").update(large).digest("hex"),
    );
    expect((await fs.stat(join(root, stored.storageKey))).size).toBe(10485760);
    expect(timer.mock.calls.some((call) => Number(call[1]) >= 2147483647)).toBe(
      false,
    );
  });
  it("checks the original deadline again after the awaited DB recheck", async () => {
    const open = jest.spyOn(fs, "open");
    await expect(
      storage.writeClaim(claim, Readable.from([bytes]), async (c) => {
        await recheck(c);
        clock.current = new Date(claim.claimedAtMs + 120000);
      }),
    ).rejects.toMatchObject({ kind: "DEADLINE_EXCEEDED" });
    expect(open).not.toHaveBeenCalled();
  });
  it("idle exact boundary remains live; +1 aborts, without sleeping or advancing wall time", async () => {
    const shortBoot = startVaultBoot(
      {
        IMPORT_VAULT_ENABLED: "true",
        IMPORT_VAULT_LOCK_FD: String(borrowedLock!.fd),
        VAULT_DIR: root,
        IMPORT_VAULT_IDLE_TIMEOUT_MS: "7",
        IMPORT_VAULT_HEADROOM_BYTES: "1",
        IMPORT_VAULT_DRAIN_TIMEOUT_MS: "37",
      },
      { publicDir: `${root}-public`, privateDir: `${root}-private` },
    );
    await shortBoot.settled;
    expect(shortBoot.state()).toBe("ON");
    const Storage = load<{
      VaultStorage: new (
        b: VaultBootHandle,
        r: TestRegistry,
        c: MutableClock,
      ) => TestStorage;
    }>("vault-storage").VaultStorage;
    storage = new Storage(shortBoot, registry, clock);
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "performance"],
    });
    let mono = claim.claimedAtMonotonicMs;
    jest.spyOn(performance, "now").mockImplementation(() => mono);
    const ready = gate(),
      source = new Readable({
        read() {
          ready.release();
        },
      });
    const task = storage.writeClaim(claim, source, recheck);
    let settled = false;
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = expect(task).rejects.toMatchObject({
      kind: "IDLE_TIMEOUT",
    });
    try {
      await ready.promise;
      mono += 7;
      jest.advanceTimersByTime(7);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(registry.snapshotUploads()).toHaveLength(1);
      mono++;
      jest.advanceTimersByTime(1);
      await rejection;
      expect(registry.snapshotUploads()).toEqual([]);
    } finally {
      source.destroy();
      jest.useRealTimers();
      await task.catch(() => undefined);
    }
  });
  it("reader A lease stays live until its real handle close, not just EOF", async () => {
    const stored = await storage.writeClaim(
      claim,
      Readable.from([bytes]),
      recheck,
    );
    const artifactId = randomUUID();
    await setup.importArtifact.create({
      data: {
        id: artifactId,
        tenantId: claim.tenantId,
        ownerProjectId: claim.ownerProjectId,
        ...stored,
        state: "RAW_READY",
      },
    });
    await setup.importSessionArtifact.update({
      where: { id: claim.refId },
      data: {
        state: "ATTACHED",
        artifactId,
        verifiedAt: clock.now(),
        temporaryStorageKey: null,
        reservedBytes: 0,
      },
    });
    const closing = gate(),
      release = gate(),
      open = fs.open.bind(fs);
    jest
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith("/blob")) {
          const close = handle.close.bind(handle);
          jest.spyOn(handle, "close").mockImplementation(async () => {
            closing.release();
            await release.promise;
            await close();
          });
        }
        return handle;
      });
    const capture = { ...claim, artifactId, storageKey: stored.storageKey };
    const task = storage.withArtifactReader(
      capture,
      async (c) => {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE tenants SET id=id WHERE id=${c.tenantId}`;
          const row = await tx.importArtifact.findFirst({
            where: {
              id: c.artifactId,
              tenantId: c.tenantId,
              ownerProjectId: c.ownerProjectId,
              state: "RAW_READY",
              storageKey: c.storageKey,
            },
          });
          if (!row) throw new Error("read fenced");
        });
      },
      async (source) => {
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      },
    );
    try {
      await closing.promise;
      registry.fence(`A:${artifactId}`);
      const drain = registry.abortAndDrain(`A:${artifactId}`, 1000);
      let drained = false;
      void drain.then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      release.release();
      await expect(task).resolves.toEqual(bytes);
      await expect(drain).resolves.toBe("DRAINED");
    } finally {
      release.release();
      await task.catch(() => undefined);
    }
  });
  it("sync and failed close both stay sanitized; uncertainty keeps the R slot", async () => {
    const open = fs.open.bind(fs);
    let physicalClose: (() => Promise<void>) | undefined;
    jest
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith("/blob")) {
          physicalClose = handle.close.bind(handle);
          jest
            .spyOn(handle, "sync")
            .mockRejectedValue(
              Object.assign(new Error("secret path"), { code: "ENOSPC" }),
            );
          jest
            .spyOn(handle, "close")
            .mockRejectedValue(
              Object.assign(new Error("secret path"), { code: "ESECRET123" }),
            );
        }
        return handle;
      });
    try {
      await expect(
        storage.writeClaim(claim, Readable.from([bytes]), recheck),
      ).rejects.toMatchObject({
        kind: "FS_ERROR",
        step: "sync-file",
        code: "ENOSPC",
        closeCode: "UNKNOWN",
        message: "FS_ERROR:sync-file",
      });
      expect(registry.snapshotUploads()).toHaveLength(1);
    } finally {
      await physicalClose?.();
    }
  });
  it("directory sync failure is observable but successful real close releases its R lease", async () => {
    const open = fs.open.bind(fs);
    jest
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]) === join(root, "t", claim.refId, "g2"))
          jest
            .spyOn(handle, "sync")
            .mockRejectedValue(
              Object.assign(new Error("sync"), { code: "EIO" }),
            );
        return handle;
      });
    await expect(
      storage.writeClaim(claim, Readable.from([bytes]), recheck),
    ).rejects.toMatchObject({
      kind: "FS_ERROR",
      step: "sync-directory",
      code: "EIO",
    });
    expect(registry.snapshotUploads()).toEqual([]);
  });
  it.each(["existing", "symlink"] as const)(
    "never overwrites an %s blob",
    async (kind) => {
      const dir = join(root, "t", claim.refId, "g2"),
        external = join(root, "keep");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(external, "untouched", { mode: 0o600 });
      if (kind === "symlink") await fs.symlink(external, join(dir, "blob"));
      else await fs.writeFile(join(dir, "blob"), "untouched", { mode: 0o600 });
      await expect(
        storage.writeClaim(claim, Readable.from([bytes]), recheck),
      ).rejects.toMatchObject({ kind: "FS_ERROR", step: "open" });
      expect(await fs.readFile(external, "utf8")).toBe("untouched");
      expect(await fs.readFile(join(dir, "blob"), "utf8")).toBe("untouched");
    },
  );
});
