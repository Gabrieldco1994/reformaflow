import {
  OWNER,
  REF,
  REF2,
  ART,
  bounded,
  loadRegistry,
} from "../../../test-utils/vault-foundation-harness";

describe("P05 independent registry contract (declaration-only loader on EEA)", () => {
  afterEach(() => jest.useRealTimers());

  it("F02 admits synchronously before first await and fences synchronously", async () => {
    const Registry = loadRegistry();
    const registry = new Registry();
    const admission = registry.enter(`R:${REF}`, OWNER);
    expect(admission.ok).toBe(true);
    if (!admission.ok) throw new Error("admission failed");
    try {
      expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF }]);
      registry.fence(`R:${REF}`);
      expect(registry.enter(`R:${REF}`, OWNER)).toEqual({
        ok: false,
        reason: "FENCED",
      });
      let done = false;
      void admission.lease.done.then(() => {
        done = true;
      });
      await Promise.resolve();
      expect(done).toBe(false);
      expect(admission.lease.signal.aborted).toBe(false);
    } finally {
      admission.lease.exit();
      registry.releaseFence(`R:${REF}`);
    }
    await bounded(admission.lease.done);
    expect(registry.snapshotUploads()).toEqual([]);
  });

  it("F02 counts unique R identities, not lease count, and never counts A readers", async () => {
    const Registry = loadRegistry();
    const registry = new Registry();
    const admissions = [
      registry.enter(`R:${REF}`, OWNER),
      registry.enter(`R:${REF}`, OWNER),
      registry.enter(`R:${REF2}`, OWNER),
      registry.enter(`A:${ART}`, OWNER),
    ];
    const leases = admissions.map((a) => {
      expect(a.ok).toBe(true);
      if (!a.ok) throw new Error("admission failed");
      return a.lease;
    });
    try {
      expect(
        registry
          .snapshotUploads()
          .map((x) => x.refId)
          .sort(),
      ).toEqual([REF, REF2]);
      leases[0].exit();
      expect(
        registry
          .snapshotUploads()
          .map((x) => x.refId)
          .sort(),
      ).toEqual([REF, REF2]);
      leases[0].exit();
      leases[1].exit();
      expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF2 }]);
    } finally {
      leases.forEach((lease) => lease.exit());
    }
    await bounded(Promise.all(leases.map((lease) => lease.done)));
  });

  it("F04 drain aborts every lease and remains pending until the last explicit exit", async () => {
    const Registry = loadRegistry();
    const registry = new Registry();
    const a = registry.enter(`R:${REF}`, OWNER),
      b = registry.enter(`R:${REF}`, OWNER);
    if (!a.ok || !b.ok) throw new Error("admission failed");
    let settled = false;
    registry.fence(`R:${REF}`);
    const drain = registry.abortAndDrain(`R:${REF}`, 1000);
    void drain.then(() => {
      settled = true;
    });
    try {
      expect(a.lease.signal.aborted).toBe(true);
      expect(b.lease.signal.aborted).toBe(true);
      a.lease.exit();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(registry.snapshotUploads()).toHaveLength(1);
      b.lease.exit();
      await expect(bounded(drain)).resolves.toBe("DRAINED");
    } finally {
      a.lease.exit();
      b.lease.exit();
      registry.releaseFence(`R:${REF}`);
    }
  });

  it("F05 corrected: timeout and releaseFence preserve live aborted lease, done and slot", async () => {
    const Registry = loadRegistry();
    jest.useFakeTimers();
    const registry = new Registry();
    const a = registry.enter(`R:${REF}`, OWNER);
    if (!a.ok) throw new Error("admission failed");
    let done = false;
    void a.lease.done.then(() => {
      done = true;
    });
    registry.fence(`R:${REF}`);
    const drain = registry.abortAndDrain(`R:${REF}`, 100);
    try {
      await jest.advanceTimersByTimeAsync(100);
      await expect(drain).resolves.toBe("TIMEOUT");
      registry.releaseFence(`R:${REF}`);
      registry.releaseFence(`R:${REF}`);
      expect(a.lease.signal.aborted).toBe(true);
      expect(done).toBe(false);
      expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF }]);
      const b = registry.enter(`R:${REF}`, OWNER);
      expect(b.ok).toBe(true);
      if (!b.ok) throw new Error("fence was not released");
      b.lease.exit();
      expect(registry.snapshotUploads()).toHaveLength(1);
      expect(done).toBe(false);
    } finally {
      a.lease.exit();
      registry.releaseFence(`R:${REF}`);
    }
    await a.lease.done;
    expect(registry.snapshotUploads()).toEqual([]);
  });

  it("F07 an empty or different key drains independently of a stalled key", async () => {
    const Registry = loadRegistry();
    const registry = new Registry();
    const a = registry.enter(`R:${REF}`, OWNER);
    if (!a.ok) throw new Error("admission failed");
    try {
      registry.fence(`R:${REF}`);
      expect(await bounded(registry.abortAndDrain(`A:${ART}`, 100))).toBe(
        "DRAINED",
      );
      expect(registry.snapshotUploads()).toEqual([{ ...OWNER, refId: REF }]);
      expect(a.lease.signal.aborted).toBe(false);
    } finally {
      a.lease.exit();
      registry.releaseFence(`R:${REF}`);
    }
  });
});
