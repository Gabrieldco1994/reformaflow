import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  ART,
  ART2,
  OWNER,
  PDF,
  REF,
  REF2,
  absent,
  bounded,
  errno,
  fixture,
  hash,
  loadPurger,
  loadRegistry,
  loadStorage,
  noDestruction,
  outcome,
  readAll,
  rejected,
  type Fixture,
} from "../../../test-utils/vault-foundation-harness";

async function setup(timeout = 1000) {
  const Purger = loadPurger(),
    Registry = loadRegistry(),
    Storage = loadStorage();
  const f = await fixture();
  const registry = new Registry();
  const storage = new Storage(f.boot, registry, f.clock);
  const purger = new Purger(f.db, f.clock, f.boot, registry, storage, timeout);
  const restart = () => {
    const r = new Registry();
    return new Purger(
      f.db,
      f.clock,
      f.boot,
      r,
      new Storage(f.boot, r, f.clock),
      timeout,
    );
  };
  return { f, registry, storage, purger, restart };
}
const refRow = (f: Fixture, id = REF) =>
  f.db.importSessionArtifact.findUniqueOrThrow({ where: { id } });
const artifactRow = (f: Fixture, id = ART) =>
  f.db.importArtifact.findUniqueOrThrow({ where: { id } });
async function pending(f: Fixture, id = REF) {
  await f.seedRef(id, {
    state: "FAILED",
    temporaryPurgePending: true,
    uploadGeneration: 3,
    uploadLeaseExpiresAt: null,
  });
  await f.writeBlob(`t/${id}/g2/blob`);
}
const sourceFor = (kind: "ref" | "artifact") =>
  kind === "ref" ? `t/${REF}` : `t/${REF}/g2`;
const trashFor = (kind: "ref" | "artifact") =>
  kind === "ref" ? `trash/r-${REF}` : `trash/a-${ART}-${REF}-g2`;
async function assertCharged(f: Fixture, kind: "ref" | "artifact") {
  if (kind === "ref")
    expect(await refRow(f)).toMatchObject({
      temporaryStorageKey: `t/${REF}`,
      temporaryPurgePending: true,
      reservedBytes: PDF.length,
    });
  else
    expect(await artifactRow(f)).toMatchObject({
      state: "PURGING",
      storageKey: `t/${REF}/g2/blob`,
      verifiedBytes: PDF.length,
      documentSha256: hash(PDF),
    });
}
async function assertReleased(f: Fixture, kind: "ref" | "artifact") {
  if (kind === "ref")
    expect(await refRow(f)).toMatchObject({
      temporaryStorageKey: null,
      temporaryPurgePending: false,
      reservedBytes: 0,
      state: "FAILED",
    });
  else
    expect(await artifactRow(f)).toMatchObject({
      state: "PURGED",
      storageKey: null,
      verifiedBytes: PDF.length,
      documentSha256: hash(PDF),
    });
  await absent(join(f.root, sourceFor(kind)));
  await absent(join(f.root, trashFor(kind)));
}

