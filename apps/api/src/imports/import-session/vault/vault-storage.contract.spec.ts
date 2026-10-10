import { constants, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { startVaultBoot } from "./vault-boot";
import {
  ART,
  NOW,
  OWNER,
  PDF,
  REF,
  absent,
  bounded,
  fixture,
  hash,
  loadIoError,
  loadRegistry,
  loadStorage,
  outcome,
  readAll,
  rejected,
  type VaultDeclaredMime,
  type VaultUploadClaim,
} from "../../../test-utils/vault-foundation-harness";

async function setup(idle = 5000) {
  const Storage = loadStorage(),
    Registry = loadRegistry();
  const f = await fixture(idle);
  const registry = new Registry();
  const storage = new Storage(f.boot, registry, f.clock);
  await f.seedRef();
  return { f, registry, storage };
}

const formats: { mime: VaultDeclaredMime; bytes: Buffer; format: string }[] = [
  { mime: "application/pdf", bytes: PDF, format: "PDF" },
  {
    mime: "text/csv",
    bytes: Buffer.from("date,value\n2026-10-07,17.21\n"),
    format: "CSV",
  },
  {
    mime: "text/plain",
    bytes: Buffer.from("date,value\n2026-10-07,17.21\n"),
    format: "CSV",
  },
  {
    mime: "application/vnd.ms-excel",
    bytes: Buffer.from("d0cf11e0a1b11ae100010203", "hex"),
    format: "XLS",
  },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: Buffer.from("504b030400000000", "hex"),
    format: "XLSX",
  },
  {
    mime: "application/x-ofx",
    bytes: Buffer.from("OFXHEADER:100\n<OFX></OFX>"),
    format: "OFX",
  },
  {
    mime: "application/vnd.ofx",
    bytes: Buffer.from("<OFX></OFX>"),
    format: "OFX",
  },
  {
    mime: "image/png",
    bytes: Buffer.from("89504e470d0a1a0a00000000", "hex"),
    format: "PNG",
  },
  {
    mime: "image/jpeg",
    bytes: Buffer.from("ffd8ffe000104a464946", "hex"),
    format: "JPEG",
  },
  {
    mime: "image/webp",
    bytes: Buffer.from("524946460400000057454250", "hex"),
    format: "WEBP",
  },
];

