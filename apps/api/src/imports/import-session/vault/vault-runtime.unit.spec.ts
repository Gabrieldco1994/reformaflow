import { startVaultBoot, type VaultBootHandle } from "./vault-boot";
import { VaultFdRegistry } from "./vault-fd-registry";
import { parseVaultConfig } from "./vault.config";

const valid: NodeJS.ProcessEnv = {
  IMPORT_VAULT_ENABLED: "true",
  IMPORT_VAULT_LOCK_FD: "7",
  VAULT_DIR: "/srv/private-vault-unit",
  IMPORT_VAULT_IDLE_TIMEOUT_MS: "30000",
  IMPORT_VAULT_HEADROOM_BYTES: "1024",
  IMPORT_VAULT_DRAIN_TIMEOUT_MS: "73",
};
const roots = {
  publicDir: "/srv/public-unit",
  privateDir: "/srv/private-unit",
};
const owner = {
  tenantId: "runtime-unit-tenant",
  ownerProjectId: "runtime-unit-project",
  ownerUserId: "runtime-unit-user",
};

type ShutdownRegistry = VaultFdRegistry & {
  shutdown(
    timeoutMs: number | null,
  ): Promise<"DRAINED" | "TIMEOUT" | "UNCONFIGURED">;
};
function assertShutdown(
  registry: VaultFdRegistry,
): asserts registry is ShutdownRegistry {
  expect(
    "shutdown" in registry && typeof registry.shutdown === "function",
  ).toBe(true);
}
function registry(): ShutdownRegistry {
  const instance = new VaultFdRegistry();
  assertShutdown(instance);
  return instance;
}
type TerminalBoot = VaultBootHandle & {
  stopped: AbortSignal;
  drainTimeoutMs: number | null;
  revoke(reason: "LOCK_REPLACED" | "SHUTDOWN"): void;
  recheckLock(): Promise<Readonly<{ ok: boolean }>>;
};
function assertTerminalBoot(
  handle: VaultBootHandle,
): asserts handle is TerminalBoot {
  expect(handle).toMatchObject({
    stopped: expect.any(AbortSignal),
    drainTimeoutMs: null,
    revoke: expect.any(Function),
    recheckLock: expect.any(Function),
  });
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("P05 own RED: explicit drain configuration, not a production timeout recommendation", () => {
  it.each([
    ["0", 0],
    ["00073", 73],
    ["2147483647", 2147483647],
  ])("binds the literal timer-domain value %s", (raw, expected) => {
    expect(
      parseVaultConfig({
        ...valid,
        IMPORT_VAULT_DRAIN_TIMEOUT_MS: String(raw),
      }),
    ).toEqual({
      configured: true,
      rootDir: "/srv/private-vault-unit",
      lockFd: 7,
      idleTimeoutMs: 30000,
      headroomBytes: 1024,
      drainTimeoutMs: expected,
    });
  });

  it.each([
    undefined,
    "",
    " ",
    "-1",
    "+1",
    "1e3",
    "1.0",
    "2147483648",
    "9007199254740992",
    "73 ",
    " 73",
    "73\n",
    "0x49",
    "1_000",
    "Infinity",
  ])(
    "rejects missing/malformed/out-of-domain drain %j without a default",
    (raw) => {
      expect(
        parseVaultConfig({ ...valid, IMPORT_VAULT_DRAIN_TIMEOUT_MS: raw }),
      ).toEqual({
        configured: false,
        reason: "DRAIN_TIMEOUT_UNSET",
      });
    },
  );

  it.each([
    ["IMPORT_VAULT_ENABLED", "false", "FLAG_OFF"],
    ["IMPORT_VAULT_LOCK_FD", "2", "NO_LOCK_FD"],
    ["VAULT_DIR", "relative", "BAD_ROOT"],
    ["IMPORT_VAULT_IDLE_TIMEOUT_MS", "0", "IDLE_TIMEOUT_UNSET"],
    ["IMPORT_VAULT_HEADROOM_BYTES", "0", "HEADROOM_UNSET"],
  ])(
    "preserves the existing %s precedence before missing drain",
    (key, value, reason) => {
      expect(
        parseVaultConfig({
          ...valid,
          [key]: value,
          IMPORT_VAULT_DRAIN_TIMEOUT_MS: undefined,
        }),
      ).toEqual({ configured: false, reason });
    },
  );

  it("FLAG_OFF does not even read the new drain key", () => {
    const input: NodeJS.ProcessEnv = { IMPORT_VAULT_ENABLED: "false" };
    Object.defineProperty(input, "IMPORT_VAULT_DRAIN_TIMEOUT_MS", {
      get: () => {
        throw new Error("DRAIN_KEY_READ_WHILE_OFF");
      },
    });
    expect(parseVaultConfig(input)).toEqual({
      configured: false,
      reason: "FLAG_OFF",
    });
  });
});

describe("P05 own RED: terminal boot surface on real FLAG_OFF, never a fabricated ON handle", () => {
  it("exposes the already-aborted terminal signal and null drain binding before return", async () => {
    const handle = startVaultBoot({}, roots);
    assertTerminalBoot(handle);
    expect(handle.stopped.aborted).toBe(true);
    expect(handle.drainTimeoutMs).toBeNull();
    expect(Object.isFrozen(handle)).toBe(true);
    await expect(handle.settled).resolves.toBeUndefined();
  });

  it("revocation after a terminal OFF preserves the first reason and recheck denies", async () => {
    const handle = startVaultBoot({}, roots);
    assertTerminalBoot(handle);
    handle.revoke("SHUTDOWN");
    handle.revoke("LOCK_REPLACED");
    expect(handle.reason).toBe("FLAG_OFF");
    expect(handle.runtime()).toBeNull();
    await expect(handle.recheckLock()).resolves.toEqual({ ok: false });
  });
});

describe("P05 own RED: global R/A registry protocol (not a physical-close certification)", () => {
  it("empty/unconfigured shutdown positively drains without a timer and seals both namespaces", async () => {
    const r = registry();
    const timer = jest.spyOn(global, "setTimeout");
    const shutdown = r.shutdown(null);
    expect(r.enter("R:new", owner)).toEqual({ ok: false, reason: "FENCED" });
    expect(r.enter("A:new", owner)).toEqual({ ok: false, reason: "FENCED" });
    await expect(shutdown).resolves.toBe("DRAINED");
    expect(timer).not.toHaveBeenCalled();
  });

  it("seals before either abort callback and per-key unfence cannot reopen admission", async () => {
    const r = registry();
    const upload = r.enter("R:one", owner);
    const read = r.enter("A:two", owner);
    if (!upload.ok || !read.ok) throw new Error("UNIT_ADMISSION_FAILED");
    const callbackAdmissions: unknown[] = [];
    for (const lease of [upload.lease, read.lease]) {
      lease.signal.addEventListener("abort", () => {
        r.releaseFence("R:one");
        r.releaseFence("A:two");
        callbackAdmissions.push(
          r.enter("R:late", owner),
          r.enter("A:late", owner),
        );
      });
    }
    try {
      const shutdown = r.shutdown(73);
      expect(callbackAdmissions).toEqual([
        { ok: false, reason: "FENCED" },
        { ok: false, reason: "FENCED" },
        { ok: false, reason: "FENCED" },
        { ok: false, reason: "FENCED" },
      ]);
      expect(r.shutdown(2147483647)).toBe(shutdown);
      upload.lease.exit();
      read.lease.exit();
      await expect(shutdown).resolves.toBe("DRAINED");
    } finally {
      upload.lease.exit();
      read.lease.exit();
    }
  });

  it("does not report DRAINED until both real registry leases exit", async () => {
    jest.useFakeTimers();
    const r = registry();
    const upload = r.enter("R:one", owner);
    const read = r.enter("A:two", owner);
    if (!upload.ok || !read.ok) throw new Error("UNIT_ADMISSION_FAILED");
    try {
      const shutdown = r.shutdown(73);
      let settled = false;
      void shutdown.then(() => {
        settled = true;
      });
      upload.lease.exit();
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      read.lease.exit();
      await expect(shutdown).resolves.toBe("DRAINED");
    } finally {
      upload.lease.exit();
      read.lease.exit();
    }
  });

  it("one coalesced budget times out with live leases and upload projection preserved", async () => {
    jest.useFakeTimers();
    const r = registry();
    const upload = r.enter("R:one", owner);
    const read = r.enter("A:two", owner);
    if (!upload.ok || !read.ok) throw new Error("UNIT_ADMISSION_FAILED");
    try {
      const shutdown = r.shutdown(73);
      let result: string | undefined;
      let readClosed = false;
      void shutdown.then((value) => {
        result = value;
      });
      void read.lease.done.then(() => {
        readClosed = true;
      });
      await jest.advanceTimersByTimeAsync(72);
      expect(result).toBeUndefined();
      expect(r.shutdown(2147483647)).toBe(shutdown);
      await jest.advanceTimersByTimeAsync(1);
      await expect(shutdown).resolves.toBe("TIMEOUT");
      expect(readClosed).toBe(false);
      expect(r.snapshotUploads()).toEqual([{ ...owner, refId: "one" }]);
      expect(upload.lease.signal.aborted).toBe(true);
      expect(read.lease.signal.aborted).toBe(true);
    } finally {
      upload.lease.exit();
      read.lease.exit();
    }
  });

  it("missing budget with live leases reports UNCONFIGURED, not closure or a zero timeout", async () => {
    const r = registry();
    const upload = r.enter("R:one", owner);
    if (!upload.ok) throw new Error("UNIT_ADMISSION_FAILED");
    try {
      const shutdown = r.shutdown(null);
      expect(r.shutdown(0)).toBe(shutdown);
      await expect(shutdown).resolves.toBe("UNCONFIGURED");
      expect(upload.lease.signal.aborted).toBe(true);
      expect(r.snapshotUploads()).toEqual([{ ...owner, refId: "one" }]);
      r.releaseFence("R:one");
      expect(r.enter("R:new", owner)).toEqual({ ok: false, reason: "FENCED" });
    } finally {
      upload.lease.exit();
    }
  });
});