describe("P05 independent coalesced purger contract: real SQLite and physical effects", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("CONTROL close-error snapshot precedes actual bound close and preserves charged SQLite/FS", async () => {
    const f = await fixture();
    try {
      await pending(f);
      const io = f.io({
        beforeClose: async () => {
          throw errno("EIO");
        },
      });
      const handle = await fsp.open(join(f.root, "trash"), "r");
      await expect(handle.close()).rejects.toMatchObject({ code: "EIO" });
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      await assertCharged(f, "ref");
      const eventsBeforeCopy = [...io.events];
      await f.snapshot("failed-close", true);
      expect(
        io.events
          .slice(eventsBeforeCopy.length)
          .every((event) => event.op === "lstat"),
      ).toBe(true);
      expect(await fsp.readFile(join(f.dir, "failed-close.db"))).toEqual(
        await fsp.readFile(join(f.dir, "test.db")),
      );
      expect(
        await fsp.readFile(join(f.dir, `failed-close-vault/t/${REF}/g2/blob`)),
      ).toEqual(PDF);
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      await bounded(io.closeRemaining(), "instrument bound close");
      expect(handle.fd).toBe(-1);
      expect(io.events).toContainEqual({
        op: "cleanup:real-close",
        path: join(f.root, "trash"),
      });
      expect(io.events.filter((event) => event.op === "close:done")).toEqual(
        [],
      );
      await assertCharged(f, "ref");
    } finally {
      await f.finish();
      expect(f.borrowedLock.fd).toBe(-1);
    }
  });

  it("F05/D01/D02 timeout unfences memory, retains live FD/slot/bytes, rejects fresh FS and coalesces a NEW retry", async () => {
    const { f, registry, storage, purger } = await setup(40);
    const closing = f.gate(),
      closeGate = f.gate(),
      retryDraining = f.gate();
    try {
      await f.seedRef();
      const claim = f.claim();
      const io = f.io({
        beforeClose: async (path) => {
          if (path.endsWith("/blob")) {
            closing.release();
            await closeGate.promise;
          }
        },
      });
      const admitted: ReturnType<typeof registry.enter>[] = [];
      const enter = registry.enter.bind(registry);
      jest.spyOn(registry, "enter").mockImplementation((key, owner) => {
        const value = enter(key, owner);
        admitted.push(value);
        return value;
      });
      const write = outcome(
        f.track(storage.writeClaim(claim, Readable.from([PDF]), f.recheck)),
      );
      await bounded(closing.promise);
      const original = admitted[0];
      expect(original?.ok).toBe(true);
      if (!original.ok) throw new Error("writer did not admit");
      let done = false;
      void original.lease.done.then(() => {
        done = true;
      });
      await f.locked(async (tx) => {
        await tx.importSessionArtifact.update({
          where: { id: REF },
          data: {
            state: "FAILED",
            uploadGeneration: 3,
            temporaryPurgePending: true,
            uploadLeaseExpiresAt: null,
          },
        });
      });
      const first = purger.purge(f.target());
      expect(purger.purge(f.target())).toBe(first);
      expect(await bounded(first)).toBe("DRAIN_TIMEOUT");
      expect(original.lease.signal.aborted).toBe(true);
      expect(done).toBe(false);
      expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF }]);
      expect([...io.owned.keys()].some((h) => h.fd >= 0)).toBe(true);
      await assertCharged(f, "ref");
      expect(await refRow(f)).toMatchObject({
        state: "FAILED",
        uploadGeneration: 3,
        uploadLeaseExpiresAt: null,
      });
      noDestruction(io.events);

      const reopened = registry.enter(`R:${REF}`, OWNER);
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) throw new Error("timeout left memory fence");
      reopened.lease.exit();
      const before = io.events.length;
      const recheck = jest.fn(f.recheck);
      await rejected(storage.writeClaim(claim, Readable.from([PDF]), recheck));
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(io.events.slice(before)).toEqual([]);
      expect(done).toBe(false);
      expect(registry.snapshotUploads()).toHaveLength(1);

      const drain = registry.abortAndDrain.bind(registry);
      jest
        .spyOn(registry, "abortAndDrain")
        .mockImplementation((key, timeout) => {
          retryDraining.release();
          return drain(key, timeout);
        });
      const retry = purger.purge(f.target());
      expect(retry).not.toBe(first);
      expect(purger.purge(f.target())).toBe(retry);
      await bounded(retryDraining.promise);
      expect(purger.purge(f.target())).toBe(retry);
      closeGate.release();
      await bounded(write);
      expect(await bounded(retry)).toBe("PURGED");
      expect(done).toBe(true);
      expect(registry.snapshotUploads()).toEqual([]);
      expect(io.events.filter((e) => e.op === "rename:done")).toHaveLength(1);
      await assertReleased(f, "ref");
    } finally {
      closeGate.release();
      await f.finish();
    }
  });

  it("F06 same-key valid callers receive identical Promise and one physical/release operation", async () => {
    const { f, registry, purger } = await setup();
    const renamed = f.gate(),
      gate = f.gate();
    try {
      await pending(f);
      const io = f.io({
        afterRename: async () => {
          renamed.release();
          await gate.promise;
        },
      });
      const fence = jest.spyOn(registry, "fence");
      const release = jest.spyOn(registry, "releaseFence");
      const first = f.track(purger.purge(f.target()));
      expect(purger.purge(f.target())).toBe(first);
      await bounded(renamed.promise);
      expect(purger.purge({ ...f.target() })).toBe(first);
      await assertCharged(f, "ref");
      await rejected(
        Promise.resolve().then(() =>
          purger.purge({ ...f.target(), tenantId: "foreign-t" }),
        ),
      );
      expect(fence).toHaveBeenCalledTimes(1);
      gate.release();
      expect(await bounded(first)).toBe("PURGED");
      expect(io.events.filter((e) => e.op === "rename:done")).toHaveLength(1);
      expect(io.events.filter((e) => e.op === "rm:done")).toHaveLength(1);
      expect(release).toHaveBeenCalledTimes(1);
      await assertReleased(f, "ref");
    } finally {
      gate.release();
      await f.finish();
    }
  });

  it("F07 stalled real close on one key does not stop a different key", async () => {
    const { f, storage, purger, registry } = await setup();
    const closing = f.gate(),
      closeGate = f.gate(),
      draining = f.gate();
    try {
      await f.seedRef();
      await pending(f, REF2);
      const io = f.io({
        beforeClose: async (path) => {
          if (path === join(f.root, `t/${REF}/g2/blob`)) {
            closing.release();
            await closeGate.promise;
          }
        },
      });
      const write = outcome(
        f.track(storage.writeClaim(f.claim(), Readable.from([PDF]), f.recheck)),
      );
      await bounded(closing.promise);
      f.clock.value += 120001;
      const original = registry.abortAndDrain.bind(registry);
      jest
        .spyOn(registry, "abortAndDrain")
        .mockImplementation((key, timeout) => {
          const p = original(key, timeout);
          if (key === `R:${REF}`) draining.release();
          return p;
        });
      const a = f.track(purger.purge(f.target()));
      await bounded(draining.promise);
      const b = purger.purge(f.target("ref", REF2));
      expect(await bounded(b)).toBe("PURGED");
      expect((await refRow(f, REF2)).reservedBytes).toBe(0);
      await assertCharged(f, "ref");
      expect(
        io.events.filter((e) => e.op === "rename:done").map((e) => e.path),
      ).toEqual([join(f.root, `t/${REF2}`)]);
      closeGate.release();
      await bounded(write);
      expect(await bounded(a)).toBe("PURGED");
    } finally {
      closeGate.release();
      await f.finish();
    }
  });

  it("F11 artifact purge waits for actual A reader close after reference release", async () => {
    const { f, registry, storage, purger } = await setup();
    const closing = f.gate(),
      closeGate = f.gate(),
      draining = f.gate();
    try {
      await f.seedArtifact();
      await f.seedRef(REF, {
        state: "ATTACHED",
        artifactId: ART,
        temporaryStorageKey: null,
        reservedBytes: 0,
      });
      await f.writeBlob();
      const io = f.io({
        beforeClose: async (path) => {
          if (path.endsWith("/blob")) {
            closing.release();
            await closeGate.promise;
          }
        },
      });
      const read = outcome(
        f.track(
          storage.withArtifactReader(
            f.readCapture(),
            f.recheckRead,
            async (source) => {
              expect(await readAll(source)).toEqual(PDF);
              return "consumed";
            },
          ),
        ),
      );
      await bounded(closing.promise);
      await f.locked(async (tx) => {
        await tx.importSessionArtifact.update({
          where: { id: REF },
          data: { state: "RELEASED", releasedAt: f.clock.now() },
        });
      });
      const drain = registry.abortAndDrain.bind(registry);
      jest
        .spyOn(registry, "abortAndDrain")
        .mockImplementation((key, timeout) => {
          const work = drain(key, timeout);
          draining.release();
          return work;
        });
      const purge = f.track(purger.purge(f.target("artifact")));
      await bounded(draining.promise);
      noDestruction(io.events);
      await assertCharged(f, "artifact");
      await rejected(
        storage.withArtifactReader(f.readCapture(), f.recheckRead, readAll),
        "FENCED",
      );
      closeGate.release();
      await bounded(read);
      expect(await bounded(purge)).toBe("PURGED");
      const close = io.events.findIndex(
        (e) => e.op === "close:done" && e.path.endsWith("/blob"),
      );
      expect(
        io.events.findIndex((e) => e.op === "rename:start"),
      ).toBeGreaterThan(close);
    } finally {
      closeGate.release();
      await f.finish();
    }
  });

  it.each(["ref", "artifact"] as const)(
    "F12 %s generation changes during drain/after rename cannot alter captured paths or refund predicate",
    async (kind) => {
      const { f, registry, purger } = await setup();
      const draining = f.gate(),
        gate = f.gate();
      try {
        if (kind === "ref") await pending(f);
        else {
          await f.seedArtifact();
          await f.writeBlob();
        }
        const bump = () =>
          kind === "ref"
            ? f.db.importSessionArtifact.update({
                where: { id: REF },
                data: { uploadGeneration: { increment: 7 } },
              })
            : f.db.importArtifact.update({
                where: { id: ART },
                data: { parseGeneration: { increment: 7 } },
              });
        const original = registry.abortAndDrain.bind(registry);
        jest
          .spyOn(registry, "abortAndDrain")
          .mockImplementation(async (key, timeout) => {
            const result = await original(key, timeout);
            draining.release();
            await gate.promise;
            return result;
          });
        const io = f.io({
          afterRename: async () => {
            await bump();
          },
        });
        const work = f.track(purger.purge(f.target(kind)));
        await bounded(draining.promise);
        await bump();
        gate.release();
        expect(await bounded(work)).toBe("PURGED");
        expect(io.events.filter((e) => e.op === "rename:done")).toEqual([
          {
            op: "rename:done",
            path: join(f.root, sourceFor(kind)),
            to: join(f.root, trashFor(kind)),
          },
        ]);
        await assertReleased(f, kind);
        expect(
          kind === "ref"
            ? (await refRow(f)).uploadGeneration
            : (await artifactRow(f)).parseGeneration,
        ).toBeGreaterThanOrEqual(14);
      } finally {
        gate.release();
        await f.finish();
      }
    },
  );

  it.each(
    (["ref", "artifact"] as const).flatMap((kind) => [
      { kind, source: true, trash: false },
      { kind, source: false, trash: true },
      { kind, source: false, trash: false },
      { kind, source: true, trash: true },
    ]),
  )(
    "F13 synthetic restart $kind source=$source trash=$trash",
    async ({ kind, source, trash }) => {
      const { f, restart } = await setup();
      try {
        if (kind === "ref")
          await f.seedRef(REF, {
            state: "FAILED",
            uploadGeneration: 9,
            temporaryPurgePending: true,
          });
        else
          await f.seedArtifact(ART, REF, {
            state: "PURGING",
            parseGeneration: 51,
          });
        if (source) await f.writeBlob();
        if (trash)
          await f.writeBlob(
            `${trashFor(kind)}/${kind === "ref" ? "g2/" : ""}blob`,
          );
        const before = await f.rows();
        const io = f.io();
        const result = await outcome(restart().purge(f.target(kind)));
        if (source && trash) {
          expect(result.ok).toBe(false);
          noDestruction(io.events);
          expect(await f.rows()).toEqual(before);
          expect(await fsp.readFile(join(f.root, `t/${REF}/g2/blob`))).toEqual(
            PDF,
          );
          expect(
            await fsp.readFile(
              join(
                f.root,
                `${trashFor(kind)}/${kind === "ref" ? "g2/" : ""}blob`,
              ),
            ),
          ).toEqual(PDF);
        } else {
          expect(result).toEqual({ ok: true, value: "PURGED" });
          await assertReleased(f, kind);
          expect(io.events.filter((e) => e.op === "rename:done")).toHaveLength(
            source ? 1 : 0,
          );
          for (const key of ["t", "trash"])
            expect(io.events).toContainEqual({
              op: "sync:done",
              path: join(f.root, key),
            });
          for (const key of [sourceFor(kind), trashFor(kind)])
            expect(io.events).toContainEqual({
              op: "lstat",
              path: join(f.root, key),
            });
        }
      } finally {
        await f.finish();
      }
    },
  );

  it.each(
    (["after-rename", "after-remove", "close-directory"] as const).flatMap(
      (stage) =>
        (["same-coordinator", "restart"] as const).map((mode) => ({
          stage,
          mode,
        })),
    ),
  )(
    "F14 failed durability $stage retains charge; $mode retry re-establishes physical proof",
    async ({ stage, mode }) => {
      const { f, registry, purger, restart } = await setup();
      const retryDraining = f.gate(),
        retryGate = f.gate();
      let renamed = false,
        removed = false,
        injected = false;
      try {
        await pending(f);
        const fail = async (path: string, close: boolean) => {
          if (
            !injected &&
            path === join(f.root, "trash") &&
            (stage === "after-rename"
              ? renamed && !close
              : stage === "after-remove"
                ? removed && !close
                : renamed && close)
          ) {
            injected = true;
            throw errno("EIO");
          }
        };
        const io = f.io({
          afterRename: async () => {
            renamed = true;
          },
          afterRemove: async () => {
            removed = true;
          },
          beforeSync: (path) => fail(path, false),
          beforeClose: (path) => fail(path, true),
        });
        const failedOperation = purger.purge(f.target());
        await rejected(failedOperation, "FS_ERROR");
        expect(injected).toBe(true);
        await assertCharged(f, "ref");
        await f.snapshot("failure", true);
        const admission = registry.enter(`R:${REF}`, OWNER);
        expect(admission.ok).toBe(true);
        if (!admission.ok)
          throw new Error("operational error retained memory fence");
        admission.lease.exit();
        if (stage === "close-directory") {
          expect(
            [...io.owned.values()].some(
              (entry) => entry.path === join(f.root, "trash"),
            ),
          ).toBe(true);
          await bounded(
            io.closeRemaining(),
            "failed operation bound original closes",
          );
          expect([...io.owned.keys()].every((handle) => handle.fd === -1)).toBe(
            true,
          );
          await assertCharged(f, "ref");
          await f.snapshot("old-handles-closed");
        }
        if (mode === "same-coordinator") {
          const drain = registry.abortAndDrain.bind(registry);
          jest
            .spyOn(registry, "abortAndDrain")
            .mockImplementation(async (key, timeout) => {
              const result = await drain(key, timeout);
              retryDraining.release();
              await retryGate.promise;
              return result;
            });
        }
        const beforeRetry = io.events.length;
        const coordinator = mode === "same-coordinator" ? purger : restart();
        const retryOperation = f.track(coordinator.purge(f.target()));
        expect(retryOperation).not.toBe(failedOperation);
        expect(coordinator.purge(f.target())).toBe(retryOperation);
        if (mode === "same-coordinator") {
          await bounded(retryDraining.promise);
          expect(coordinator.purge(f.target())).toBe(retryOperation);
          await assertCharged(f, "ref");
        }
        retryGate.release();
        expect(await bounded(retryOperation)).toBe("PURGED");
        const retry = io.events.slice(beforeRetry);
        expect(retry).toContainEqual({
          op: "sync:done",
          path: join(f.root, "trash"),
        });
        expect(retry).toContainEqual({
          op: "lstat",
          path: join(f.root, sourceFor("ref")),
        });
        expect(retry).toContainEqual({
          op: "lstat",
          path: join(f.root, trashFor("ref")),
        });
        await assertReleased(f, "ref");
      } finally {
        retryGate.release();
        await f.finish();
      }
    },
  );

  it.each(["ref", "artifact"] as const)(
    "F15 %s charge falls only after both absence proofs and durability; neighbor/witness survive",
    async (kind) => {
      const { f, storage, purger } = await setup();
      const renamed = f.gate(),
        removeGate = f.gate(),
        erased = f.gate(),
        releaseGate = f.gate();
      try {
        if (kind === "ref") await pending(f);
        else {
          await f.seedArtifact();
          await f.writeBlob();
        }
        await f.seedArtifact(ART2, REF2);
        await f.writeBlob(
          `t/${REF2}/g2/blob`,
          Buffer.from("retained sibling bytes"),
        );
        await f.db.importSession.update({
          where: { id: "qa-session" },
          data: { receiptJson: '{"retained":"financial-witness"}' },
        });
        const neighbor = await artifactRow(f, ART2);
        const witness = (await f.rows()).sessions;
        const io = f.io({
          beforeSync: async (path) => {
            if (kind === "artifact" && path === join(f.root, `t/${REF}`))
              expect((await fsp.lstat(path)).isDirectory()).toBe(true);
          },
          afterRename: async () => {
            renamed.release();
            await removeGate.promise;
          },
        });
        const erase = storage.eraseCaptured.bind(storage);
        jest
          .spyOn(storage, "eraseCaptured")
          .mockImplementation(async (capture) => {
            await erase(capture);
            erased.release();
            await releaseGate.promise;
          });
        const work = f.track(purger.purge(f.target(kind)));
        await bounded(renamed.promise);
        await assertCharged(f, kind);
        await absent(join(f.root, sourceFor(kind)));
        expect(
          (await fsp.lstat(join(f.root, trashFor(kind)))).isDirectory(),
        ).toBe(true);
        removeGate.release();
        await bounded(erased.promise);
        await assertCharged(f, kind);
        await absent(join(f.root, sourceFor(kind)));
        await absent(join(f.root, trashFor(kind)));
        const removal = io.events.findIndex((e) => e.op === "rm:done");
        expect(removal).toBeGreaterThanOrEqual(0);
        const afterRemoval = io.events.slice(removal + 1);
        for (const key of [sourceFor(kind), trashFor(kind)])
          expect(afterRemoval).toContainEqual({
            op: "lstat",
            path: join(f.root, key),
          });
        expect(afterRemoval).toContainEqual({
          op: "sync:done",
          path: join(f.root, "trash"),
        });
        if (kind === "artifact") {
          const owner = join(f.root, `t/${REF}`);
          const renamedAt = io.events.findIndex(
            (event) => event.op === "rename:done",
          );
          const ownerSync = io.events.findIndex(
            (event, index) =>
              index > renamedAt &&
              event.op === "sync:done" &&
              event.path === owner,
          );
          const ownerClose = io.events.findIndex(
            (event, index) =>
              index > ownerSync &&
              event.op === "close:done" &&
              event.path === owner,
          );
          const ownerRemove = io.events.findIndex(
            (event) => event.op === "rmdir" && event.path === owner,
          );
          const ownerRemoved = io.events.findIndex(
            (event) => event.op === "rmdir:done" && event.path === owner,
          );
          const tSync = io.events.findIndex(
            (event, index) =>
              index > ownerRemoved &&
              event.op === "sync:done" &&
              event.path === join(f.root, "t"),
          );
          expect(renamedAt).toBeGreaterThanOrEqual(0);
          expect(ownerSync).toBeGreaterThan(renamedAt);
          expect(ownerClose).toBeGreaterThan(ownerSync);
          expect(ownerRemove).toBeGreaterThan(ownerClose);
          expect(ownerRemoved).toBeGreaterThan(ownerRemove);
          expect(tSync).toBeGreaterThan(ownerRemoved);
          await absent(owner);
          await assertCharged(f, "artifact");
        }
        releaseGate.release();
        expect(await bounded(work)).toBe("PURGED");
        await assertReleased(f, kind);
        expect(await artifactRow(f, ART2)).toEqual(neighbor);
        expect((await f.rows()).sessions).toEqual(witness);
        expect(await fsp.readFile(join(f.root, `t/${REF2}/g2/blob`))).toEqual(
          Buffer.from("retained sibling bytes"),
        );
      } finally {
        removeGate.release();
        releaseGate.release();
        await f.finish();
      }
    },
  );

  it.each(["DRAFT", "APPLIED", "EXPIRED"] as const)(
    "F16 ATTACHED in %s expired session blocks A until explicit release; adopting R is ineligible",
    async (state) => {
      const { f, purger } = await setup();
      try {
        await f.seedArtifact();
        await f.seedRef(REF, {
          state: "ATTACHED",
          artifactId: ART,
          temporaryStorageKey: null,
          reservedBytes: 0,
        });
        await f.writeBlob();
        await f.db.importSession.update({
          where: { id: "qa-session" },
          data: {
            state,
            expiresAt: new Date(f.clock.value - 1),
            receiptJson: '{"retained":"witness"}',
            ...(state === "APPLIED"
              ? {
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
        const before = await f.rows();
        const io = f.io();
        expect(await bounded(purger.purge(f.target("artifact")))).toBe(
          "NOT_ELIGIBLE",
        );
        expect(await bounded(purger.purge(f.target()))).toBe("NOT_ELIGIBLE");
        expect(await f.rows()).toEqual(before);
        noDestruction(io.events);
        await f.db.importSessionArtifact.update({
          where: { id: REF },
          data: { state: "RELEASED", releasedAt: f.clock.now() },
        });
        expect(await bounded(purger.purge(f.target("artifact")))).toBe(
          "PURGED",
        );
        expect((await f.rows()).sessions).toEqual(before.sessions);
      } finally {
        await f.finish();
      }
    },
  );

  it("F16 a separately charged duplicate temporary is removable without changing its ATTACHED reference", async () => {
    const { f, purger } = await setup();
    try {
      await f.seedArtifact(ART, REF2);
      await f.seedRef(REF, {
        state: "ATTACHED",
        artifactId: ART,
        temporaryPurgePending: true,
        verifiedAt: f.clock.now(),
      });
      await f.writeBlob();
      await f.writeBlob(`t/${REF2}/g2/blob`);
      const artifact = await artifactRow(f);
      expect(await bounded(purger.purge(f.target()))).toBe("PURGED");
      expect(await refRow(f)).toMatchObject({
        state: "ATTACHED",
        artifactId: ART,
        temporaryStorageKey: null,
        reservedBytes: 0,
        verifiedAt: f.clock.now(),
      });
      expect(await artifactRow(f)).toEqual(artifact);
      expect(await fsp.readFile(join(f.root, `t/${REF2}/g2/blob`))).toEqual(
        PDF,
      );
    } finally {
      await f.finish();
    }
  });

  it.each(["ref", "artifact"] as const)(
    "F16 %s foreign tenant/project cannot select or release a real owner's object",
    async (kind) => {
      const { f, purger } = await setup();
      try {
        if (kind === "ref") await pending(f);
        else {
          await f.seedArtifact();
          await f.writeBlob();
        }
        const before = await f.rows();
        const io = f.io();
        for (const extra of [
          { tenantId: "foreign-t" },
          { ownerProjectId: "other-p" },
        ]) {
          const result = await outcome(
            purger.purge({ ...f.target(kind), ...extra }),
          );
          expect(result.ok && result.value === "PURGED").toBe(false);
        }
        expect(await f.rows()).toEqual(before);
        noDestruction(io.events);
        expect(await fsp.readFile(join(f.root, `t/${REF}/g2/blob`))).toEqual(
          PDF,
        );
      } finally {
        await f.finish();
      }
    },
  );

  it("F17 zero-reference artifact still fences PURGING and is physically purged", async () => {
    const { f, purger, registry } = await setup();
    const draining = f.gate(),
      gate = f.gate();
    try {
      await f.seedArtifact();
      await f.writeBlob();
      expect(await f.db.importSessionArtifact.count()).toBe(0);
      const original = registry.abortAndDrain.bind(registry);
      jest
        .spyOn(registry, "abortAndDrain")
        .mockImplementation(async (key, timeout) => {
          const result = await original(key, timeout);
          draining.release();
          await gate.promise;
          return result;
        });
      const work = f.track(purger.purge(f.target("artifact")));
      await bounded(draining.promise);
      expect(await artifactRow(f)).toMatchObject({
        state: "PURGING",
        parseGeneration: 1,
        storageKey: `t/${REF}/g2/blob`,
      });
      gate.release();
      expect(await bounded(work)).toBe("PURGED");
      await assertReleased(f, "artifact");
    } finally {
      gate.release();
      await f.finish();
    }
  });

  it("F18 stale captured storage key cannot release or touch a readopted incarnation", async () => {
    const { f, registry, purger } = await setup();
    const draining = f.gate(),
      gate = f.gate();
    try {
      await f.seedArtifact();
      await f.writeBlob();
      await f.writeBlob(`t/${REF2}/g7/blob`, Buffer.from("new incarnation"));
      const original = registry.abortAndDrain.bind(registry);
      jest
        .spyOn(registry, "abortAndDrain")
        .mockImplementation(async (key, timeout) => {
          const result = await original(key, timeout);
          draining.release();
          await gate.promise;
          return result;
        });
      const io = f.io();
      const work = f.track(purger.purge(f.target("artifact")));
      await bounded(draining.promise);
      await f.db.importArtifact.update({
        where: { id: ART },
        data: {
          state: "RAW_READY",
          storageKey: `t/${REF2}/g7/blob`,
          documentSha256: hash(Buffer.from("new incarnation")),
          verifiedBytes: 15,
        },
      });
      const readopted = await artifactRow(f);
      gate.release();
      expect(await bounded(work)).toBe("STALE_CAPTURE");
      expect(await artifactRow(f)).toEqual(readopted);
      noDestruction(io.events);
      expect(await fsp.readFile(join(f.root, `t/${REF2}/g7/blob`))).toEqual(
        Buffer.from("new incarnation"),
      );
    } finally {
      gate.release();
      await f.finish();
    }
  });

  it.each([
    "malformed",
    "wrong-owner",
    "symlink",
    "ENOTDIR",
    "EACCES",
  ] as const)(
    "F19 invalid owned path %s fails closed, keeps charge, never deletes external objects",
    async (mode) => {
      const { f, purger } = await setup();
      try {
        await pending(f);
        const outside = join(f.dir, "outside");
        await fsp.mkdir(outside, { mode: 0o700 });
        await fsp.writeFile(join(outside, "witness"), PDF, { mode: 0o600 });
        if (mode === "malformed" || mode === "wrong-owner") {
          await f.db.importSessionArtifact.update({
            where: { id: REF },
            data: {
              temporaryStorageKey:
                mode === "malformed" ? "../outside" : `t/${REF2}`,
            },
          });
        } else if (mode === "symlink") {
          await fsp.rename(
            join(f.root, `t/${REF}`),
            join(f.dir, "preserved-original"),
          );
          await fsp.symlink(outside, join(f.root, `t/${REF}`));
        }
        const before = await refRow(f);
        const io = f.io({
          beforeLstat: async (path) => {
            if (
              (mode === "ENOTDIR" || mode === "EACCES") &&
              path === join(f.root, `t/${REF}`)
            )
              throw errno(mode);
          },
        });
        await rejected(purger.purge(f.target()));
        expect(await refRow(f)).toMatchObject({
          reservedBytes: before.reservedBytes,
          temporaryStorageKey: before.temporaryStorageKey,
          temporaryPurgePending: true,
        });
        noDestruction(io.events);
        expect(await fsp.readFile(join(outside, "witness"))).toEqual(PDF);
      } finally {
        await f.finish();
      }
    },
  );

  it("F19 unknown trash has no inferred owner and is left untouched", async () => {
    const { f, purger } = await setup();
    try {
      await f.writeBlob(`trash/r-${REF}/g2/blob`);
      const io = f.io();
      // NOT_ELIGIBLE is an explicit per-target report; no orphan scanner is requested.
      expect(await bounded(purger.purge(f.target()))).toBe("NOT_ELIGIBLE");
      noDestruction(io.events);
      expect(
        await fsp.readFile(join(f.root, `trash/r-${REF}/g2/blob`)),
      ).toEqual(PDF);
      expect(await f.db.importSessionArtifact.count()).toBe(0);
    } finally {
      await f.finish();
    }
  });

  it("F20 writer lock precedes scoped membership reads; a committed competing attachment is re-read", async () => {
    const { f, purger } = await setup();
    const { PrismaService } = await import("../../../prisma/prisma.service");
    const competitor = new PrismaService();
    const lockAttempt = f.gate(),
      allowLock = f.gate();
    let armed = true;
    const trace: {
      model?: string;
      action: string;
      args: unknown;
      tx: boolean;
    }[] = [];
    try {
      await f.seedArtifact();
      await f.writeBlob();
      await bounded(
        competitor.$connect(),
        "competing connection before writer",
      );
      const transaction = f.db.$transaction.bind(f.db);
      jest
        .spyOn(f.db, "$transaction")
        .mockImplementation(async (callback, options) => {
          if (armed) {
            armed = false;
            lockAttempt.release();
            await allowLock.promise;
          }
          return transaction(callback, options);
        });
      f.db.$use(async (params, next) => {
        trace.push({
          model: params.model,
          action: params.action,
          args: params.args,
          tx: params.runInTransaction,
        });
        return next(params);
      });
      const io = f.io();
      const work = f.track(purger.purge(f.target("artifact")));
      await bounded(lockAttempt.promise);
      expect(trace).toEqual([]);
      // Hold before BEGIN: an open SQLite interactive transaction already blocks another writer.
      try {
        await bounded(
          competitor.importSessionArtifact.create({
            data: {
              id: REF,
              tenantId: OWNER.tenantId,
              ownerProjectId: OWNER.ownerProjectId,
              sessionId: "qa-session",
              artifactId: ART,
              position: 0,
              fileName: "fixture.pdf",
              declaredMime: "application/pdf",
              declaredBytes: PDF.length,
              state: "ATTACHED",
              verifiedAt: f.clock.now(),
              reservedBytes: 0,
              temporaryStorageKey: null,
            },
          }),
          "competing attachment commit",
        );
      } finally {
        allowLock.release();
      }
      expect(await bounded(work)).toBe("NOT_ELIGIBLE");
      expect(trace[0]).toMatchObject({ action: "executeRaw", tx: true });
      expect(JSON.stringify(trace[0].args)).toMatch(
        /UPDATE tenants SET id\s*=\s*id/,
      );
      noDestruction(io.events);
      const reads = trace.filter(
        (entry) =>
          entry.model === "ImportArtifact" ||
          entry.model === "ImportSessionArtifact",
      );
      expect(reads.length).toBeGreaterThan(0);
      for (const entry of reads) {
        expect(entry.tx).toBe(true);
        const serialized = JSON.stringify(entry.args);
        expect(serialized).toContain(OWNER.tenantId);
        expect(serialized).toContain(OWNER.ownerProjectId);
      }
    } finally {
      allowLock.release();
      await competitor.$disconnect();
      await f.finish();
    }
  });

  it("F20 destructive FS completes outside cleanup transaction and without fabricated request authorization", async () => {
    const { f, storage, purger } = await setup();
    try {
      await pending(f);
      let observed = 0;
      const erase = storage.eraseCaptured.bind(storage);
      jest
        .spyOn(storage, "eraseCaptured")
        .mockImplementation(async (capture) => {
          const { PrismaService } =
            await import("../../../prisma/prisma.service");
          const observer = new PrismaService();
          try {
            await observer.$connect();
            await bounded(
              observer.$transaction(async (tx) => {
                await tx.$executeRaw`UPDATE tenants SET id = id WHERE id = ${OWNER.tenantId}`;
                const row = await tx.importSessionArtifact.findUniqueOrThrow({
                  where: { id: REF },
                });
                expect(row.temporaryPurgePending).toBe(true);
              }),
              "FS outside writer transaction",
            );
            observed++;
          } finally {
            await observer.$disconnect();
          }
          await erase(capture);
        });
      expect(await bounded(purger.purge(f.target()))).toBe("PURGED");
      expect(observed).toBe(1);
    } finally {
      await f.finish();
    }
  });

  it.each([false, true])(
    "D05 removed owner recovery, failure after rmdir before t sync=%s",
    async (failFirst) => {
      const { f, purger, restart } = await setup();
      let failed = false;
      try {
        await f.seedArtifact(ART, REF, { state: "PURGING" });
        if (failFirst) await f.writeBlob();
        const io = f.io({
          beforeSync: async (path) => {
            if (
              failFirst &&
              !failed &&
              path === join(f.root, "t") &&
              io.events.some(
                (event) =>
                  event.op === "rmdir:done" &&
                  event.path === join(f.root, `t/${REF}`),
              )
            ) {
              await absent(join(f.root, `t/${REF}`));
              failed = true;
              throw errno("EIO");
            }
          },
        });
        if (failFirst) {
          await rejected(purger.purge(f.target("artifact")), "FS_ERROR");
          expect(failed).toBe(true);
          await assertCharged(f, "artifact");
        }
        await absent(join(f.root, `t/${REF}`));
        const offset = io.events.length;
        expect(await bounded(restart().purge(f.target("artifact")))).toBe(
          "PURGED",
        );
        const retry = io.events.slice(offset);
        expect(
          retry.filter(
            (e) => e.op === "open" && e.path === join(f.root, `t/${REF}`),
          ),
        ).toEqual([]);
        for (const key of ["t", "trash"])
          expect(retry).toContainEqual({
            op: "sync:done",
            path: join(f.root, key),
          });
        await assertReleased(f, "artifact");
      } finally {
        await f.finish();
      }
    },
  );

  it.each(
    ["", "t", "trash"].flatMap((parent) =>
      (["missing", "symlink", "file"] as const).map((mode) => ({
        parent,
        mode,
      })),
    ),
  )(
    "D06 required parent '$parent' $mode is not legitimate owner absence",
    async ({ parent, mode }) => {
      const { f, purger } = await setup();
      try {
        await f.seedArtifact(ART, REF, { state: "PURGING" });
        const required = join(f.root, parent);
        const preserved = join(f.dir, `preserved-${parent || "V"}`);
        await fsp.rename(required, preserved);
        if (mode === "symlink") await fsp.symlink(preserved, required);
        if (mode === "file")
          await fsp.writeFile(required, PDF, { mode: 0o600 });
        const io = f.io();
        await rejected(purger.purge(f.target("artifact")));
        await assertCharged(f, "artifact");
        noDestruction(io.events);
      } finally {
        await f.finish();
      }
    },
  );

  it("active nonpending claim is not eligible; the exact expired boundary is eligible", async () => {
    const { f, purger } = await setup();
    try {
      await f.seedRef();
      await f.writeBlob();
      const io = f.io();
      expect(await bounded(purger.purge(f.target()))).toBe("NOT_ELIGIBLE");
      noDestruction(io.events);
      f.clock.value += 120000;
      expect(await bounded(purger.purge(f.target()))).toBe("PURGED");
      expect(await refRow(f)).toMatchObject({
        state: "FAILED",
        uploadGeneration: 3,
        uploadLeaseExpiresAt: null,
        reservedBytes: 0,
      });
    } finally {
      await f.finish();
    }
  });
});
