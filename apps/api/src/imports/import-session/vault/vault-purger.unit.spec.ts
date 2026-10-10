import { existsSync, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
import type { TestStorage, TestClaim } from "./vault-storage.unit.spec";

type Target = {
  kind: "ref" | "artifact";
  tenantId: string;
  ownerProjectId: string;
  id: string;
};
type Coordinator = {
  purge(
    target: Target,
  ): Promise<"PURGED" | "NOT_ELIGIBLE" | "STALE_CAPTURE" | "DRAIN_TIMEOUT">;
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
describe("foundation purge: real SQLite, filesystem and restart", () => {
  let borrowedLock: FileHandle | undefined;
  const setup = new PrismaClient(),
    prisma = new PrismaService(),
    clock = new MutableClock();
  let world: ImportWorld,
    root: string,
    boot: VaultBootHandle,
    registry: TestRegistry,
    storage: TestStorage,
    purger: Coordinator;
  let refId: string, artifactId: string, ownerId: string;
  beforeAll(async () => {
    world = await seedImportWorld(setup, `foundation-purge-${randomUUID()}`);
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
    load("vault-purger");
    const base = resolve(
      __dirname,
      "../../../../../../.agents/vault-foundation-fs",
    );
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    root = await fs.mkdtemp(join(base, "purger-"));
    await fs.mkdir(join(root, "t"), { mode: 0o700 });
    await fs.mkdir(join(root, "trash"), { mode: 0o700 });
    await fs.writeFile(join(root, ".lock"), "", { mode: 0o600 });
    jest.spyOn(lock, "decideLockProof").mockReturnValue({ ok: true });
    borrowedLock = await fs.open(join(root, ".lock"), "r");
    boot = startVaultBoot(
      {
        IMPORT_VAULT_ENABLED: "true",
        IMPORT_VAULT_LOCK_FD: String(borrowedLock.fd),
        VAULT_DIR: root,
        IMPORT_VAULT_IDLE_TIMEOUT_MS: "120000",
        IMPORT_VAULT_HEADROOM_BYTES: "1",
      },
      { publicDir: `${root}-public`, privateDir: `${root}-private` },
    );
    await boot.settled;
    expect(boot.state()).toBe("ON");
    registry = new Registry();
    storage = new Storage(boot, registry, clock);
    purger = coordinator();
    const session = await seedSession(setup, world);
    refId = randomUUID();
    artifactId = randomUUID();
    ownerId = randomUUID();
    await setup.importSessionArtifact.create({
      data: {
        id: refId,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: session.id,
        position: 0,
        fileName: "private.pdf",
        declaredMime: "application/pdf",
        declaredBytes: 17,
        reservedBytes: 17,
        state: "FAILED",
        uploadGeneration: 3,
        temporaryPurgePending: true,
        temporaryStorageKey: `t/${refId}`,
      },
    });
    await setup.importArtifact.create({
      data: {
        id: artifactId,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        state: "RAW_READY",
        documentSha256: randomUUID().replace(/-/g, "").repeat(2),
        verifiedBytes: 17,
        detectedFormat: "PDF",
        storageKey: `t/${ownerId}/g2/blob`,
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
  function coordinator(timeout = 1000): Coordinator {
    const C = load<{
      PurgeCoordinator: new (
        p: PrismaService,
        c: MutableClock,
        b: VaultBootHandle,
        r: TestRegistry,
        s: TestStorage,
        t: number,
      ) => Coordinator;
    }>("vault-purger").PurgeCoordinator;
    return new C(prisma, clock, boot, registry, storage, timeout);
  }
  function target(kind: "ref" | "artifact"): Target {
    return {
      kind,
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      id: kind === "ref" ? refId : artifactId,
    };
  }
  async function blob(relative: string) {
    await fs.mkdir(join(root, relative), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(root, relative, "blob"), "synthetic-private", {
      mode: 0o600,
    });
  }
  async function charged() {
    return prisma.importSessionArtifact.findUniqueOrThrow({
      where: { id: refId },
    });
  }
  it("coalesces the identical Promise and waits for physical proof before releasing DB charge", async () => {
    await blob(`t/${refId}/g2`);
    const proof = gate(),
      release = gate(),
      original = fs.lstat.bind(fs);
    let proofCount = 0;
    jest.spyOn(fs, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fs.lstat>
    ) => {
      try {
        return await original(...args);
      } catch (error) {
        if (
          String(args[0]) === join(root, `trash/r-${refId}`) &&
          ++proofCount > 1
        ) {
          proof.release();
          await release.promise;
        }
        throw error;
      }
    }) as typeof fs.lstat);
    const first = purger.purge(target("ref")),
      second = purger.purge(target("ref"));
    expect(second).toBe(first);
    try {
      await proof.promise;
      expect((await charged()).reservedBytes).toBe(17);
      release.release();
      await expect(first).resolves.toBe("PURGED");
      expect(await charged()).toMatchObject({
        temporaryStorageKey: null,
        reservedBytes: 0,
        temporaryPurgePending: false,
        state: "FAILED",
      });
    } finally {
      release.release();
      await first.catch(() => undefined);
    }
  });
  it("timeout removes memory fence/map but retains the unresolved lease and byte charge", async () => {
    await blob(`t/${refId}/g2`);
    const owned = await fs.open(join(root, "t", refId, "g2", "blob"), "r");
    let actuallyClosed = false;
    const close = async () => {
      if (!actuallyClosed) {
        await owned.close();
        actuallyClosed = true;
      }
    };
    const lease = registry.enter(`R:${refId}`, {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      ownerUserId: world.users.owner.id,
    });
    if (!lease.ok) throw new Error("admission failed");
    const drain = registry.abortAndDrain.bind(registry),
      entered = gate();
    jest.spyOn(registry, "abortAndDrain").mockImplementation((...args) => {
      const task = drain(...args);
      entered.release();
      return task;
    });
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "performance"],
    });
    const small = coordinator(20),
      task = small.purge(target("ref"));
    try {
      await entered.promise;
      jest.advanceTimersByTime(20);
      await expect(task).resolves.toBe("DRAIN_TIMEOUT");
      expect((await charged()).reservedBytes).toBe(17);
      expect(registry.snapshotUploads()).toHaveLength(1);
      const admission = registry.enter(`R:${refId}`, {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        ownerUserId: world.users.owner.id,
      });
      expect(admission.ok).toBe(true);
      if (admission.ok) admission.lease.exit();
      const retained = await charged(),
        now = clock.now().getTime();
      const fencedClaim: TestClaim = {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        ownerUserId: world.users.owner.id,
        sessionId: retained.sessionId,
        refId,
        uploadGeneration: 2,
        temporaryStorageKey: `t/${refId}`,
        declaredBytes: 17,
        declaredMime: "application/pdf",
        uploadSessionVersion: 0,
        tokenExpiresAtMs: now + 120000,
        uploadTokenExpiresAtMs: now + 120000,
        uploadLeaseExpiresAtMs: now + 120000,
        sessionExpiresAtMs: now + 120000,
        claimedAtMs: now,
        claimedAtMonotonicMs: performance.now(),
      };
      const open = jest.spyOn(fs, "open");
      await expect(
        storage.writeClaim(fencedClaim, Readable.from(["%PDF-"]), async (c) => {
          await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`UPDATE tenants SET id=id WHERE id=${c.tenantId}`;
            const current = await tx.importSessionArtifact.findFirst({
              where: {
                tenantId: c.tenantId,
                ownerProjectId: c.ownerProjectId,
                sessionId: c.sessionId,
                id: c.refId,
                state: "RESERVED",
                uploadGeneration: 2,
                temporaryPurgePending: false,
              },
            });
            if (!current) throw new Error("persistent fence");
          });
        }),
      ).rejects.toThrow("persistent fence");
      expect(open).not.toHaveBeenCalled();
      open.mockRestore();
      expect(registry.snapshotUploads()).toHaveLength(1);
      const retry = small.purge(target("ref"));
      expect(retry).not.toBe(task);
      expect(small.purge(target("ref"))).toBe(retry);
      await close();
      lease.lease.exit();
      await expect(retry).resolves.toBe("PURGED");
    } finally {
      await close();
      lease.lease.exit();
      jest.useRealTimers();
      await task;
    }
  });
  it.each(["source", "trash", "absent", "both"] as const)(
    "recovers artifact restart state %s using captured storage generation, never mutable generation",
    async (state) => {
      const source = `t/${ownerId}/g2`,
        trash = `trash/a-${artifactId}-${ownerId}-g2`;
      if (state === "source" || state === "both") await blob(source);
      if (state === "trash" || state === "both") await blob(trash);
      await setup.importArtifact.update({
        where: { id: artifactId },
        data: { state: "PURGING", parseGeneration: 19 },
      });
      const rename = jest.spyOn(fs, "rename");
      const task = coordinator().purge(target("artifact"));
      if (state === "both") {
        await expect(task).rejects.toMatchObject({ kind: "ANOMALY" });
        expect(
          (
            await prisma.importArtifact.findUniqueOrThrow({
              where: { id: artifactId },
            })
          ).storageKey,
        ).not.toBeNull();
        expect(rename).not.toHaveBeenCalled();
      } else {
        await expect(task).resolves.toBe("PURGED");
        if (state === "source")
          expect(rename).toHaveBeenCalledWith(
            join(root, source),
            join(root, trash),
          );
        expect(
          (
            await prisma.importArtifact.findUniqueOrThrow({
              where: { id: artifactId },
            })
          ).storageKey,
        ).toBeNull();
        expect((await charged()).reservedBytes).toBe(17);
      }
    },
  );
  it("failed directory fsync after rename retains charge and retry repeats durability", async () => {
    await blob(`t/${refId}/g2`);
    const original = fs.open.bind(fs);
    let inject = true;
    jest
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]) === join(root, "trash") && inject) {
          inject = false;
          jest
            .spyOn(handle, "sync")
            .mockRejectedValue(
              Object.assign(new Error("private error path"), { code: "EIO" }),
            );
        }
        return handle;
      });
    await expect(purger.purge(target("ref"))).rejects.toMatchObject({
      kind: "FS_ERROR",
      code: "EIO",
    });
    expect((await charged()).reservedBytes).toBe(17);
    await expect(coordinator().purge(target("ref"))).resolves.toBe("PURGED");
    expect((await charged()).reservedBytes).toBe(0);
  });
  it.each(["t", "trash"] as const)(
    "missing always-required %s is not absent-owner recovery",
    async (parent) => {
      await fs.rmdir(join(root, parent));
      await expect(purger.purge(target("artifact"))).rejects.toMatchObject({
        kind: "FS_ERROR",
      });
      expect(
        (
          await prisma.importArtifact.findUniqueOrThrow({
            where: { id: artifactId },
          })
        ).storageKey,
      ).not.toBeNull();
    },
  );
  it("ATTACHED membership and foreign scope never permit destructive FS", async () => {
    await setup.importSessionArtifact.update({
      where: { id: refId },
      data: { state: "ATTACHED", artifactId, verifiedAt: clock.now() },
    });
    const rename = jest.spyOn(fs, "rename");
    await expect(purger.purge(target("artifact"))).resolves.toBe(
      "NOT_ELIGIBLE",
    );
    await expect(
      purger.purge({ ...target("ref"), tenantId: world.otherTenantId }),
    ).resolves.toBe("NOT_ELIGIBLE");
    expect(rename).not.toHaveBeenCalled();
  });
  it.each(["source", "trash"] as const)(
    "never refunds if %s reappears before the final absence proof",
    async (which) => {
      await blob(`t/${refId}/g2`);
      const remove = fs.rm.bind(fs);
      const path = join(
        root,
        which === "source" ? `t/${refId}` : `trash/r-${refId}`,
      );
      jest
        .spyOn(fs, "rm")
        .mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
          await remove(...args);
          await fs.mkdir(path, { mode: 0o700 });
        });
      await expect(purger.purge(target("ref"))).rejects.toMatchObject({
        kind: "ANOMALY",
        step: "absence-proof",
      });
      expect((await charged()).reservedBytes).toBe(17);
      expect(await fs.lstat(path)).toBeDefined();
    },
  );
  it("restart after owner removal and failed t sync retries without opening absent owner", async () => {
    await blob(`t/${ownerId}/g2`);
    const open = fs.open.bind(fs);
    const remove = fs.rmdir.bind(fs);
    let removed = false,
      failed = false;
    jest
      .spyOn(fs, "rmdir")
      .mockImplementation(async (...args: Parameters<typeof fs.rmdir>) => {
        await remove(...args);
        if (String(args[0]) === join(root, "t", ownerId)) removed = true;
      });
    const openings: string[] = [];
    jest
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        openings.push(String(args[0]));
        const handle = await open(...args);
        if (removed && !failed && String(args[0]) === join(root, "t")) {
          failed = true;
          jest
            .spyOn(handle, "sync")
            .mockRejectedValue(
              Object.assign(new Error("sync"), { code: "EIO" }),
            );
        }
        return handle;
      });
    await expect(purger.purge(target("artifact"))).rejects.toMatchObject({
      kind: "FS_ERROR",
      code: "EIO",
    });
    openings.length = 0;
    await expect(coordinator().purge(target("artifact"))).resolves.toBe(
      "PURGED",
    );
    expect(openings).not.toContain(join(root, "t", ownerId));
    expect(openings).toEqual(
      expect.arrayContaining([join(root, "t"), join(root, "trash")]),
    );
  });
});
