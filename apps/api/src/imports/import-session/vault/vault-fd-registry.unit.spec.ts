import { existsSync } from "node:fs";
import { join } from "node:path";

export type TestLease = {
  signal: AbortSignal;
  done: Promise<void>;
  exit(): void;
};
export type TestOwner = {
  tenantId: string;
  ownerProjectId: string;
  ownerUserId: string;
};
export type TestRegistry = {
  enter(
    key: `R:${string}` | `A:${string}`,
    owner: TestOwner,
  ): { ok: true; lease: TestLease } | { ok: false; reason: "FENCED" };
  fence(key: `R:${string}` | `A:${string}`): void;
  releaseFence(key: `R:${string}` | `A:${string}`): void;
  abortAndDrain(
    key: `R:${string}` | `A:${string}`,
    timeoutMs: number,
  ): Promise<"DRAINED" | "TIMEOUT">;
  snapshotUploads(): readonly (TestOwner & { refId: string })[];
};
const owner = { tenantId: "t", ownerProjectId: "p", ownerUserId: "u" };
function registry(): TestRegistry {
  expect(existsSync(join(__dirname, "vault-fd-registry.ts"))).toBe(true);
  const { VaultFdRegistry } = jest.requireActual<{
    VaultFdRegistry: new () => TestRegistry;
  }>("./vault-fd-registry");
  return new VaultFdRegistry();
}

describe("foundation registry, admission and actual owner completion", () => {
  afterEach(() => jest.useRealTimers());
  it("inserts synchronously, copies owners and deduplicates R identities, not A readers", () => {
    const r = registry();
    const mutable = { ...owner };
    const a = r.enter("R:one", mutable),
      b = r.enter("R:one", owner),
      reader = r.enter("A:blob", owner);
    mutable.tenantId = "wrong";
    expect(r.snapshotUploads()).toEqual([{ refId: "one", ...owner }]);
    if (!a.ok || !b.ok || !reader.ok) throw new Error("unexpected fence");
    a.lease.exit();
    a.lease.exit();
    expect(r.snapshotUploads()).toHaveLength(1);
    b.lease.exit();
    reader.lease.exit();
    expect(r.snapshotUploads()).toEqual([]);
  });
  it("projects only captured owner fields and derives refId from the registry key", async () => {
    const r = registry();
    const extended: TestOwner & {
      refId: string;
      sessionId: string;
      uploadTokenExpiresAtMs: number;
    } = {
      tenantId: "t",
      ownerProjectId: "p",
      ownerUserId: "u",
      refId: "caller-supplied-ref",
      sessionId: "private-session",
      uploadTokenExpiresAtMs: 123456,
    };
    const admission = r.enter("R:canonical-ref", extended);
    if (!admission.ok) throw new Error("unexpected fence");
    try {
      extended.tenantId = "changed-tenant";
      extended.ownerProjectId = "changed-project";
      extended.ownerUserId = "changed-user";
      extended.refId = "changed-ref";
      const snapshot = r.snapshotUploads();
      expect(snapshot).toEqual([
        {
          refId: "canonical-ref",
          tenantId: "t",
          ownerProjectId: "p",
          ownerUserId: "u",
        },
      ]);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot[0])).toBe(true);
      expect(Reflect.set(snapshot[0], "tenantId", "mutated")).toBe(false);
      expect(Reflect.set(snapshot, "length", 0)).toBe(false);
      expect(r.snapshotUploads()).toEqual(snapshot);
      admission.lease.exit();
      await admission.lease.done;
      expect(r.snapshotUploads()).toEqual([]);
      expect(snapshot).toHaveLength(1);
    } finally {
      admission.lease.exit();
    }
  });
  it("does not read extra input fields while capturing the owner", () => {
    const r = registry();
    const extended = {
      ...owner,
      get refId(): string {
        throw new Error("caller refId must not be read");
      },
    };
    const admission = r.enter("R:canonical-ref", extended);
    if (!admission.ok) throw new Error("unexpected fence");
    try {
      expect(r.snapshotUploads()).toEqual([
        {
          refId: "canonical-ref",
          tenantId: "t",
          ownerProjectId: "p",
          ownerUserId: "u",
        },
      ]);
    } finally {
      admission.lease.exit();
    }
  });
  it("fence aborts all leases but drain cannot resolve before every exit", async () => {
    const r = registry();
    const a = r.enter("R:one", owner),
      b = r.enter("R:one", owner);
    if (!a.ok || !b.ok) throw new Error("unexpected fence");
    r.fence("R:one");
    expect(r.enter("R:one", owner)).toEqual({ ok: false, reason: "FENCED" });
    const drain = r.abortAndDrain("R:one", 1000);
    expect(a.lease.signal.aborted).toBe(true);
    let settled = false;
    void drain.then(() => {
      settled = true;
    });
    a.lease.exit();
    await a.lease.done;
    expect(settled).toBe(false);
    b.lease.exit();
    await expect(drain).resolves.toBe("DRAINED");
  });
  it("timeout and memory-unfence preserve live lease/done/slot; retry drains the same lease", async () => {
    jest.useFakeTimers();
    const r = registry();
    const a = r.enter("R:one", owner);
    if (!a.ok) throw new Error("unexpected fence");
    r.fence("R:one");
    const drain = r.abortAndDrain("R:one", 20);
    jest.advanceTimersByTime(20);
    await expect(drain).resolves.toBe("TIMEOUT");
    r.releaseFence("R:one");
    let closed = false;
    void a.lease.done.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(a.lease.signal.aborted).toBe(true);
    expect(r.snapshotUploads()).toHaveLength(1);
    const b = r.enter("R:one", owner);
    expect(b.ok).toBe(true);
    if (b.ok) b.lease.exit();
    expect(r.snapshotUploads()).toHaveLength(1);
    const retry = r.abortAndDrain("R:one", 20);
    a.lease.exit();
    await expect(retry).resolves.toBe("DRAINED");
    expect(jest.getTimerCount()).toBe(0);
  });
});