describe("P05 independent storage contract", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("CONTROL real canonical boot, real SQLite middleware, and bound original FD close", async () => {
    const f = await fixture();
    const opened = f.gate(),
      closeGate = f.gate();
    let finished = false;
    try {
      await f.seedRef();
      expect(await f.db.importSessionArtifact.count()).toBe(1);
      expect(await f.db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      await f.db.project.create({
        data: {
          id: "soft-delete-control",
          tenantId: OWNER.tenantId,
          name: "Synthetic",
          type: "PESSOAL",
        },
      });
      await f.db.project.delete({ where: { id: "soft-delete-control" } });
      expect(
        await f.db.project.findFirst({ where: { id: "soft-delete-control" } }),
      ).toBeNull();
      expect(
        (
          await f.db.project.findUniqueOrThrow({
            where: { id: "soft-delete-control" },
          })
        ).deletedAt,
      ).not.toBeNull();
      const io = f.io({
        beforeClose: async () => {
          opened.release();
          await closeGate.promise;
        },
      });
      await f.writeBlob();
      const handle = await fsp.open(
        join(f.root, `t/${REF}/g2/blob`),
        constants.O_RDONLY,
      );
      const close = f.track(
        handle.close().then(() => {
          finished = true;
        }),
      );
      await bounded(opened.promise);
      expect(finished).toBe(false);
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      closeGate.release();
      await bounded(close);
      expect(handle.fd).toBe(-1);
      expect(io.events.filter((e) => e.op === "close:done")).toHaveLength(1);
      expect(await fsp.readFile(join(f.root, `t/${REF}/g2/blob`))).toEqual(PDF);
    } finally {
      closeGate.release();
      await f.finish();
    }
  });

  it("F01 uses canonical boot runtime, not a conflicting environment root", async () => {
    const { f, storage, registry } = await setup();
    const prior = process.env.VAULT_DIR;
    try {
      process.env.VAULT_DIR = join(f.dir, "forbidden-env-root");
      const io = f.io();
      const result = await f.track(
        storage.writeClaim(f.claim(), Readable.from([PDF]), f.recheck),
      );
      expect(result.storageKey).toBe(`t/${REF}/g2/blob`);
      expect(await fsp.readFile(join(f.root, result.storageKey))).toEqual(PDF);
      await absent(process.env.VAULT_DIR);
      expect(
        io.events.some((e) => e.op === "open" && e.path.endsWith("/blob")),
      ).toBe(true);
      expect(registry.snapshotUploads()).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.VAULT_DIR;
      else process.env.VAULT_DIR = prior;
      await f.finish();
    }
  });

  it("CONTROL upload authority admits exactly DRAFT and NEEDS_INPUT", async () => {
    const f = await fixture();
    try {
      await f.seedRef();
      for (const [state, allowed] of [
        ["DRAFT", true],
        ["NEEDS_INPUT", true],
        ["ANALYZING", false],
        ["READY", false],
        ["REVIEW_REQUIRED", false],
        ["CONFIRMED", false],
        ["APPLIED", false],
        ["CANCELLED", false],
        ["EXPIRED", false],
      ] as const) {
        await f.db.importSession.update({
          where: { id: "qa-session" },
          data: {
            state,
            ...(state === "APPLIED"
              ? {
                  receiptJson: '{"synthetic":"retained-witness"}',
                  financialRequestId: REF,
                  closedAt: f.clock.now(),
                  confirmedRevision: 1,
                  confirmedSessionVersion: 0,
                  confirmedAt: f.clock.now(),
                  proposalHash: "c".repeat(64),
                }
              : {}),
          },
        });
        const result = await outcome(f.recheck(f.claim()));
        expect({ state, allowed: result.ok }).toEqual({ state, allowed });
        if (!allowed)
          expect(result).toMatchObject({
            ok: false,
            error: { message: "TEST_AUTHORITY_FENCED" },
          });
      }
    } finally {
      await f.finish();
    }
  });

  it("CONTROL synthetic persisted claim/read fixtures enforce fresh locked identity, not caller booleans", async () => {
    const f = await fixture();
    try {
      await f.seedRef();
      await expect(f.recheck(f.claim())).resolves.toBeUndefined();
      await f.seedArtifact();
      await f.db.importSessionArtifact.update({
        where: { id: REF },
        data: {
          state: "ATTACHED",
          artifactId: ART,
          verifiedAt: f.clock.now(),
          temporaryStorageKey: null,
          reservedBytes: 0,
        },
      });
      await expect(f.recheckRead(f.readCapture())).resolves.toBeUndefined();
      await expect(
        f.recheckRead({ ...f.readCapture(), ownerProjectId: "other-p" }),
      ).rejects.toThrow("TEST_READ_AUTHORITY_FENCED");
      await expect(f.recheck(f.claim())).rejects.toThrow(
        "TEST_AUTHORITY_FENCED",
      );
      await f.db.importArtifact.update({
        where: { id: ART },
        data: { state: "PURGING" },
      });
      await expect(f.recheckRead(f.readCapture())).rejects.toThrow(
        "TEST_READ_AUTHORITY_FENCED",
      );
      expect(await f.db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    } finally {
      await f.finish();
    }
  });

  it.each(["missing", "file", "symlink"] as const)(
    "CONTROL evidence snapshot retains invalid root (%s) without following or erasing it",
    async (kind) => {
      const f = await fixture();
      try {
        const preserved = join(f.dir, "preserved-vault");
        await fsp.rename(f.root, preserved);
        if (kind === "file") await fsp.writeFile(f.root, PDF, { mode: 0o600 });
        if (kind === "symlink") await fsp.symlink(preserved, f.root);
        await f.snapshot("invalid-root");
        const snapshot = JSON.parse(
          await fsp.readFile(join(f.dir, "invalid-root.json"), "utf8"),
        );
        expect(snapshot.rootKind).toBe(kind === "missing" ? "absent" : kind);
        expect(snapshot.files).toEqual([]);
        expect((await fsp.lstat(preserved)).isDirectory()).toBe(true);
      } finally {
        await f.finish();
      }
    },
  );

  it.each(["off", "state-only"] as const)(
    "F01 %s with null runtime has zero IO or authority effects",
    async (mode) => {
      const Storage = loadStorage(),
        Registry = loadRegistry();
      const f = await fixture();
      try {
        const off = startVaultBoot({}, f.roots);
        const boot =
          mode === "off" ? off : { ...off, state: () => "ON" as const };
        const storage = new Storage(boot, new Registry(), f.clock);
        const recheck = jest.fn(f.recheck);
        const io = f.io();
        const before = await f.rows();
        await rejected(
          storage.writeClaim(f.claim(), Readable.from([PDF]), recheck),
          "UNAVAILABLE",
        );
        await rejected(
          storage.withArtifactReader(
            f.readCapture(),
            jest.fn(f.recheckRead),
            readAll,
          ),
          "UNAVAILABLE",
        );
        expect(recheck).not.toHaveBeenCalled();
        expect(io.events).toEqual([]);
        expect(await f.rows()).toEqual(before);
      } finally {
        await f.finish();
      }
    },
  );

  it("F02 enters R before awaiting fresh locked recheck", async () => {
    const { f, registry, storage } = await setup();
    const entered = f.gate(),
      release = f.gate();
    try {
      const io = f.io();
      const work = f.track(
        storage.writeClaim(f.claim(), Readable.from([PDF]), async (c) => {
          entered.release();
          await release.promise;
          await f.recheck(c);
        }),
      );
      const result = outcome(work);
      expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF }]);
      await bounded(entered.promise);
      expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF }]);
      expect(io.events).toEqual([]);
      registry.fence(`R:${REF}`);
      expect(registry.enter(`R:${REF}`, OWNER)).toEqual({
        ok: false,
        reason: "FENCED",
      });
      const drain = registry.abortAndDrain(`R:${REF}`, 1000);
      release.release();
      expect((await bounded(result)).ok).toBe(false);
      expect(await bounded(drain)).toBe("DRAINED");
      expect(io.events).toEqual([]);
    } finally {
      release.release();
      registry.releaseFence(`R:${REF}`);
      await f.finish();
    }
  });

  it.each([
    "ANALYZING",
    "READY",
    "REVIEW_REQUIRED",
    "CONFIRMED",
    "APPLIED",
    "CANCELLED",
    "EXPIRED",
  ])(
    "F03 post-enter session change to %s rejects the callback authority before mkdir/open",
    async (state) => {
      const { f, storage, registry } = await setup();
      const entered = f.gate(),
        recheckGate = f.gate();
      let authorityFailure: unknown;
      try {
        const io = f.io();
        const recheck = jest.fn(async (claim: VaultUploadClaim) => {
          entered.release();
          await recheckGate.promise;
          try {
            await f.recheck(claim);
          } catch (error) {
            authorityFailure = error;
            throw error;
          }
        });
        const work = f.track(
          storage.writeClaim(f.claim(), Readable.from([PDF]), recheck),
        );
        expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF }]);
        await bounded(entered.promise);
        await f.locked(async (tx) => {
          await tx.importSession.update({
            where: { id: "qa-session" },
            data: {
              state,
              ...(state === "APPLIED"
                ? {
                    receiptJson: '{"synthetic":"retained-witness"}',
                    financialRequestId: REF,
                    closedAt: f.clock.now(),
                    confirmedRevision: 1,
                    confirmedSessionVersion: 0,
                    confirmedAt: f.clock.now(),
                    proposalHash: "c".repeat(64),
                  }
                : {}),
            },
          });
        });
        recheckGate.release();
        const failure = await rejected(work);
        expect(authorityFailure).toMatchObject({
          message: "TEST_AUTHORITY_FENCED",
        });
        expect(failure).toBe(authorityFailure);
        expect(recheck).toHaveBeenCalledTimes(1);
        expect(io.events).toEqual([]);
        expect(registry.snapshotUploads()).toEqual([]);
      } finally {
        recheckGate.release();
        await f.finish();
      }
    },
  );

  it("F03 fence before registration forces fresh DB recheck and propagates authority exception unchanged", async () => {
    const { f, storage, registry } = await setup();
    try {
      const captured = f.claim();
      await f.locked(async (tx) => {
        await tx.importSessionArtifact.update({
          where: { id: REF },
          data: {
            state: "FAILED",
            temporaryPurgePending: true,
            uploadGeneration: 3,
            uploadLeaseExpiresAt: null,
          },
        });
      });
      const authorityFailure = new Error("TEST_AUTHORITY_FENCED");
      const recheck = jest.fn(async (claim: VaultUploadClaim) => {
        try {
          await f.recheck(claim);
        } catch (error) {
          expect(error).toMatchObject({ message: "TEST_AUTHORITY_FENCED" });
          throw authorityFailure;
        }
      });
      const io = f.io();
      expect(
        await rejected(
          storage.writeClaim(captured, Readable.from([PDF]), recheck),
        ),
      ).toBe(authorityFailure);
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(io.events).toEqual([]);
      expect(registry.snapshotUploads()).toEqual([]);
    } finally {
      await f.finish();
    }
  });

  it("F04 pending real open closes its actual late FD without writing before drain resolves", async () => {
    const { f, storage, registry } = await setup();
    const opened = f.gate(),
      allowOpen = f.gate(),
      closing = f.gate(),
      allowClose = f.gate();
    let drainDone = false;
    try {
      const io = f.io({
        afterOpen: async (path) => {
          if (path.endsWith("/blob")) {
            opened.release();
            await allowOpen.promise;
          }
        },
        beforeClose: async (path) => {
          if (path.endsWith("/blob")) {
            closing.release();
            await allowClose.promise;
          }
        },
      });
      const write = outcome(
        f.track(storage.writeClaim(f.claim(), Readable.from([PDF]), f.recheck)),
      );
      await bounded(opened.promise);
      registry.fence(`R:${REF}`);
      const drain = registry.abortAndDrain(`R:${REF}`, 1000);
      void drain.then(() => {
        drainDone = true;
      });
      expect(registry.snapshotUploads()).toHaveLength(1);
      allowOpen.release();
      await bounded(closing.promise);
      expect(drainDone).toBe(false);
      expect((await fsp.stat(join(f.root, `t/${REF}/g2/blob`))).size).toBe(0);
      expect(
        io.events.some(
          (e) => e.op === "close:done" && e.path.endsWith("/blob"),
        ),
      ).toBe(false);
      allowClose.release();
      expect((await bounded(write)).ok).toBe(false);
      expect(await bounded(drain)).toBe("DRAINED");
      const handle = [...io.owned.keys()].find((h) =>
        io.owned.get(h)?.path.endsWith("/blob"),
      );
      expect(handle?.fd).toBe(-1);
      expect(registry.snapshotUploads()).toEqual([]);
    } finally {
      allowOpen.release();
      allowClose.release();
      registry.releaseFence(`R:${REF}`);
      await f.finish();
    }
  });

  it.each(formats)(
    "F08 allowlisted $mime stores actual bytes and independent hash ($format)",
    async ({ mime, bytes, format }) => {
      const { f, storage, registry } = await setup();
      try {
        await f.db.importSessionArtifact.update({
          where: { id: REF },
          data: {
            declaredMime: mime,
            declaredBytes: bytes.length,
            reservedBytes: bytes.length,
          },
        });
        const assertLeaseHeld = async () => {
          expect(registry.snapshotUploads()).toEqual([
            { ...OWNER, refId: REF },
          ]);
        };
        const io = f.io({
          beforeSync: assertLeaseHeld,
          beforeClose: assertLeaseHeld,
        });
        const stored = await f.track(
          storage.writeClaim(
            f.claim({ declaredMime: mime, declaredBytes: bytes.length }),
            Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
            f.recheck,
          ),
        );
        const disk = await fsp.readFile(join(f.root, stored.storageKey));
        expect(disk).toEqual(bytes);
        expect(stored).toEqual({
          storageKey: `t/${REF}/g2/blob`,
          documentSha256: hash(disk),
          verifiedBytes: bytes.length,
          detectedFormat: format,
        });
        expect(
          (await fsp.stat(join(f.root, stored.storageKey))).mode & 0o777,
        ).toBe(0o600);
        for (const path of [`t/${REF}/g2`, `t/${REF}`, "t"]) {
          expect((await fsp.stat(join(f.root, path))).mode & 0o777).toBe(0o700);
          expect(io.events).toContainEqual({
            op: "sync:done",
            path: join(f.root, path),
          });
        }
        const fileSync = io.events.findIndex(
          (e) => e.op === "sync:done" && e.path.endsWith("/blob"),
        );
        const fileClose = io.events.findIndex(
          (e) => e.op === "close:done" && e.path.endsWith("/blob"),
        );
        const parentSync = io.events.findIndex(
          (e) => e.op === "sync:done" && e.path === join(f.root, `t/${REF}/g2`),
        );
        expect(fileSync).toBeGreaterThanOrEqual(0);
        expect(fileClose).toBeGreaterThan(fileSync);
        expect(parentSync).toBeGreaterThan(fileClose);
        expect(registry.snapshotUploads()).toEqual([]);
      } finally {
        await f.finish();
      }
    },
  );

  it.each([10485760, 10485761, 10485759])(
    "F08 exact 10MiB, declared+1 and short body (%i)",
    async (actual) => {
      const { f, storage } = await setup();
      try {
        await f.db.importSessionArtifact.update({
          where: { id: REF },
          data: { declaredBytes: 10485760, reservedBytes: 10485760 },
        });
        const bytes = Buffer.alloc(actual, 32);
        PDF.copy(bytes);
        const result = await outcome(
          f.track(
            storage.writeClaim(
              f.claim({ declaredBytes: 10485760 }),
              Readable.from(
                (function* () {
                  for (let at = 0; at < bytes.length; at += 65536)
                    yield bytes.subarray(at, at + 65536);
                })(),
              ),
              f.recheck,
            ),
          ),
        );
        const disk = await fsp.readFile(join(f.root, `t/${REF}/g2/blob`));
        if (actual === 10485760) {
          expect(result).toEqual({
            ok: true,
            value: {
              storageKey: `t/${REF}/g2/blob`,
              documentSha256: hash(bytes),
              verifiedBytes: actual,
              detectedFormat: "PDF",
            },
          });
          expect(disk.equals(bytes)).toBe(true);
        } else {
          expect(result).toMatchObject({
            ok: false,
            error: { kind: "SIZE_MISMATCH" },
          });
          expect(disk.length).toBeLessThanOrEqual(10485760);
        }
      } finally {
        await f.finish();
      }
    },
  );

  it.each([
    [
      "PNG declared PDF",
      "application/pdf",
      Buffer.from("89504e470d0a1a0a", "hex"),
    ],
    ["NUL text", "text/csv", Buffer.from("a\0b")],
    ["GIF", "image/png", Buffer.from("GIF89a")],
    ["HEIC", "image/jpeg", Buffer.from("\0\0\0\x18ftypheic")],
    ["empty", "text/plain", Buffer.alloc(0)],
    ["invalid declared MIME", "application/octet-stream", PDF],
  ] as const)(
    "F08 rejects unsupported content without false EMPTY success: %s",
    async (_name, mime, bytes) => {
      const { f, storage, registry } = await setup();
      try {
        const io = f.io();
        const recheck = jest.fn(f.recheck);
        const enter = jest.spyOn(registry, "enter");
        const claim = {
          ...f.claim(),
          // Only this synthetic out-of-union value crosses the typed capture boundary.
          declaredMime:
            mime === "application/octet-stream"
              ? (mime as VaultDeclaredMime)
              : mime,
          declaredBytes: Math.max(1, bytes.length),
        };
        const result = await outcome(
          f.track(storage.writeClaim(claim, Readable.from([bytes]), recheck)),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          if (mime === "application/octet-stream") {
            expect(result.error).toMatchObject({
              kind: "INVALID_CAPTURE",
              step: "capture",
            });
            expect(enter).not.toHaveBeenCalled();
            expect(recheck).not.toHaveBeenCalled();
            expect(registry.snapshotUploads()).toEqual([]);
            expect(io.events).toEqual([]);
            for (const operation of [
              fsp.open,
              fsp.mkdir,
              fsp.lstat,
              fsp.rename,
              fsp.rm,
              fsp.rmdir,
            ])
              expect(operation).not.toHaveBeenCalled();
          } else
            expect(result.error).toMatchObject({
              kind:
                bytes.length === 0 ? "SIZE_MISMATCH" : "UNSUPPORTED_DOCUMENT",
            });
        }
      } finally {
        await f.finish();
      }
    },
  );

  it.each(["existing", "symlink"] as const)(
    "F10 %s blob never becomes a writer target",
    async (mode) => {
      const { f, storage } = await setup();
      try {
        const outside = join(f.dir, "outside.pdf");
        await fsp.writeFile(outside, PDF, { mode: 0o600 });
        await fsp.mkdir(join(f.root, `t/${REF}/g2`), {
          recursive: true,
          mode: 0o700,
        });
        const blob = join(f.root, `t/${REF}/g2/blob`);
        if (mode === "existing")
          await fsp.writeFile(blob, PDF, { mode: 0o600 });
        else await fsp.symlink(outside, blob);
        await rejected(
          storage.writeClaim(f.claim(), Readable.from([PDF]), f.recheck),
        );
        expect(await fsp.readFile(outside)).toEqual(PDF);
        expect(await fsp.readFile(blob)).toEqual(PDF);
        expect(
          (
            await f.db.importSessionArtifact.findUniqueOrThrow({
              where: { id: REF },
            })
          ).reservedBytes,
        ).toBe(PDF.length);
      } finally {
        await f.finish();
      }
    },
  );

  it.each([
    "file-sync",
    "directory-sync",
    "file-close",
    "directory-close",
  ] as const)("F08/F14 real %s error is fail-closed", async (failure) => {
    const { f, storage, registry } = await setup();
    let failed = false;
    try {
      const inject = async (path: string, close: boolean) => {
        if (
          !failed &&
          failure.endsWith(close ? "close" : "sync") &&
          path.endsWith("/blob") === failure.startsWith("file")
        ) {
          failed = true;
          throw Object.assign(new Error("synthetic"), { code: "EIO" });
        }
      };
      const io = f.io({
        beforeSync: (path) => inject(path, false),
        beforeClose: (path) => inject(path, true),
      });
      await rejected(
        storage.writeClaim(f.claim(), Readable.from([PDF]), f.recheck),
        "FS_ERROR",
      );
      expect(failed).toBe(true);
      expect(
        (
          await f.db.importSessionArtifact.findUniqueOrThrow({
            where: { id: REF },
          })
        ).reservedBytes,
      ).toBe(PDF.length);
      if (failure.endsWith("close")) {
        const unclosed = [...io.owned].filter(([handle]) => handle.fd !== -1);
        if (unclosed.length)
          expect(registry.snapshotUploads()).toEqual([
            { ...OWNER, refId: REF },
          ]);
      }
    } finally {
      await f.finish();
    }
  });

  it("F11 A reader retains its lease until real close, even after consumer resolves", async () => {
    const { f, storage, registry } = await setup();
    const closing = f.gate(),
      release = f.gate();
    try {
      await f.seedArtifact();
      await f.db.importSessionArtifact.update({
        where: { id: REF },
        data: {
          state: "ATTACHED",
          artifactId: ART,
          verifiedAt: f.clock.now(),
          temporaryStorageKey: null,
          reservedBytes: 0,
        },
      });

      await f.writeBlob();
      f.io({
        beforeClose: async (path) => {
          if (path.endsWith("/blob")) {
            closing.release();
            await release.promise;
          }
        },
      });
      const read = outcome(
        f.track(
          storage.withArtifactReader(
            f.readCapture(),
            f.recheckRead,
            async (source) => {
              const bytes = await readAll(source);
              expect(bytes).toEqual(PDF);
              return hash(bytes);
            },
          ),
        ),
      );
      await bounded(closing.promise);
      expect(registry.snapshotUploads()).toEqual([]);
      registry.fence(`A:${ART}`);
      let drained = false;
      const drain = registry.abortAndDrain(`A:${ART}`, 1000);
      void drain.then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      await rejected(
        storage.withArtifactReader(f.readCapture(), f.recheckRead, readAll),
        "FENCED",
      );
      release.release();
      await bounded(read);
      expect(await bounded(drain)).toBe("DRAINED");
    } finally {
      release.release();
      registry.releaseFence(`A:${ART}`);
      await f.finish();
    }
  });

  it("F11 authorized reader returns actual disk bytes/hash without changing persistence", async () => {
    const { f, storage, registry } = await setup();
    try {
      await f.seedArtifact();
      await f.db.importSessionArtifact.update({
        where: { id: REF },
        data: {
          state: "ATTACHED",
          artifactId: ART,
          verifiedAt: f.clock.now(),
          temporaryStorageKey: null,
          reservedBytes: 0,
        },
      });
      await f.writeBlob();
      const before = await f.rows();
      const io = f.io();
      const read = await f.track(
        storage.withArtifactReader(
          f.readCapture(),
          f.recheckRead,
          async (source) => {
            const bytes = await readAll(source);
            return { bytes, sha256: hash(bytes) };
          },
        ),
      );
      expect(read).toEqual({
        bytes: PDF,
        sha256: hash(await fsp.readFile(join(f.root, `t/${REF}/g2/blob`))),
      });
      expect(
        io.events.filter((e) => e.op === "open" && e.path.endsWith("/blob")),
      ).toHaveLength(1);
      expect([...io.owned.keys()].every((handle) => handle.fd === -1)).toBe(
        true,
      );
      expect(registry.snapshotUploads()).toEqual([]);
      expect(await f.rows()).toEqual(before);
    } finally {
      await f.finish();
    }
  });

  it("error contract exposes bounded categories rather than private causes", () => {
    const IoError = loadIoError();
    const error = new IoError({
      kind: "FS_ERROR",
      step: "close-file",
      code: "EIO",
      closeCode: "EBADF",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      kind: "FS_ERROR",
      step: "close-file",
      code: "EIO",
      closeCode: "EBADF",
    });
    expect(JSON.stringify(error)).not.toMatch(
      /vault-qa-|\/Users\/|stack|synthetic private/,
    );
  });
});

