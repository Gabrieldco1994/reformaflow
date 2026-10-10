import { Logger } from "@nestjs/common";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LockFacts } from "./vault-lock";
import type { RootFacts } from "./vault-root";

interface Handle {
  state(): "ON" | "OFF";
  readonly reason?: string;
  readonly step?: string;
  readonly code?: string;
  readonly closeCode?: string;
  runtime(): {
    config: {
      rootDir: string;
      lockFd: number;
      idleTimeoutMs: number;
      headroomBytes: number;
    };
    lockIdentity: { dev: bigint; ino: bigint };
  } | null;
  settled: Promise<void>;
}
interface Boot {
  VAULT_BOOT_DEADLINE_MS: number;
  startVaultBoot(env: NodeJS.ProcessEnv, uploadRoots: typeof roots): Handle;
}
type Failure =
  | { ok: false; outcome: "FS_ERROR"; code: string; closeCode?: string }
  | { ok: false; outcome: "SETTLED" | "INVALID_STATFS" };
interface Durability {
  fsyncProbe(
    dir: string,
    settled: () => boolean,
    cleanup: (error: { step: "fsync-close"; code: string }) => void,
  ): Promise<{ ok: true } | Failure>;
  availableBytes(
    dir: string,
    settled: () => boolean,
  ): Promise<{ ok: true; available: bigint } | Failure>;
}

// An absent direct module is a RED assertion; a broken transitive dependency remains a setup error.
function load<T extends object>(name: string): T {
  expect({
    module: name,
    exists: existsSync(join(__dirname, `${name}.ts`)),
  }).toEqual({ module: name, exists: true });
  return jest.requireActual<T>(`./${name}`);
}
const probes = jest.requireActual<{
  collectLockFacts(
    fd: number | null,
    path: string,
    platform: string,
    settled: () => boolean,
  ): Promise<LockFacts>;
  collectRootFacts(
    root: string,
    uploads: typeof roots,
    euid: number | null,
    settled: () => boolean,
  ): Promise<RootFacts>;
}>("./vault-probe");
const roots = {
  publicDir: "/data/uploads",
  privateDir: "/data/private-uploads",
};
const env = {
  IMPORT_VAULT_ENABLED: "true",
  IMPORT_VAULT_LOCK_FD: "5",
  VAULT_DIR: "/vault/v",
  IMPORT_VAULT_IDLE_TIMEOUT_MS: "4294967296",
  IMPORT_VAULT_HEADROOM_BYTES: "1024",
  IMPORT_VAULT_DRAIN_TIMEOUT_MS: "73",
};
const lockFacts: LockFacts = {
  lockFd: 5,
  platform: "linux",
  fd: { kind: "file", dev: 0x803n, ino: 42n },
  path: { kind: "file", dev: 0x803n, ino: 42n },
  fdinfo: "lock:\t1: FLOCK  ADVISORY  WRITE 123 8:3:42 0 EOF\n",
};
const dir = { kind: "dir", mode: 0o40700, uid: 501 } as const;
const rootFacts: RootFacts = {
  euid: 501,
  resolved: { root: "/vault/v", ...roots },
  root: dir,
  t: dir,
  trash: dir,
  lock: { kind: "file", mode: 0o100600, uid: 501 },
};
const errno = (code: string) =>
  Object.assign(new Error("boom /secret/p"), { code });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
// Drain the finite four-probe promise chain, without advancing either clock.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
let clock: number;
let logs: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["performance"] });
  clock = 100;
  jest.spyOn(performance, "now").mockImplementation(() => clock);
  logs = jest
    .spyOn(Logger.prototype, "error")
    .mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
