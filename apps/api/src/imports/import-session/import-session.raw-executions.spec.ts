require("../../../../../scripts/test-db-env.cjs");
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  rawWorld,
  nativePeers,
  rawSha,
} from "../../test-utils/import-session-raw-harness";
import {
  ImportRawExecutions,
  type ImportRawAdmissionInput,
} from "./import-session.raw-executions";
import {
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
} from "./import-session.capability";

describe("RAW execution ownership with the real runner and subprocess peers", () => {
  let context: Awaited<ReturnType<typeof rawWorld>>;
  let peers: ReturnType<typeof nativePeers>;
  let raw: ImportRawExecutions;
  beforeEach(async () => {
    context = await rawWorld();
    peers = nativePeers();
    raw = context.api.app.get(ImportRawExecutions);
  });
  afterEach(async () => {
    try {
      await peers?.close();
    } finally {
      await context?.close();
      jest.restoreAllMocks();
    }
  });
  function input(): ImportRawAdmissionInput {
    const runtime = context.gate.boot.runtime();
    if (!runtime) throw new Error("Missing test runtime");
    return {
      claim: {
        tenantId: context.world.tenantId,
        ownerProjectId: context.world.projects.pessoal,
        sessionId: randomUUID(),
        artifactId: randomUUID(),
        parseGeneration: 7,
      },
      ownerUserId: context.world.users.owner.id,
      runtime,
      deadlineMonotonicMs: performance.now() + 60000,
      leaseExpiresAtMs: context.api.clock.now().getTime() + 90000,
    };
  }
  function start(admission: Parameters<ImportRawExecutions["start"]>[0]) {
    const bytes = Buffer.from("%PDF-1.7 synthetic protocol peer");
    return raw.start(admission, {
      document: {
        version: 1,
        context: "CARD_INVOICE",
        format: "PDF",
        profile: "PDF_TEXT_CARD",
        bytes,
      },
      originalSha256: rawSha(bytes),
    });
  }

  it("admission_identity_single_start_and_one_per_tenant_two_local_are_enforced", async () => {
    const a = input();
    const admission = raw.admit(a);
    expect(() => raw.assertLive({ ...admission })).toThrow("LEASE_CONFLICT");
    expect(() => raw.admit(input())).toThrow("LEASE_CONFLICT");
    const b = input();
    const second = raw.admit({
      ...b,
      claim: { ...b.claim, tenantId: "synthetic-tenant-b" },
    });
    const c = input();
    expect(() =>
      raw.admit({
        ...c,
        claim: { ...c.claim, tenantId: "synthetic-tenant-c" },
      }),
    ).toThrow("LEASE_CONFLICT");
    const handle = start(admission);
    expect(() => start(admission)).toThrow("LEASE_CONFLICT");
    expect((await handle.result).kind).toBe("SUCCESS");
    expect((await handle.settled).cleanup).toBe("CLEAN");
    expect(raw.close(admission)).toBe("RELEASED");
    expect(raw.close(second)).toBe("RELEASED");
  });

  it("clean_settlement_does_not_release_before_publication_finishes", async () => {
    const entered = jest.spyOn(context.gate.registry, "enter");
    const admission = raw.admit(input());
    const lease = entered.mock.results[0].value;
    if (!lease.ok) throw new Error("Expected live lease");
    let released = false;
    void lease.lease.done.then(() => {
      released = true;
    });
    const handle = start(admission);
    await handle.result;
    expect((await handle.settled).cleanup).toBe("CLEAN");
    expect(released).toBe(false);
    expect(raw.assertLive(admission)).toBeUndefined();
    expect(() => raw.admit(input())).toThrow("LEASE_CONFLICT");
    expect(raw.close(admission)).toBe("RELEASED");
    await Promise.resolve();
    expect(released).toBe(true);
  });

  it("committed_invalidation_targets_old_generation_only_and_old_close_cannot_release_successor", () => {
    const a = input();
    const old = raw.admit(a);
    expect(raw.abortOwned([a.claim], "CANCEL")).toEqual(["ABORTED"]);
    expect(raw.abortOwned([a.claim], "CANCEL")).toEqual(["ALREADY_ABORTED"]);
    expect(raw.close(old)).toBe("RELEASED");
    const successor = raw.admit({
      ...a,
      claim: { ...a.claim, parseGeneration: 9 },
    });
    expect(raw.abortOwned([a.claim], "AC18")).toEqual(["NOT_LOCAL"]);
    expect(successor.signal.aborted).toBe(false);
    expect(raw.close(old)).toBe("RELEASED");
    expect(() => raw.admit(input())).toThrow("LEASE_CONFLICT");
    expect(raw.close(successor)).toBe("RELEASED");
  });

  it("cancel_does_not_abort_shared_artifact_readers", () => {
    const a = input();
    const reader = context.gate.registry.enter(`A:${a.claim.artifactId}`, {
      ...a.claim,
      ownerUserId: a.ownerUserId,
    });
    if (!reader.ok) throw new Error("Expected independent reader lease");
    const globalAbort = jest.spyOn(context.gate.registry, "abortAndDrain");
    const admission = raw.admit(a);
    expect(raw.abortOwned([a.claim], "CANCEL")).toEqual(["ABORTED"]);
    expect(reader.lease.signal.aborted).toBe(false);
    expect(globalAbort).not.toHaveBeenCalled();
    raw.close(admission);
    reader.lease.exit();
  });

  it("already_aborted_signal_and_fenced_enter_never_start_or_leak_capacity", () => {
    const a = input();
    const abort = new AbortController();
    abort.abort();
    expect(() => raw.admit({ ...a, requestSignal: abort.signal })).toThrow(
      "LEASE_CONFLICT",
    );
    context.gate.registry.fence(`A:${a.claim.artifactId}`);
    expect(() => raw.admit(a)).toThrow("LEASE_CONFLICT");
    context.gate.registry.releaseFence(`A:${a.claim.artifactId}`);
    const admission = raw.admit(a);
    expect(peers.spawn).not.toHaveBeenCalled();
    expect(raw.close(admission)).toBe("RELEASED");
  });

  it("close_distinguishes_pending_then_clean_without_releasing_early", async () => {
    peers.setBehavior("hold");
    const eof = peers.eof();
    const admission = raw.admit(input());
    const handle = start(admission);
    await eof;
    expect(raw.close(admission)).toBe("DRAINING");
    expect(() => raw.admit(input())).toThrow("LEASE_CONFLICT");
    expect((await handle.result).kind).toBe("FAILURE");
    expect((await handle.settled).cleanup).toBe("CLEAN");
    expect(raw.close(admission)).toBe("RELEASED");
    expect(() => start(admission)).toThrow("LEASE_CONFLICT");
  });

  it.each(["quarantine", "unconfirmed"] as const)(
    "close retains %s beyond SQL lease expiry and repeated close",
    async (behavior) => {
      peers.setBehavior(behavior);
      const admission = raw.admit(input());
      const handle = start(admission);
      await handle.result;
      const settled = await handle.settled;
      expect(settled.cleanup).toBe(
        behavior === "quarantine" ? "QUARANTINED" : "UNCONFIRMED",
      );
      expect(raw.close(admission)).toBe("RETAINED");
      context.api.clock.current = new Date(
        context.api.clock.now().getTime() + 90001,
      );
      expect(raw.close(admission)).toBe("RETAINED");
      expect(() => raw.admit(input())).toThrow("LEASE_CONFLICT");
      expect(await context.gate.registry.shutdown(0)).toBe("TIMEOUT");
    },
  );

  it("abort_and_close_remain_available_with_writes_OFF", () => {
    const a = input();
    const admission = raw.admit(a);
    jest
      .spyOn(
        context.api.app.get<ImportSessionCapability>(IMPORT_SESSION_CAPABILITY),
        "writesEnabled",
      )
      .mockReturnValue(false);
    expect(raw.abortOwned([a.claim], "EXPIRE")).toEqual(["ABORTED"]);
    expect(raw.close(admission)).toBe("RELEASED");
  });
});