async function timerSetup(idle: number) {
  const setupResult = await setup(idle);
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  const { f, storage } = setupResult;
  const started = f.gate(),
    proceed = f.gate();
  const source = new PassThrough();
  const claim = f.claim({ claimedAtMonotonicMs: performance.now() });
  const work = outcome(
    f.track(
      storage.writeClaim(claim, source, async (c) => {
        await f.recheck(c);
        started.release();
        await proceed.promise;
      }),
    ),
  );
  await bounded(started.promise);
  return { ...setupResult, started, proceed, source, claim, work };
}

describe("P05 claim-anchored wall/monotonic and idle deadlines", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("CONTROL real Prisma writer progresses with the selected fake clock", async () => {
    const f = await fixture();
    await f.seedRef();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      await jest.advanceTimersByTimeAsync(30);
      expect(
        await bounded(
          f.track(f.recheck(f.claim())),
          "Prisma recheck under fake clock",
        ),
      ).toBeUndefined();
    } finally {
      jest.runAllTicks();
      jest.useRealTimers();
      await f.finish();
    }
  });

  it.each(["entry", "recheck", "open"] as const)(
    "D03 delayed %s never restarts the claim allowance",
    async (phase) => {
      const { f, storage, registry } = await setup(120000);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      const gate = f.gate(),
        arrived = f.gate();
      const source = new PassThrough();
      try {
        const c = f.claim({ claimedAtMonotonicMs: performance.now() });
        if (phase === "entry") await jest.advanceTimersByTimeAsync(120000);
        const io = f.io({
          afterOpen: async (path) => {
            if (phase === "open" && path.endsWith("/blob")) {
              arrived.release();
              await gate.promise;
            }
          },
        });
        const work = outcome(
          f.track(
            storage.writeClaim(c, source, async (claim) => {
              await f.recheck(claim);
              if (phase === "recheck") {
                arrived.release();
                await gate.promise;
              }
            }),
          ),
        );
        if (phase !== "entry") {
          await bounded(arrived.promise);
          await jest.advanceTimersByTimeAsync(120000);
          gate.release();
        }
        source.end(PDF);
        expect(await bounded(work)).toMatchObject({
          ok: false,
          error: { kind: "DEADLINE_EXCEEDED" },
        });
        if (phase === "open")
          expect((await fsp.stat(join(f.root, `t/${REF}/g2/blob`))).size).toBe(
            0,
          );
        else
          expect(
            io.events.filter((e) => e.op === "open" || e.op === "mkdir"),
          ).toEqual([]);
        await rejected(
          storage.writeClaim(c, Readable.from([PDF]), f.recheck),
          "DEADLINE_EXCEEDED",
        );
        expect(registry.snapshotUploads()).toEqual([]);
      } finally {
        gate.release();
        source.destroy();
        jest.useRealTimers();
        await f.finish();
      }
    },
  );

  it.each(["rollback", "forward"] as const)(
    "D04 wall %s cannot extend the monotonic cap",
    async (mode) => {
      const { f, proceed, source, work } = await timerSetup(120000);
      try {
        f.clock.value = mode === "rollback" ? NOW - 3600000 : NOW + 120000;
        if (mode === "rollback") await jest.advanceTimersByTimeAsync(120000);
        proceed.release();
        source.end(PDF);
        expect(await bounded(work)).toMatchObject({
          ok: false,
          error: { kind: "DEADLINE_EXCEEDED" },
        });
      } finally {
        proceed.release();
        source.destroy();
        jest.useRealTimers();
        await f.finish();
      }
    },
  );

  it.each([
    "tokenExpiresAtMs",
    "uploadTokenExpiresAtMs",
    "uploadLeaseExpiresAtMs",
    "sessionExpiresAtMs",
  ] as const)("D03 minimum wall expiry includes %s", async (field) => {
    const { f, storage } = await setup(120000);
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      const c = f.claim({
        [field]: NOW + 30,
        claimedAtMonotonicMs: performance.now(),
      });
      await jest.advanceTimersByTimeAsync(30);
      await rejected(
        storage.writeClaim(c, Readable.from([PDF]), f.recheck),
        "DEADLINE_EXCEEDED",
      );
    } finally {
      jest.useRealTimers();
      await f.finish();
    }
  });

  it("F09 idle exactly at boundary survives, +1 expires, real handle closes", async () => {
    const { f, storage, registry } = await setup(1000);
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const opened = f.gate();
    const source = new PassThrough();
    let finished = false;
    try {
      const io = f.io({
        afterOpen: async (path) => {
          if (path.endsWith("/blob")) opened.release();
        },
      });
      const work = outcome(
        f.track(storage.writeClaim(f.claim(), source, f.recheck)),
      );
      void work.then(() => {
        finished = true;
      });
      await bounded(opened.promise);
      source.write(PDF);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000);
      expect(finished).toBe(false);
      expect(registry.snapshotUploads()).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(await bounded(work)).toMatchObject({
        ok: false,
        error: { kind: "IDLE_TIMEOUT" },
      });
      expect(
        io.events.some(
          (e) => e.op === "close:done" && e.path.endsWith("/blob"),
        ),
      ).toBe(true);
      expect(registry.snapshotUploads()).toEqual([]);
    } finally {
      source.destroy();
      jest.useRealTimers();
      await f.finish();
    }
  });

  function observeF09Progress(
    f: Awaited<ReturnType<typeof fixture>>,
    holdNativeWrite?: ReturnType<typeof f.gate>,
  ) {
    type WorkOutcome = Awaited<ReturnType<typeof outcome>>;
    const state: {
      second: number;
      targetBytes: number;
      acknowledgedBytes: number;
      claim?: VaultUploadClaim;
      outcome?: WorkOutcome;
      events: {
        phase: string;
        second: number;
        monotonicMs: number;
        wallMs: number;
        acknowledgedBytes: number;
        bytesWritten?: number;
      }[];
    } = { second: 0, targetBytes: 0, acknowledgedBytes: 0, events: [] };
    const started = f.gate();
    let pending:
      | { target: number; gate: ReturnType<typeof f.gate> }
      | undefined;
    let restoreWrite = () => {};
    const note = (phase: string, bytesWritten?: number) =>
      state.events.push({
        phase,
        second: state.second,
        monotonicMs: performance.now(),
        wallMs: f.clock.now().getTime(),
        acknowledgedBytes: state.acknowledgedBytes,
        bytesWritten,
      });
    const terminalFailure = (result: WorkOutcome): never => {
      if (!result.ok) throw result.error;
      throw new Error("F09 work succeeded before the expected native progress");
    };
    return {
      state,
      note,
      afterOpen: async (path: string, handle: FileHandle) => {
        if (!path.endsWith("/blob")) return;
        const nativeWrite = handle.write.bind(handle);
        const spy = jest
          .spyOn(handle, "write")
          .mockImplementation(async (...args) => {
            note("native-write-start");
            started.release();
            await holdNativeWrite?.promise;
            const result = await nativeWrite(...args);
            state.acknowledgedBytes += result.bytesWritten;
            note("native-write-complete", result.bytesWritten);
            if (pending && state.acknowledgedBytes >= pending.target)
              pending.gate.release();
            return result;
          });
        restoreWrite = () => spy.mockRestore();
      },
      track: (promise: Promise<unknown>) =>
        outcome(f.track(promise)).then((result) => {
          state.outcome = result;
          note("work-settled");
          return result;
        }),
      waitForNativeStart: (work: Promise<WorkOutcome>) =>
        bounded(
          Promise.race([started.promise, work.then(terminalFailure)]),
          "F09 native write start",
        ),
      async waitForBytes(target: number, work: Promise<WorkOutcome>) {
        state.targetBytes = target;
        note("await-native-progress");
        if (state.outcome) terminalFailure(state.outcome);
        if (state.acknowledgedBytes >= target) return;
        const gate = f.gate();
        pending = { target, gate };
        try {
          await bounded(
            Promise.race([
              gate.promise.then(() => {
                expect(state.acknowledgedBytes).toBeGreaterThanOrEqual(target);
              }),
              work.then(terminalFailure),
            ]),
            `F09 native bytes ${target}`,
          );
        } finally {
          pending = undefined;
        }
      },
      async finish(source: PassThrough, work?: Promise<WorkOutcome>) {
        holdNativeWrite?.release();
        source.destroy();
        try {
          if (work) await bounded(work, "F09 terminal work during cleanup");
        } finally {
          restoreWrite();
          jest.useRealTimers();
          try {
            await f.finish();
          } finally {
            await fsp.writeFile(
              join(f.dir, "f09-progress.json"),
              JSON.stringify(
                state,
                (_key, value) =>
                  value instanceof Error
                    ? {
                        ...value,
                        name: value.name,
                        message: value.message,
                        stack: value.stack,
                      }
                    : value,
                2,
              ),
              { mode: 0o600 },
            );
          }
        }
      },
    };
  }

  it("F09 nonempty progress renews only idle, never the 120s absolute deadline", async () => {
    const { f, storage } = await setup(2000);
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const source = new PassThrough();
    const progress = observeF09Progress(f);
    let work: ReturnType<typeof progress.track> | undefined;
    let settled = false;
    try {
      await f.db.importSessionArtifact.update({
        where: { id: REF },
        data: { declaredBytes: 10000, reservedBytes: 10000 },
      });
      const claim = f.claim({ declaredBytes: 10000 });
      progress.state.claim = claim;
      f.io({ afterOpen: progress.afterOpen });
      work = progress.track(storage.writeClaim(claim, source, f.recheck));
      void work.then(() => {
        settled = true;
      });
      source.write(PDF);
      await progress.waitForBytes(PDF.length, work);
      for (let second = 1; second < 120; second++) {
        progress.state.second = second;
        await jest.advanceTimersByTimeAsync(1000);
        source.write(" ");
        await progress.waitForBytes(PDF.length + second, work);
        expect(settled).toBe(false);
      }
      progress.state.second = 120;
      await jest.advanceTimersByTimeAsync(1000);
      expect(await bounded(work)).toMatchObject({
        ok: false,
        error: { kind: "DEADLINE_EXCEEDED" },
      });
    } finally {
      await progress.finish(source, work);
    }
  });

  it("F09 CONTROL queued producer bytes are not native progress while a write is withheld", async () => {
    const { f, storage, registry } = await setup(2000);
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const holdWrite = f.gate();
    const source = new PassThrough();
    const progress = observeF09Progress(f, holdWrite);
    let work: ReturnType<typeof progress.track> | undefined;
    try {
      await f.db.importSessionArtifact.update({
        where: { id: REF },
        data: { declaredBytes: 10000, reservedBytes: 10000 },
      });
      const claim = f.claim({ declaredBytes: 10000 });
      progress.state.claim = claim;
      const io = f.io({ afterOpen: progress.afterOpen });
      work = progress.track(storage.writeClaim(claim, source, f.recheck));
      source.write(PDF);
      await progress.waitForNativeStart(work);
      progress.state.second = 1;
      await jest.advanceTimersByTimeAsync(1000);
      source.write(" ");
      const waiting = outcome(
        f.track(progress.waitForBytes(PDF.length + 1, work)),
      );
      progress.note("producer-queued-while-native-withheld");
      expect(progress.state.acknowledgedBytes).toBe(0);
      expect((await fsp.stat(join(f.root, `t/${REF}/g2/blob`))).size).toBe(0);
      progress.state.second = 2;
      await jest.advanceTimersByTimeAsync(1000);
      expect(source.destroyed).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      progress.note("idle-boundary-plus-one");
      expect(source.destroyed).toBe(true);
      expect(progress.state.acknowledgedBytes).toBe(0);
      expect(progress.state.outcome).toBeUndefined();
      expect(registry.snapshotUploads()).toHaveLength(1);
      holdWrite.release();
      const result = await bounded(work);
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "IDLE_TIMEOUT" },
      });
      const acknowledgment = await bounded(waiting);
      expect(acknowledgment.ok).toBe(false);
      if (!result.ok && !acknowledgment.ok)
        expect(acknowledgment.error).toBe(result.error);
      expect(progress.state.acknowledgedBytes).toBe(PDF.length);
      expect((await fsp.stat(join(f.root, `t/${REF}/g2/blob`))).size).toBe(
        PDF.length,
      );
      expect(io.events).toContainEqual({
        op: "close:done",
        path: join(f.root, `t/${REF}/g2/blob`),
      });
      expect(registry.snapshotUploads()).toEqual([]);
    } finally {
      await progress.finish(source, work);
    }
  });

  it.each([120000, 4294967296])(
    "F09 idle %i never schedules an idle or overflowed timer",
    async (idle) => {
      const { f, storage } = await setup(idle);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      const opened = f.gate();
      const source = new PassThrough();
      const timers = jest.spyOn(global, "setTimeout");
      try {
        f.io({
          afterOpen: async (path) => {
            if (path.endsWith("/blob")) opened.release();
          },
        });
        const work = outcome(
          f.track(storage.writeClaim(f.claim(), source, f.recheck)),
        );
        await bounded(opened.promise);
        source.write(PDF);
        await jest.advanceTimersByTimeAsync(0);
        const delays = timers.mock.calls.map((call) => call[1]);
        expect(delays).not.toContain(4294967296);
        expect(delays.filter((delay) => delay === 120000)).toHaveLength(1);
        expect(
          delays.every(
            (delay) =>
              typeof delay === "number" && delay > 0 && delay <= 120000,
          ),
        ).toBe(true);
        source.end();
        expect(await bounded(work)).toMatchObject({ ok: true });
      } finally {
        source.destroy();
        // Clear the spy registry before uninstalling its fake clock.
        jest.restoreAllMocks();
        jest.useRealTimers();
        await f.finish();
      }
    },
  );
});