function setup() {
  const boot = load<Boot>("vault-boot");
  const durability = load<Durability>("vault-durability");
  const lock = jest
    .spyOn(probes, "collectLockFacts")
    .mockResolvedValue(lockFacts);
  const root = jest
    .spyOn(probes, "collectRootFacts")
    .mockResolvedValue(rootFacts);
  const sync = jest
    .spyOn(durability, "fsyncProbe")
    .mockResolvedValue({ ok: true });
  const space = jest
    .spyOn(durability, "availableBytes")
    .mockResolvedValue({ ok: true, available: 1024n });
  return { ...boot, lock, root, sync, space };
}
function diagnostic(h: Handle) {
  return {
    state: h.state(),
    reason: h.reason,
    step: h.step,
    code: h.code,
    closeCode: h.closeCode,
  };
}
function off(h: Handle, reason: string, step: string, code?: string) {
  expect(diagnostic(h)).toMatchObject({ state: "OFF", reason, step, code });
  expect(h.runtime()).toBeNull();
}

describe("inactive vault boot: BT0-BT11", () => {
  it.each(["success", "close-pending", "late-sync-and-close-errors"] as const)(
    "C0 REAL host FS + real handle property spies: %s (lock facts alone are SYNTHETIC, not Linux evidence)",
    async (scenario) => {
      const s = setup();
      const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
      s.root.mockRestore();
      s.sync.mockRestore();
      s.space.mockRestore();
      const durability = load<Durability>("vault-durability");
      const realProbe = durability.fsyncProbe;
      let completion: ReturnType<Durability["fsyncProbe"]> | undefined;
      jest.spyOn(durability, "fsyncProbe").mockImplementation((...args) => {
        completion = realProbe(...args);
        return completion;
      });
      const tmp = mkdtempSync(join(tmpdir(), "vault-boot-"));
      chmodSync(tmp, 0o700);
      const V = join(tmp, "v");
      mkdirSync(V, { mode: 0o700 });
      mkdirSync(join(V, "t"), { mode: 0o700 });
      mkdirSync(join(V, "trash"), { mode: 0o700 });
      writeFileSync(join(V, ".lock"), "", { mode: 0o600 });
      const realOpen = fs.promises.open;
      const realStatfs = fs.promises.statfs;
      const statfs = jest
        .spyOn(fs.promises, "statfs")
        .mockImplementation(async (path, options) => {
          expect(path).toBe(join(V, "t"));
          expect(options).toEqual({ bigint: true });
          return realStatfs(path, { bigint: true });
        });
      const gate = deferred<void>(),
        entered = deferred<void>();
      let owned: FileHandle | undefined;
      const events: string[] = [];
      jest
        .spyOn(fs.promises, "open")
        .mockImplementation(async (path, flags, mode) => {
          expect(path).toBe(join(V, "t"));
          owned = await realOpen(path, flags, mode);
          const syncReal = owned.sync.bind(owned),
            closeReal = owned.close.bind(owned);
          jest.spyOn(owned, "sync").mockImplementation(async () => {
            events.push("sync");
            if (scenario === "late-sync-and-close-errors") {
              entered.resolve();
              await gate.promise;
              throw errno("EIO");
            }
            await syncReal();
          });
          jest.spyOn(owned, "close").mockImplementation(async () => {
            events.push("close");
            if (scenario === "close-pending") {
              entered.resolve();
              await gate.promise;
            }
            await closeReal();
            if (scenario === "late-sync-and-close-errors")
              throw errno("ENOSPC");
          });
          return owned;
        });
      try {
        const h = s.startVaultBoot(
          { ...env, VAULT_DIR: `${V}//` },
          {
            publicDir: join(tmp, "public"),
            privateDir: join(tmp, "private"),
          },
        );
        if (scenario === "success") {
          await h.settled;
          expect(h.state()).toBe("ON");
          expect(statfs).toHaveBeenCalledTimes(1);
        } else {
          await entered.promise;
          off(h, "BOOT_PENDING", "fsync");
          jest.advanceTimersByTime(s.VAULT_BOOT_DEADLINE_MS);
          await h.settled;
          off(h, "BOOT_TIMEOUT", "fsync");
          logs.mockClear();
          gate.resolve();
        }
        if (scenario !== "success") {
          expect(completion).toBeDefined();
          await completion;
          await flush();
          off(h, "BOOT_TIMEOUT", "fsync");
          expect(statfs).not.toHaveBeenCalled();
          if (scenario === "late-sync-and-close-errors")
            expect(logs).toHaveBeenCalledWith({
              event: "vault_boot",
              step: "fsync",
              code: "EIO",
              closeCode: "ENOSPC",
              late: true,
            });
          else expect(logs).not.toHaveBeenCalled();
        }
        expect(owned?.fd).toBe(-1);
        expect(events).toEqual(["sync", "close"]);
      } finally {
        gate.resolve();
        jest.restoreAllMocks();
        if (owned && owned.fd !== -1) await owned.close();
        const evidence = process.env.VAULT_BOOT_TEST_EVIDENCE_DIR;
        if (evidence) {
          mkdirSync(evidence, { recursive: true, mode: 0o700 });
          cpSync(tmp, join(evidence, tmp.slice(tmp.lastIndexOf("/") + 1)), {
            recursive: true,
          });
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
  it("BT0 C0: the real boot consumes module spies and the monotonic clock spy changes its verdict", async () => {
    const s = setup();
    s.space.mockImplementation(async () => {
      clock = 100 + s.VAULT_BOOT_DEADLINE_MS;
      return { ok: true, available: 1024n };
    });
    const h = s.startVaultBoot(env, roots);
    await h.settled;
    expect(s.lock).toHaveBeenCalledTimes(1);
    expect(s.space).toHaveBeenCalledTimes(1);
    off(h, "BOOT_TIMEOUT", "statfs");
  });
  it("BT-K pins 5000ms as fail-closed policy, NOT a measured SLA", () => {
    expect(load<Boot>("vault-boot").VAULT_BOOT_DEADLINE_MS).toBe(5000);
  });
  it.each([
    ["lock", -1],
    ["lock", 0],
    ["lock", 1],
    ["root", 0],
    ["sync", 0],
    ["space", 0],
  ] as const)(
    "QA deadline-first operational rejection: %s at offset %i with timer delayed",
    async (step, offset) => {
      const s = setup();
      s[step].mockImplementation(async (): Promise<never> => {
        clock = 100 + s.VAULT_BOOT_DEADLINE_MS + offset;
        throw errno("EIO");
      });
      const h = s.startVaultBoot(env, roots);
      await h.settled;
      const sequence = [s.lock, s.root, s.sync, s.space];
      for (const spy of sequence.slice(sequence.indexOf(s[step]) + 1))
        expect(spy).not.toHaveBeenCalled();
      expect(h.runtime()).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
      const current = {
        lock: "lock",
        root: "root",
        sync: "fsync",
        space: "statfs",
      }[step];
      expect({
        diagnostic: diagnostic(h),
        logs: logs.mock.calls.map(([event]) => event),
      }).toEqual({
        diagnostic: {
          state: "OFF",
          reason: offset < 0 ? "BOOT_CHECK_ERROR" : "BOOT_TIMEOUT",
          step: current,
          code: offset < 0 ? "EIO" : undefined,
          closeCode: undefined,
        },
        logs:
          offset < 0
            ? [
                {
                  event: "vault_boot",
                  reason: "BOOT_CHECK_ERROR",
                  step: current,
                  code: "EIO",
                  late: false,
                },
              ]
            : [
                {
                  event: "vault_boot",
                  reason: "BOOT_TIMEOUT",
                  step: current,
                  late: false,
                },
                {
                  event: "vault_boot",
                  step: current,
                  code: "EIO",
                  late: true,
                },
              ],
      });
    },
  );
  it.each([
    [{}, "FLAG_OFF"],
    [{ IMPORT_VAULT_ENABLED: "true" }, "NO_LOCK_FD"],
    [{ IMPORT_VAULT_ENABLED: "true", IMPORT_VAULT_LOCK_FD: "5" }, "BAD_ROOT"],
    [
      {
        IMPORT_VAULT_ENABLED: "true",
        IMPORT_VAULT_LOCK_FD: "5",
        VAULT_DIR: "/v",
      },
      "IDLE_TIMEOUT_UNSET",
    ],
    [
      {
        IMPORT_VAULT_ENABLED: "true",
        IMPORT_VAULT_LOCK_FD: "5",
        VAULT_DIR: "/v",
        IMPORT_VAULT_IDLE_TIMEOUT_MS: "1000",
      },
      "HEADROOM_UNSET",
    ],
  ] as const)(
    "BT1 config %j => %s, synchronous, no probes/timer",
    async (input, reason) => {
      const s = setup();
      const h = s.startVaultBoot(input, roots);
      expect(h).not.toHaveProperty("then");
      off(h, reason, "config");
      await h.settled;
      for (const spy of [s.lock, s.root, s.sync, s.space])
        expect(spy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      if (reason === "FLAG_OFF") expect(logs).not.toHaveBeenCalled();
    },
  );
  it("BT2 logical hang: K-1 pending, K timeout, no next probe (not a kernel hang proof)", async () => {
    const s = setup();
    s.lock.mockReturnValue(new Promise(() => undefined));
    const h = s.startVaultBoot(env, roots);
    off(h, "BOOT_PENDING", "lock");
    jest.advanceTimersByTime(s.VAULT_BOOT_DEADLINE_MS - 1);
    off(h, "BOOT_PENDING", "lock");
    jest.advanceTimersByTime(1);
    await h.settled;
    off(h, "BOOT_TIMEOUT", "lock");
    expect(s.root).not.toHaveBeenCalled();
  });
  it.each(["lock", "root", "sync", "space"] as const)(
    "BT3 late %s success cannot authorize or start a next probe",
    async (step) => {
      const s = setup();
      const gate = deferred<void>();
      if (step === "lock")
        s.lock.mockImplementation(async () => {
          await gate.promise;
          return lockFacts;
        });
      if (step === "root")
        s.root.mockImplementation(async () => {
          await gate.promise;
          return rootFacts;
        });
      if (step === "sync")
        s.sync.mockImplementation(async () => {
          await gate.promise;
          return { ok: true };
        });
      if (step === "space")
        s.space.mockImplementation(async () => {
          await gate.promise;
          return { ok: true, available: 1024n };
        });
      const h = s.startVaultBoot(env, roots);
      await flush();
      const counts = [s.lock, s.root, s.sync, s.space].map(
        (spy) => spy.mock.calls.length,
      );
      jest.advanceTimersByTime(s.VAULT_BOOT_DEADLINE_MS);
      await h.settled;
      const before = diagnostic(h);
      logs.mockClear();
      gate.resolve();
      await flush();
      expect(diagnostic(h)).toEqual(before);
      expect(h.runtime()).toBeNull();
      expect(
        [s.lock, s.root, s.sync, s.space].map((spy) => spy.mock.calls.length),
      ).toEqual(counts);
      expect(logs).not.toHaveBeenCalled();
    },
  );
  it.each([-1, 0, 1])(
    "BT4 deadline offset %i without advancing the timer",
    async (delta) => {
      const s = setup();
      s.space.mockImplementation(async () => {
        clock = 100 + s.VAULT_BOOT_DEADLINE_MS + delta;
        return { ok: true, available: 1024n };
      });
      const h = s.startVaultBoot(env, roots);
      await h.settled;
      expect(h.state()).toBe(delta < 0 ? "ON" : "OFF");
      if (delta >= 0) off(h, "BOOT_TIMEOUT", "statfs");
      expect(jest.getTimerCount()).toBe(0);
      const before = diagnostic(h);
      jest.advanceTimersByTime(10 * s.VAULT_BOOT_DEADLINE_MS);
      expect(diagnostic(h)).toEqual(before);
    },
  );
  it("BT4 collector callback enforces the absolute deadline, idempotently", async () => {
    const s = setup();
    const pending = deferred<LockFacts>();
    s.lock.mockReturnValue(pending.promise);
    const h = s.startVaultBoot(env, roots);
    const settled = s.lock.mock.calls[0][3];
    expect(settled()).toBe(false);
    clock += s.VAULT_BOOT_DEADLINE_MS;
    expect(settled()).toBe(true);
    expect(settled()).toBe(true);
    await h.settled;
    pending.resolve(lockFacts);
    await flush();
    off(h, "BOOT_TIMEOUT", "lock");
    expect(s.root).not.toHaveBeenCalled();
  });
  it.each(["lock", "root", "sync", "space"] as const)(
    "BT5 %s sync throws and async rejections are operational, terminal and sanitized",
    async (step) => {
      const s = setup();
      for (const synchronous of [false, true]) {
        s[step].mockImplementation((): Promise<never> => {
          if (synchronous) throw errno("EIO");
          return Promise.reject(errno("EIO"));
        });
        const h = s.startVaultBoot(env, roots);
        await h.settled;
        off(
          h,
          "BOOT_CHECK_ERROR",
          { lock: "lock", root: "root", sync: "fsync", space: "statfs" }[step],
          "EIO",
        );
        const sequence = [s.lock, s.root, s.sync, s.space];
        for (const spy of sequence.slice(sequence.indexOf(s[step]) + 1))
          expect(spy).not.toHaveBeenCalled();
        expect(JSON.stringify([diagnostic(h), logs.mock.calls])).not.toMatch(
          /secret|boom|stack/,
        );
      }
    },
  );
  it.each([
    [null, "UNKNOWN"],
    ["x", "UNKNOWN"],
    [7, "UNKNOWN"],
    [
      {
        get code() {
          throw new Error("secret");
        },
      },
      "UNKNOWN",
    ],
    [{ code: "/etc/passwd" }, "UNKNOWN"],
    [{ code: "eio" }, "UNKNOWN"],
    [{ code: `E${"X".repeat(16)}` }, "UNKNOWN"],
    [{ code: "ESECRET123" }, "UNKNOWN"],
    [{ code: "ENOSPC" }, "ENOSPC"],
  ])(
    "BT5 hostile error %# cannot become a diagnostic channel",
    async (error, code) => {
      const s = setup();
      s.lock.mockRejectedValue(error);
      const h = s.startVaultBoot(env, roots);
      await h.settled;
      off(h, "BOOT_CHECK_ERROR", "lock", String(code));
      expect(logs).toHaveBeenCalledWith(
        expect.objectContaining({ step: "lock", code }),
      );
    },
  );
  it.each([
    { ok: false, outcome: "FS_ERROR", code: "EIO" },
    { ok: false, outcome: "INVALID_STATFS" },
  ] as const)(
    "BT5 invalid/statfs failure is not low headroom: %j",
    async (result) => {
      const s = setup();
      s.space.mockResolvedValue(result);
      const h = s.startVaultBoot(env, roots);
      await h.settled;
      off(
        h,
        "BOOT_CHECK_ERROR",
        "statfs",
        result.outcome === "FS_ERROR" ? "EIO" : "INVALID_STATFS",
      );
    },
  );
  it("BT5 sync AND close failures survive in the handle and structured log", async () => {
    const s = setup();
    s.sync.mockResolvedValue({
      ok: false,
      outcome: "FS_ERROR",
      code: "EINVAL",
      closeCode: "EIO",
    });
    const h = s.startVaultBoot(env, roots);
    await h.settled;
    off(h, "FSYNC_CHECK_FAILED", "fsync", "EINVAL");
    expect(h.closeCode).toBe("EIO");
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "fsync",
        code: "EINVAL",
        closeCode: "EIO",
      }),
    );
    expect(s.space).not.toHaveBeenCalled();
  });
  it.each([
    ["NO_FDINFO", { ...lockFacts, fdinfo: null }],
    [
      "LOCK_NOT_OWNED",
      {
        ...lockFacts,
        fdinfo: "lock:\t1: FLOCK  ADVISORY  WRITE 123 8:3:43 0 EOF\n",
      },
    ],
  ] as const)(
    "BT6 lock verdict %s wins and stops collection",
    async (reason, facts) => {
      const s = setup();
      s.lock.mockResolvedValue(facts);
      const h = s.startVaultBoot(env, roots);
      await h.settled;
      off(h, reason, "lock");
      expect(s.lock).toHaveBeenCalledTimes(1);
      for (const spy of [s.root, s.sync, s.space])
        expect(spy).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["root.root", { ...rootFacts, root: { ...dir, mode: 0o40755 } }],
    ["root.t", { ...rootFacts, t: { ...dir, kind: "symlink" } }],
  ] as const)("BT6 root verdict %s wins", async (step, facts) => {
    const s = setup();
    s.root.mockResolvedValue(facts);
    const h = s.startVaultBoot(env, roots);
    await h.settled;
    off(h, "BAD_ROOT", step);
    expect(s.lock).toHaveBeenCalledTimes(1);
    expect(s.root).toHaveBeenCalledTimes(1);
    expect(s.sync).not.toHaveBeenCalled();
    expect(s.space).not.toHaveBeenCalled();
  });
  it.each([1023n, 1024n])("BT6 inclusive headroom %s", async (available) => {
    const s = setup();
    s.space.mockResolvedValue({ ok: true, available });
    const h = s.startVaultBoot(env, roots);
    await h.settled;
    if (available === 1023n) off(h, "HEADROOM_INSUFFICIENT", "statfs");
    else expect(h.state()).toBe("ON");
  });
  it.each(["/vault//x/../v/", "/vault/v///"])(
    "BT7/BT8 one canonical V and a deeply frozen ON-only runtime: %s",
    async (VAULT_DIR) => {
      const s = setup();
      const h = s.startVaultBoot({ ...env, VAULT_DIR }, roots);
      expect(h.runtime()).toBeNull();
      await h.settled;
      expect(s.lock.mock.calls[0].slice(0, 3)).toEqual([
        5,
        "/vault/v/.lock",
        process.platform,
      ]);
      expect(s.root.mock.calls[0].slice(0, 3)).toEqual([
        "/vault/v",
        roots,
        process.geteuid?.() ?? null,
      ]);
      expect(s.sync.mock.calls[0][0]).toBe("/vault/v/t");
      expect(s.space.mock.calls[0][0]).toBe("/vault/v/t");
      const runtime = h.runtime();
      expect(runtime).toMatchObject({
        config: {
          rootDir: "/vault/v",
          lockFd: 5,
          idleTimeoutMs: 4294967296,
          headroomBytes: 1024,
        },
      });
      expect(runtime?.lockIdentity).toEqual({ dev: 0x803n, ino: 42n });
      for (const value of [runtime, runtime?.config, runtime?.lockIdentity])
        expect(Object.isFrozen(value)).toBe(true);
      expect(logs).not.toHaveBeenCalled();
    },
  );
  it("BT9 exactly one real unref timer, and none for FLAG_OFF", async () => {
    jest.useRealTimers();
    const timer = jest.spyOn(global, "setTimeout");
    const s = setup();
    const pending = deferred<LockFacts>();
    s.lock.mockReturnValue(pending.promise);
    const h = s.startVaultBoot(env, roots);
    expect(timer).toHaveBeenCalledTimes(1);
    expect(timer.mock.calls[0][1]).toBe(s.VAULT_BOOT_DEADLINE_MS);
    expect(timer.mock.results[0].value.hasRef()).toBe(false);
    pending.resolve(lockFacts);
    await h.settled;
    timer.mockClear();
    await s.startVaultBoot({}, roots).settled;
    expect(timer).not.toHaveBeenCalled();
  });
  it("BT10 synchronous boundary: invalid env and timer setup failure do not escape", async () => {
    const s = setup();
    const bad = s.startVaultBoot(undefined as never, roots);
    await bad.settled;
    off(bad, "BOOT_CHECK_ERROR", "config", "UNKNOWN");
    jest.spyOn(global, "setTimeout").mockImplementation(() => {
      throw errno("EIO");
    });
    const h = s.startVaultBoot(env, roots);
    await h.settled;
    off(h, "BOOT_CHECK_ERROR", "boot", "EIO");
    expect(s.lock).not.toHaveBeenCalled();
  });
  it("BT10 undefined roots reaches the real collector and rejects as an operational root error", async () => {
    const s = setup();
    s.root.mockRestore();
    const h = s.startVaultBoot(env, undefined as never);
    await h.settled;
    off(h, "BOOT_CHECK_ERROR", "root", "UNKNOWN");
    expect(s.sync).not.toHaveBeenCalled();
  });
  it.each([null, 7, "x"])(
    "BT10 non-object env %j is a setup error, not deliberate FLAG_OFF",
    async (input) => {
      const s = setup();
      const h = s.startVaultBoot(input as never, roots);
      await h.settled;
      off(h, "BOOT_CHECK_ERROR", "config", "UNKNOWN");
      expect(s.lock).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it.each(["lock", "root", "sync", "space"] as const)(
    "BT11 late %s rejection remains observable, terminal and handled",
    async (step) => {
      const s = setup();
      const pending = deferred<never>();
      const unhandled = jest.fn();
      process.on("unhandledRejection", unhandled);
      try {
        s[step].mockReturnValue(pending.promise);
        const h = s.startVaultBoot(env, roots);
        await flush();
        jest.advanceTimersByTime(s.VAULT_BOOT_DEADLINE_MS);
        await h.settled;
        const before = diagnostic(h);
        logs.mockClear();
        pending.reject(errno("EIO"));
        await flush();
        expect(diagnostic(h)).toEqual(before);
        expect(logs).toHaveBeenCalledTimes(1);
        expect(logs).toHaveBeenCalledWith({
          event: "vault_boot",
          step: { lock: "lock", root: "root", sync: "fsync", space: "statfs" }[
            step
          ],
          code: "EIO",
          late: true,
        });
        expect(h).not.toHaveProperty("late");
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.removeListener("unhandledRejection", unhandled);
      }
    },
  );
  it.each(["sync", "space"] as const)(
    "BT11 late genuine %s FS outcome is not erased by settlement",
    async (step) => {
      const s = setup();
      const pending = deferred<Failure>();
      s[step].mockReturnValue(pending.promise);
      const h = s.startVaultBoot(env, roots);
      await flush();
      jest.advanceTimersByTime(s.VAULT_BOOT_DEADLINE_MS);
      await h.settled;
      logs.mockClear();
      pending.resolve({
        ok: false,
        outcome: "FS_ERROR",
        code: "EIO",
        ...(step === "sync" ? { closeCode: "ENOSPC" } : {}),
      });
      await flush();
      expect(logs).toHaveBeenCalledWith(
        expect.objectContaining({
          step: step === "sync" ? "fsync" : "statfs",
          code: "EIO",
          late: true,
          ...(step === "sync" ? { closeCode: "ENOSPC" } : {}),
        }),
      );
      expect(h.reason).toBe("BOOT_TIMEOUT");
      expect(h.runtime()).toBeNull();
      if (step === "sync") expect(s.space).not.toHaveBeenCalled();
    },
  );
  it("BT11 cleanup callback logs sanitized structured fields, no late buffer; SETTLED is not an error", async () => {
    const s = setup();
    const pending = deferred<Failure>();
    s.sync.mockReturnValue(pending.promise);
    const h = s.startVaultBoot(env, roots);
    await flush();
    const cleanup = s.sync.mock.calls[0][2];
    jest.advanceTimersByTime(s.VAULT_BOOT_DEADLINE_MS);
    await h.settled;
    logs.mockClear();
    cleanup({ step: "fsync-close", code: "EIO" });
    cleanup({ step: "fsync-close", code: "ESECRET123" });
    expect(logs.mock.calls).toEqual([
      [{ event: "vault_boot", step: "fsync-close", code: "EIO", late: true }],
      [
        {
          event: "vault_boot",
          step: "fsync-close",
          code: "UNKNOWN",
          late: true,
        },
      ],
    ]);
    logs.mockClear();
    pending.resolve({ ok: false, outcome: "SETTLED" });
    await flush();
    expect(logs).not.toHaveBeenCalled();
    expect(s.space).not.toHaveBeenCalled();
  });
});
