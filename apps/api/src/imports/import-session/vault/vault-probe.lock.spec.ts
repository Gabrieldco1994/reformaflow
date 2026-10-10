import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as ts from "typescript";
import {
  decideLockProof,
  type LockFacts,
  type LockFdFact,
  type LockPathFact,
} from "./vault-lock";

/**
 * B2a slice 4 RED (contract: b2a-slice4-lock-collector v1 + v2 + parent mediation; mediation > v2
 * > v1): `collectLockFacts(lockFd, lockPath, platform, isSettled): Promise<LockFacts>`, a future
 * `vault-probe.ts` that does not exist yet and that nobody imports. Portable (Mac and Linux).
 *
 * Provenance is labelled per test:
 * - REAL: real FS and real FileHandle in a private temp directory (0700), exact bigint values.
 * - DERIVED: a REAL BigIntStats descendant with dev/ino overridden (test-only, typed, methods
 *   kept). These are not captures of any OS.
 * - SYNTHETIC: an errno, a stall or a /proc text injected through a spy on the fs property.
 *
 * Instrument limits: a pending fstat is a LOGICAL stall of the test double, not a kernel or
 * threadpool hang; a Linux platform label on a Mac, or a synthetic fdinfo text, proves nothing
 * about Linux lock ownership. The operation order is pinned through an event log shared by the
 * spies and `isSettled`. Errors are compared by IDENTITY. A local try/catch that maps only the
 * expected code of that operation and rethrows is allowed; nothing here bans the syntax.
 *
 * The module is loaded lazily: while `vault-probe.ts` is absent the RED is an assertion on the
 * missing export, and a missing TRANSITIVE dependency is rethrown, never masked.
 */
type Collect = (
  lockFd: number | null,
  lockPath: string,
  platform: string,
  isSettled: () => boolean,
) => Promise<LockFacts>;

function isMissingProbeModule(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "MODULE_NOT_FOUND" &&
    String(Reflect.get(error, "message")).startsWith(
      "Cannot find module './vault-probe'",
    )
  );
}

function load(): Collect {
  let loaded: Record<string, unknown> | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("./vault-probe");
  } catch (error) {
    if (!isMissingProbeModule(error)) throw error;
  }
  expect(typeof loaded?.collectLockFacts).toBe("function");
  return (loaded as Record<string, unknown>).collectLockFacts as Collect;
}

const realFs = jest.requireActual<typeof import("node:fs")>("node:fs");
const originalFstat = realFs.fstat;
const originalLstat = realFs.promises.lstat;

const DEV_MAX = 18446744073709551615n;
const INO_ABOVE_2_53 = 9007199254740993n;
const TEXT = "pos:\t0\nflags:\t02400000\n";

// A bigint inside a failed matcher cannot be serialized by the jest worker and would turn an
// assertion failure into a suite error, so facts are rendered as text (and Number is visible).
const big = (value: unknown): string =>
  typeof value === "bigint"
    ? `${value}n`
    : `!bigint:${typeof value}:${String(value)}`;
const showNode = (node: LockFdFact | LockPathFact) =>
  node.kind === "file"
    ? { kind: node.kind, dev: big(node.dev), ino: big(node.ino) }
    : { kind: node.kind };
const show = (facts: LockFacts) => ({
  ...facts,
  fd: showNode(facts.fd),
  path: showNode(facts.path),
});
const OTHER: { kind: "other" } = { kind: "other" };
const conservative = (
  lockFd: number | null,
  platform: "linux" | "other",
): LockFacts => ({
  lockFd,
  platform,
  fd: OTHER,
  path: OTHER,
  fdinfo: null,
});
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code} (synthetic)`), { code });
const errorFor = (label: string): NodeJS.ErrnoException =>
  label === "RangeError"
    ? new RangeError("range (synthetic)")
    : label === "no code"
      ? new Error("no code (synthetic)")
      : errno(label);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** DERIVED: a real BigIntStats with dev/ino overridden; isFile() and the rest come from the real object. */
function withDevIno(real: BigIntStats, dev: bigint, ino: bigint): BigIntStats {
  return Object.create(real, {
    dev: { value: dev, enumerable: true },
    ino: { value: ino, enumerable: true },
  });
}

type Op = "fstat" | "lstat" | "readFile";
type Answer<T> =
  | { value: T }
  | { error: NodeJS.ErrnoException }
  | { throws: Error }
  | { hold: Promise<void> }
  | { gate: Promise<void>; error: NodeJS.ErrnoException };
interface Script {
  fstat?: (nth: number) => Answer<BigIntStats> | undefined;
  lstat?: (nth: number) => Answer<BigIntStats> | undefined;
  readFile?: (nth: number) => Answer<string> | undefined;
  /** isSettled answers true from its k-th call on. */
  settledFrom?: number;
  /** isSettled throws on its k-th call. */
  settledThrowsAt?: { call: number; error: Error };
}

function failing(op: Op, error: NodeJS.ErrnoException): Script {
  switch (op) {
    case "fstat":
      return { fstat: () => ({ error }) };
    case "lstat":
      return { lstat: () => ({ error }) };
    case "readFile":
      return { readFile: () => ({ error }) };
  }
}

const restorers: Array<() => void> = [];
let dir: string;
let lockPath: string;
let fh: FileHandle;
let stats0: BigIntStats;

/** Records the operation and answers as scripted; without an answer it delegates to the real fs. */
function harness(script: Script = {}) {
  const events: string[] = [];
  const count = { fstat: 0, lstat: 0, readFile: 0, settled: 0 };
  let settled = false;
  const isSettled = () => {
    count.settled += 1;
    events.push("settled");
    if (script.settledThrowsAt?.call === count.settled)
      throw script.settledThrowsAt.error;
    if (script.settledFrom !== undefined && count.settled >= script.settledFrom)
      settled = true;
    return settled;
  };
  const fstat = jest
    .spyOn(realFs, "fstat")
    .mockImplementation((fd, options, callback) => {
      events.push("fstat");
      const answer = script.fstat?.((count.fstat += 1));
      if (answer && "throws" in answer) throw answer.throws;
      if (answer && "gate" in answer) {
        void answer.gate.then(() =>
          setImmediate(() => callback(answer.error, stats0)),
        );
        return;
      }
      if (answer && "hold" in answer) {
        void answer.hold.then(() =>
          originalFstat(fd, options, (err, stats) =>
            setImmediate(() => callback(err, stats)),
          ),
        );
        return;
      }
      setImmediate(() => {
        if (!answer) return originalFstat(fd, options, callback);
        if ("error" in answer) return callback(answer.error, stats0);
        callback(null, answer.value);
      });
    });
  const lstat = jest
    .spyOn(realFs.promises, "lstat")
    .mockImplementation((path, options) => {
      events.push("lstat");
      const answer = script.lstat?.((count.lstat += 1));
      if (!answer) return originalLstat(path, options);
      if ("throws" in answer) throw answer.throws;
      if ("gate" in answer)
        return answer.gate.then(() => Promise.reject(answer.error));
      if ("error" in answer) return Promise.reject(answer.error);
      if ("hold" in answer)
        return answer.hold.then(() => originalLstat(path, options));
      return Promise.resolve(answer.value);
    });
  const readFile = jest
    .spyOn(realFs.promises, "readFile")
    .mockImplementation((path, options) => {
      events.push("readFile");
      const answer = script.readFile?.((count.readFile += 1)) ?? {
        value: TEXT,
      };
      if ("throws" in answer) throw answer.throws;
      if ("gate" in answer)
        return answer.gate.then(() => Promise.reject(answer.error));
      if ("error" in answer) return Promise.reject(answer.error);
      if ("hold" in answer) return answer.hold.then(() => TEXT);
      return Promise.resolve(answer.value);
    });
  return {
    events,
    isSettled,
    settle: () => {
      settled = true;
    },
    spies: { fstat, lstat, readFile },
  };
}

interface Seen {
  name: string;
  first: unknown;
}
const READS_AND_WRITES = [
  "close",
  "closeSync",
  "open",
  "openSync",
  "write",
  "writeSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "rename",
  "renameSync",
  "unlink",
  "unlinkSync",
  "mkdir",
  "mkdirSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "ftruncate",
  "ftruncateSync",
  "fsync",
  "fsyncSync",
  "truncate",
  "truncateSync",
  "readFile",
  "readFileSync",
  "stat",
  "statSync",
  "fstatSync",
  "lstat",
  "lstatSync",
];
const PROMISE_OPS = [
  "open",
  "writeFile",
  "appendFile",
  "rename",
  "unlink",
  "mkdir",
  "rm",
  "rmdir",
  "truncate",
  "stat",
];

/** Wraps (never mocks the result of) every fs entry the collector must not touch. */
function watchForbidden(): { unexpected: (fd: number | null) => string[] } {
  const seen: Seen[] = [];
  const wrap = (target: object, label: string, name: string) => {
    const original: unknown = Reflect.get(target, name);
    if (typeof original !== "function")
      throw new Error(`${label}${name} is missing`);
    const wrapper = function (this: unknown, ...args: unknown[]) {
      seen.push({ name: `${label}${name}`, first: args[0] });
      return Reflect.apply(original, this, args);
    };
    Reflect.set(target, name, wrapper);
    restorers.push(() => Reflect.set(target, name, original));
  };
  for (const name of READS_AND_WRITES) wrap(realFs, "fs.", name);
  for (const name of PROMISE_OPS) wrap(realFs.promises, "fs.promises.", name);
  return {
    unexpected: (fd) =>
      seen
        .filter(
          ({ first }) =>
            first === fd ||
            (typeof first === "string" &&
              (first === lockPath ||
                first.startsWith("/proc/") ||
                first.startsWith(dir))),
        )
        .map(({ name }) => name),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vault-probe-lock-"));
  realFs.chmodSync(dir, 0o700);
  lockPath = join(dir, ".lock");
  fh = await realFs.promises.open(lockPath, "w+", 0o600);
  await fh.write("keep");
  stats0 = await fh.stat({ bigint: true });
});

afterEach(async () => {
  jest.restoreAllMocks();
  while (restorers.length) restorers.pop()?.();
  await fh.close();
  rmSync(dir, { recursive: true, force: true });
});

const LINUX_FULL = [
  "settled",
  "fstat",
  "settled",
  "lstat",
  "settled",
  "readFile",
  "settled",
  "fstat",
  "settled",
];
const NON_LINUX_FULL = ["settled", "fstat", "settled", "lstat", "settled"];
const filePair = (dev: bigint, ino: bigint) =>
  ({ kind: "file", dev, ino }) as const;

describe("instrument controls (they pass today and prove nothing about the collector)", () => {
  it("the DERIVED stats keep the real methods and carry the exact bigint overrides", () => {
    const derived = withDevIno(stats0, DEV_MAX, INO_ABOVE_2_53);
    expect(big(derived.dev)).toBe("18446744073709551615n");
    expect(big(derived.ino)).toBe("9007199254740993n");
    expect(derived.isFile()).toBe(true);
    expect(derived.isSymbolicLink()).toBe(false);
    expect(derived.mode).toBe(stats0.mode);
    expect(stats0.ino).not.toBe(INO_ABOVE_2_53);
  });

  it("the harness delegates to the real fs when nothing is scripted", async () => {
    const h = harness();
    const stats = await new Promise<BigIntStats>((resolve, reject) =>
      realFs.fstat(fh.fd, { bigint: true }, (err, result) =>
        err ? reject(err) : resolve(result),
      ),
    );
    expect(big(stats.ino)).toBe(big(stats0.ino));
    expect(
      big((await realFs.promises.lstat(lockPath, { bigint: true })).ino),
    ).toBe(big(stats0.ino));
    expect(h.events).toEqual(["fstat", "lstat"]);
  });

  it("2^53+1 is not representable as a Number, so a Number transport is observable", () => {
    expect(BigInt(Number(INO_ABOVE_2_53))).not.toBe(INO_ABOVE_2_53);
  });
});

describe("C1 exact bigint facts", () => {
  it("REAL: fd and path carry the exact dev/ino of the file (non-Linux, no /proc)", async () => {
    const collect = load();
    const h = harness();
    const facts = await collect(fh.fd, lockPath, "darwin", h.isSettled);
    expect(show(facts)).toEqual(
      show({
        lockFd: fh.fd,
        platform: "other",
        fd: filePair(stats0.dev, stats0.ino),
        path: filePair(stats0.dev, stats0.ino),
        fdinfo: null,
      }),
    );
  });

  it("DERIVED: dev 2^64-1 and ino 2^53+1 reach fd and path as exact bigints", async () => {
    const collect = load();
    const derived = withDevIno(stats0, DEV_MAX, INO_ABOVE_2_53);
    const h = harness({
      fstat: () => ({ value: derived }),
      lstat: () => ({ value: derived }),
    });
    const facts = await collect(fh.fd, lockPath, "darwin", h.isSettled);
    expect(show(facts)).toEqual(
      show({
        lockFd: fh.fd,
        platform: "other",
        fd: filePair(DEV_MAX, INO_ABOVE_2_53),
        path: filePair(DEV_MAX, INO_ABOVE_2_53),
        fdinfo: null,
      }),
    );
  });
});

describe("C2 file types and the exact error map (per operation)", () => {
  it("REAL: a missing path is `missing` and the fd is still the file", async () => {
    const facts = await load()(
      fh.fd,
      join(dir, "absent"),
      "darwin",
      harness().isSettled,
    );
    expect(show(facts)).toEqual(
      show({
        lockFd: fh.fd,
        platform: "other",
        fd: filePair(stats0.dev, stats0.ino),
        path: { kind: "missing" },
        fdinfo: null,
      }),
    );
  });

  it("REAL: a path under a regular file (ENOTDIR) is `other`", async () => {
    const facts = await load()(
      fh.fd,
      join(lockPath, "child"),
      "darwin",
      harness().isSettled,
    );
    expect(showNode(facts.path)).toEqual({ kind: "other" });
  });

  it("REAL: a symlink to the lock file is `symlink` (lstat does not follow it)", async () => {
    const link = join(dir, "link");
    realFs.symlinkSync(lockPath, link);
    const facts = await load()(fh.fd, link, "darwin", harness().isSettled);
    expect(showNode(facts.path)).toEqual({ kind: "symlink" });
    expect(facts.fd.kind).toBe("file");
  });

  it("REAL: a directory as path is `other`; a directory FD is `other`", async () => {
    const dirHandle = await realFs.promises.open(dir, "r");
    try {
      const facts = await load()(
        dirHandle.fd,
        dir,
        "darwin",
        harness().isSettled,
      );
      expect(showNode(facts.fd)).toEqual({ kind: "other" });
      expect(showNode(facts.path)).toEqual({ kind: "other" });
    } finally {
      await dirHandle.close();
    }
  });

  it("REAL: an identified FD that was just closed (real EBADF, nothing opened in between) is fd `other`", async () => {
    const closed = await realFs.promises.open(join(dir, "closed"), "w");
    const closedFd = closed.fd;
    await closed.close();
    const facts = await load()(
      closedFd,
      lockPath,
      "darwin",
      harness().isSettled,
    );
    expect(show(facts)).toEqual(
      show({
        lockFd: closedFd,
        platform: "other",
        fd: OTHER,
        path: filePair(stats0.dev, stats0.ino),
        fdinfo: null,
      }),
    );
  });

  it("SYNTHETIC: fstat EBADF is fd `other`", async () => {
    const h = harness({ fstat: () => ({ error: errno("EBADF") }) });
    const facts = await load()(fh.fd, lockPath, "darwin", h.isSettled);
    expect(showNode(facts.fd)).toEqual({ kind: "other" });
    expect(facts.path.kind).toBe("file");
  });

  it("SYNTHETIC: lstat ENOENT is `missing`; lstat ENOTDIR is `other`", async () => {
    const collect = load();
    const missing = harness({ lstat: () => ({ error: errno("ENOENT") }) });
    expect(
      (await collect(fh.fd, lockPath, "darwin", missing.isSettled)).path,
    ).toEqual({
      kind: "missing",
    });
    jest.restoreAllMocks();
    const notDir = harness({ lstat: () => ({ error: errno("ENOTDIR") }) });
    expect(
      (await collect(fh.fd, lockPath, "darwin", notDir.isSettled)).path,
    ).toEqual({
      kind: "other",
    });
  });

  it("SYNTHETIC: readFile ENOENT on /proc is fdinfo null", async () => {
    const h = harness({ readFile: () => ({ error: errno("ENOENT") }) });
    const facts = await load()(fh.fd, lockPath, "linux", h.isSettled);
    expect(facts.fdinfo).toBeNull();
    expect(facts.platform).toBe("linux");
    expect(facts.fd.kind).toBe("file");
  });

  const REJECTS: Record<Op, string[]> = {
    fstat: [
      "EIO",
      "EACCES",
      "ELOOP",
      "ENAMETOOLONG",
      "no code",
      "RangeError",
      "ENOENT",
      "ENOTDIR",
    ],
    lstat: [
      "EIO",
      "EACCES",
      "ELOOP",
      "ENAMETOOLONG",
      "no code",
      "RangeError",
      "EBADF",
    ],
    readFile: [
      "EIO",
      "EACCES",
      "ELOOP",
      "ENAMETOOLONG",
      "no code",
      "RangeError",
      "EBADF",
    ],
  };
  const PREFIX: Record<Op, string[]> = {
    fstat: ["settled", "fstat"],
    lstat: ["settled", "fstat", "settled", "lstat"],
    readFile: ["settled", "fstat", "settled", "lstat", "settled", "readFile"],
  };
  const rows = (Object.keys(REJECTS) as Op[]).flatMap((op) =>
    REJECTS[op].map((label): [Op, string] => [op, label]),
  );
  it.each(rows)(
    "SYNTHETIC: %s failing with %s rejects with the SAME error and runs nothing after it",
    async (op, label) => {
      const error = errorFor(label);
      const h = harness(failing(op, error));
      await expect(load()(fh.fd, lockPath, "linux", h.isSettled)).rejects.toBe(
        error,
      );
      expect(h.events).toEqual(PREFIX[op]);
    },
  );
});

describe("C2b synchronous throws also reject the promise (never throw out of the call)", () => {
  it.each(["fstat", "lstat", "readFile"] as const)(
    "SYNTHETIC: %s throwing synchronously rejects with the SAME error",
    async (op) => {
      const error = new RangeError("sync throw (synthetic)");
      const script: Script =
        op === "fstat"
          ? { fstat: () => ({ throws: error }) }
          : op === "lstat"
            ? { lstat: () => ({ throws: error }) }
            : { readFile: () => ({ throws: error }) };
      const h = harness(script);
      const call = load()(fh.fd, lockPath, "linux", h.isSettled);
      await expect(call).rejects.toBe(error);
    },
  );
});

describe("C3 an invalid lockFd is zero I/O and lockFd null", () => {
  it.each([null, NaN, Infinity, -1, 0, 1, 2, 2.5, 2 ** 53])(
    "SYNTHETIC: lockFd %s touches no fs entry and is NO_LOCK_FD",
    async (invalid) => {
      const collect = load();
      const h = harness();
      const watch = watchForbidden();
      const facts = await collect(invalid, lockPath, "linux", h.isSettled);
      expect(h.spies.fstat).not.toHaveBeenCalled();
      expect(h.spies.lstat).not.toHaveBeenCalled();
      expect(h.spies.readFile).not.toHaveBeenCalled();
      expect(watch.unexpected(invalid)).toEqual([]);
      expect(show(facts)).toEqual(show(conservative(null, "linux")));
      expect(decideLockProof(facts)).toEqual({
        ok: false,
        reason: "NO_LOCK_FD",
      });
    },
  );

  it.each([3, 9])(
    "SYNTHETIC: lockFd %s passes the guard and reaches fstat with bigint options",
    async (valid) => {
      const h = harness({ fstat: () => ({ value: stats0 }) });
      const facts = await load()(valid, lockPath, "darwin", h.isSettled);
      expect(h.spies.fstat).toHaveBeenCalledTimes(1);
      expect(h.spies.fstat).toHaveBeenCalledWith(
        valid,
        { bigint: true },
        expect.any(Function),
      );
      expect(facts.lockFd).toBe(valid);
    },
  );
});

describe("C4 /proc is read on Linux only, with the exact arguments", () => {
  it.each([
    ["REAL FS fd with SYNTHETIC platform label and fdinfo text", false],
    ["SYNTHETIC fd 12 (fstat scripted)", true],
  ] as const)(
    "linux with %s: readFile once with ('/proc/self/fdinfo/<fd>', 'utf8')",
    async (_label, synthetic) => {
      const fd = synthetic ? 12 : fh.fd;
      const h = harness(synthetic ? { fstat: () => ({ value: stats0 }) } : {});
      const facts = await load()(fd, lockPath, "linux", h.isSettled);
      expect(h.spies.readFile).toHaveBeenCalledTimes(1);
      expect(h.spies.readFile).toHaveBeenCalledWith(
        `/proc/self/fdinfo/${fd}`,
        "utf8",
      );
      expect(facts.platform).toBe("linux");
      expect(facts.fdinfo).toBe(TEXT);
    },
  );

  it.each(["darwin", "win32", "freebsd", "Linux", ""])(
    "platform %j is `other`: no /proc read of any kind, fd and path still real, NO_FDINFO",
    async (platform) => {
      const collect = load();
      const h = harness();
      const watch = watchForbidden();
      const facts = await collect(fh.fd, lockPath, platform, h.isSettled);
      expect(h.spies.readFile).not.toHaveBeenCalled();
      expect(watch.unexpected(fh.fd)).toEqual([]);
      expect(show(facts)).toEqual(
        show({
          lockFd: fh.fd,
          platform: "other",
          fd: filePair(stats0.dev, stats0.ino),
          path: filePair(stats0.dev, stats0.ino),
          fdinfo: null,
        }),
      );
      expect(decideLockProof(facts)).toEqual({
        ok: false,
        reason: "NO_FDINFO",
      });
    },
  );

  it("SYNTHETIC text without a lock line, on the same real file: LOCK_NOT_OWNED (not Linux evidence)", async () => {
    const h = harness();
    const facts = await load()(fh.fd, lockPath, "linux", h.isSettled);
    expect(decideLockProof(facts)).toEqual({
      ok: false,
      reason: "LOCK_NOT_OWNED",
    });
  });
});

describe("C5 isSettled before every operation and once more after the last", () => {
  // k-th call of isSettled answers true: the events end right after that call.
  const AFTER: Array<[number, number]> = [
    [1, 1],
    [2, 3],
    [3, 5],
    [4, 7],
    [5, 9],
  ];

  it.each(AFTER)(
    "SYNTHETIC: isSettled true from call %i on gives CONSERVADOR after only the operations before it",
    async (call, length) => {
      const h = harness({ settledFrom: call });
      const facts = await load()(fh.fd, lockPath, "linux", h.isSettled);
      expect(h.events).toEqual(LINUX_FULL.slice(0, length));
      expect(show(facts)).toEqual(show(conservative(fh.fd, "linux")));
      expect(decideLockProof(facts).ok).toBe(false);
    },
  );

  it.each(AFTER)(
    "SYNTHETIC: isSettled throwing on call %i rejects with the SAME error and runs nothing after it",
    async (call, length) => {
      const error = new RangeError("isSettled (synthetic)");
      const h = harness({ settledThrowsAt: { call, error } });
      await expect(load()(fh.fd, lockPath, "linux", h.isSettled)).rejects.toBe(
        error,
      );
      expect(h.events).toEqual(LINUX_FULL.slice(0, length));
    },
  );

  it("REAL FS + SYNTHETIC platform label and fdinfo text: the exact event log on Linux with a valid FD (settled precedes every op, and a final check)", async () => {
    const h = harness();
    const facts = await load()(fh.fd, lockPath, "linux", h.isSettled);
    expect(h.events).toEqual(LINUX_FULL);
    expect(facts.fd.kind).toBe("file");
  });

  it("REAL: the exact event log off Linux has no /proc read and no recheck", async () => {
    const h = harness();
    await load()(fh.fd, lockPath, "darwin", h.isSettled);
    expect(h.events).toEqual(NON_LINUX_FULL);
  });

  it("SYNTHETIC: a first fstat EBADF skips the recheck but still reads lstat and /proc, then the final check", async () => {
    const h = harness({ fstat: () => ({ error: errno("EBADF") }) });
    await load()(fh.fd, lockPath, "linux", h.isSettled);
    expect(h.events).toEqual([
      "settled",
      "fstat",
      "settled",
      "lstat",
      "settled",
      "readFile",
      "settled",
    ]);
  });

  it("REAL FS (a directory FD) + SYNTHETIC platform label and fdinfo text: a first fstat that is not a regular file skips the recheck too", async () => {
    const dirHandle = await realFs.promises.open(dir, "r");
    try {
      const h = harness();
      const facts = await load()(dirHandle.fd, lockPath, "linux", h.isSettled);
      expect(showNode(facts.fd)).toEqual({ kind: "other" });
      expect(h.events).toEqual([
        "settled",
        "fstat",
        "settled",
        "lstat",
        "settled",
        "readFile",
        "settled",
      ]);
    } finally {
      await dirHandle.close();
    }
  });
});

describe("C6 the recheck compares dev AND ino independently (it detects, it does not close a window)", () => {
  const FIRST_DEV = DEV_MAX;
  const FIRST_INO = 9007199254740992n;
  const run = (second: Answer<BigIntStats>) => {
    const first = withDevIno(stats0, FIRST_DEV, FIRST_INO);
    const h = harness({
      fstat: (nth) => (nth === 1 ? { value: first } : second),
    });
    return { h, call: load()(fh.fd, lockPath, "linux", h.isSettled) };
  };
  const derived = (dev: bigint, ino: bigint) => ({
    value: withDevIno(stats0, dev, ino),
  });

  it("DERIVED: the same dev and ino twice is `file` with the exact bigints", async () => {
    const { call } = run(derived(FIRST_DEV, FIRST_INO));
    expect(showNode((await call).fd)).toEqual(
      showNode(filePair(FIRST_DEV, FIRST_INO)),
    );
  });

  it("DERIVED: same dev, ino differing only past 2^53 is `other` (a Number compare would miss it)", async () => {
    const { call } = run(derived(FIRST_DEV, 9007199254740993n));
    const facts = await call;
    expect(showNode(facts.fd)).toEqual({ kind: "other" });
    expect(decideLockProof(facts).ok).toBe(false);
  });

  it("DERIVED: same ino, dev differing only past 2^53 is `other`", async () => {
    const { call } = run(derived(DEV_MAX - 1n, FIRST_INO));
    expect(showNode((await call).fd)).toEqual({ kind: "other" });
  });

  it("DERIVED: a different dev and a different ino is `other`", async () => {
    const { call } = run(derived(1n, 2n));
    expect(showNode((await call).fd)).toEqual({ kind: "other" });
  });

  it("SYNTHETIC: EBADF on the recheck is `other`", async () => {
    const { call } = run({ error: errno("EBADF") });
    expect(showNode((await call).fd)).toEqual({ kind: "other" });
  });

  it("SYNTHETIC: EIO on the recheck rejects with the SAME error", async () => {
    const error = errno("EIO");
    const { h, call } = run({ error });
    await expect(call).rejects.toBe(error);
    expect(h.events).toEqual(LINUX_FULL.slice(0, 8));
  });
});

describe("C7 a stalled operation is a pending promise; a late answer after settled starts nothing", () => {
  it("SYNTHETIC (logical stall of the double, not a kernel hang): the promise stays pending and no next operation starts; released in finally", async () => {
    const stall = deferred();
    const h = harness({ fstat: () => ({ hold: stall.promise }) });
    const call = load()(fh.fd, lockPath, "linux", h.isSettled);
    let state = "pending";
    void call.then(
      () => (state = "resolved"),
      () => (state = "rejected"),
    );
    try {
      await tick();
      await tick();
      expect(state).toBe("pending");
      expect(h.events).toEqual(["settled", "fstat"]);
      expect(h.spies.lstat).not.toHaveBeenCalled();
      expect(h.spies.readFile).not.toHaveBeenCalled();
    } finally {
      h.settle();
      stall.resolve();
      await call.catch(() => undefined);
    }
  });

  it("SYNTHETIC: a late fstat answer after isSettled resolves CONSERVADOR without lstat or /proc", async () => {
    const stall = deferred();
    const h = harness({ fstat: () => ({ hold: stall.promise }) });
    const call = load()(fh.fd, lockPath, "linux", h.isSettled);
    try {
      await tick();
      h.settle();
    } finally {
      stall.resolve();
    }
    const facts = await call;
    expect(show(facts)).toEqual(show(conservative(fh.fd, "linux")));
    expect(h.events).toEqual(["settled", "fstat", "settled"]);
    expect(h.spies.lstat).not.toHaveBeenCalled();
    expect(h.spies.readFile).not.toHaveBeenCalled();
    expect(decideLockProof(facts).ok).toBe(false);
  });
});

describe("C7b an operational error that arrives AFTER isSettled still rejects", () => {
  it("SYNTHETIC: fstat started, isSettled turns true, then EIO is released: the SAME error rejects and no next I/O starts", async () => {
    const started = deferred();
    const gate = deferred();
    const error = errno("EIO");
    const h = harness({
      fstat: () => {
        started.resolve();
        return { gate: gate.promise, error };
      },
    });
    const call = load()(fh.fd, lockPath, "linux", h.isSettled);
    const outcome = call.then(
      () => "resolved",
      (rejected: unknown) => rejected,
    );
    try {
      await started.promise;
      h.settle();
    } finally {
      gate.resolve();
    }
    expect(await outcome).toBe(error);
    expect(h.events).toEqual(["settled", "fstat"]);
    expect(h.spies.lstat).not.toHaveBeenCalled();
    expect(h.spies.readFile).not.toHaveBeenCalled();
  });
});

describe("C10 collect -> decide seam on Linux (DERIVED dev/ino, SYNTHETIC platform label and fdinfo; not a Linux capture)", () => {
  const LINE =
    "lock:\t1: FLOCK ADVISORY WRITE 123 ffffffff:ffffffff:9007199254740993 0 EOF\n";

  it("every LockFacts field is exact and decideLockProof authorizes the owner", async () => {
    const derived = withDevIno(stats0, DEV_MAX, INO_ABOVE_2_53);
    const h = harness({
      fstat: () => ({ value: derived }),
      lstat: () => ({ value: derived }),
      readFile: () => ({ value: LINE }),
    });
    const facts = await load()(fh.fd, lockPath, "linux", h.isSettled);
    expect(show(facts)).toEqual(
      show({
        lockFd: fh.fd,
        platform: "linux",
        fd: filePair(DEV_MAX, INO_ABOVE_2_53),
        path: filePair(DEV_MAX, INO_ABOVE_2_53),
        fdinfo: LINE,
      }),
    );
    expect(decideLockProof(facts)).toEqual({ ok: true });
    expect(h.events).toEqual(LINUX_FULL);
  });
});

describe("C8 the inherited FD and the lock file are never touched", () => {
  it("REAL: nothing is closed, opened, written or renamed, and the FD keeps its state and bytes", async () => {
    const collect = load();
    const before = await fh.stat({ bigint: true });
    const h = harness();
    const watch = watchForbidden();
    await collect(fh.fd, lockPath, "linux", h.isSettled);
    expect(watch.unexpected(fh.fd)).toEqual([]);
    const after = await fh.stat({ bigint: true });
    expect(big(after.size)).toBe(big(before.size));
    expect(big(after.mtimeNs)).toBe(big(before.mtimeNs));
    expect(big(after.ino)).toBe(big(before.ino));
    const bytes = Buffer.alloc(4);
    await fh.read(bytes, 0, 4, 0);
    expect(bytes.toString()).toBe("keep");
  });
});

interface Scan {
  runtimeImports: string[];
  typeImports: string[];
  dynamic: string[];
  identifiers: Set<string>;
  members: Set<string>;
  calls: string[];
}

/** AST scan: comments and strings are never identifiers, so wording cannot trip or hide a rule. */
function scan(source: string): Scan {
  const file = ts.createSourceFile(
    "probe.ts",
    source,
    ts.ScriptTarget.ES2021,
    true,
  );
  const out: Scan = {
    runtimeImports: [],
    typeImports: [],
    dynamic: [],
    identifiers: new Set(),
    members: new Set(),
    calls: [],
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((element) => element.isTypeOnly)));
      const spec = node.moduleSpecifier.text;
      if (typeOnly) out.typeImports.push(spec);
      else if (bindings && ts.isNamespaceImport(bindings))
        out.runtimeImports.push(`${spec} as * ${bindings.name.text}`);
      else out.runtimeImports.push(`${spec} (not a namespace import)`);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      out.runtimeImports.push(
        `re-export ${node.moduleSpecifier.getText(file)}`,
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      out.dynamic.push("import =");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword)
        out.dynamic.push("import()");
      else if (ts.isIdentifier(callee)) {
        if (callee.text === "require") out.dynamic.push("require");
        out.calls.push(callee.text);
      }
    }
    if (ts.isPropertyAccessExpression(node)) out.members.add(node.name.text);
    if (
      ts.isIdentifier(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    )
      out.identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

const FORBIDDEN_IDENTIFIERS = [
  "Date",
  "performance",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "process",
  "require",
  "Logger",
  "console",
];
const FORBIDDEN_MEMBERS = [
  "O_CREAT",
  "close",
  "open",
  "write",
  "writeFile",
  "appendFile",
  "mkdir",
  "unlink",
  "rename",
  "rm",
  "rmdir",
  "truncate",
  "ftruncate",
  "fsync",
  "copyFile",
  "symlink",
  "link",
  "chmod",
  "chown",
  "utimes",
  "futimes",
  "createReadStream",
  "createWriteStream",
];
const NUMBER_TRANSPORT = ["Number", "parseInt", "parseFloat"];

function probeSource(): string {
  const path = join(__dirname, "vault-probe.ts");
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8");
}

describe("C9 static shape of vault-probe.ts (AST, not text; try/catch is NOT banned)", () => {
  const SAMPLE = `// setTimeout Date console.log closeSync
import * as fs from "node:fs";
import type { LockFacts } from "./vault-lock";
const text = "fs.closeSync(1) Number(1) console";
try { fs.fstat(1, { bigint: true }, () => undefined); } catch (error) { throw error; }
fs.closeSync(1); setTimeout(() => 0, 1); new Date(); Number(3); require("x"); const guard = Number.isSafeInteger(1);`;

  it("control (passes today): the scanner sees real uses, ignores comments and strings, and does not flag try/catch or Number.isSafeInteger", () => {
    const seen = scan(SAMPLE);
    expect(seen.runtimeImports).toEqual(["node:fs as * fs"]);
    expect(seen.typeImports).toEqual(["./vault-lock"]);
    expect(seen.dynamic).toEqual(["require"]);
    expect(
      [...seen.identifiers]
        .filter((name) => FORBIDDEN_IDENTIFIERS.includes(name))
        .sort(),
    ).toEqual(["Date", "require", "setTimeout"]);
    expect(seen.members.has("closeSync")).toBe(true);
    expect(seen.members.has("isSafeInteger")).toBe(true);
    expect(seen.identifiers.has("console")).toBe(false);
    expect(
      seen.calls.filter((name) => NUMBER_TRANSPORT.includes(name)),
    ).toEqual(["Number"]);
  });

  it("imports exactly the baseline (`node:fs`; types ./vault-lock) or the future pair (adds `node:path` and ./vault-root), never anything else", () => {
    const seen = scan(probeSource());
    const BASELINE = [["node:fs as * fs"], ["./vault-lock"]];
    const FUTURO = [
      ["node:fs as * fs", "node:path as * path"],
      ["./vault-lock", "./vault-root"],
    ];
    expect([BASELINE, FUTURO]).toContainEqual([
      seen.runtimeImports,
      [...new Set(seen.typeImports)],
    ]);
    expect(seen.dynamic).toEqual([]);
  });

  it("has no clock, timer, process, logger, console or require", () => {
    const seen = scan(probeSource());
    expect(
      [...seen.identifiers].filter((name) =>
        FORBIDDEN_IDENTIFIERS.includes(name),
      ),
    ).toEqual([]);
  });

  it("uses no *Sync call and no open/close/write/rename/unlink/mkdir/rm-family member, no O_CREAT", () => {
    const seen = scan(probeSource());
    expect(
      [...seen.members].filter(
        (name) => name.endsWith("Sync") || FORBIDDEN_MEMBERS.includes(name),
      ),
    ).toEqual([]);
  });

  it("carries bigint as bigint: no Number()/parseInt/parseFloat call", () => {
    expect(
      scan(probeSource()).calls.filter((name) =>
        NUMBER_TRANSPORT.includes(name),
      ),
    ).toEqual([]);
  });

  it("only the inactive boot may import vault-probe (exact baseline or future)", () => {
    const srcRoot = join(__dirname, "..", "..", "..");
    const offenders: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "dist")
            walk(path);
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.startsWith("vault-probe.")
        ) {
          const imported = ts.preProcessFile(
            readFileSync(path, "utf8"),
            true,
            true,
          ).importedFiles;
          if (imported.some((item) => item.fileName.endsWith("vault-probe")))
            offenders.push(path);
        }
      }
    };
    walk(srcRoot);
    expect([[], [join(__dirname, "vault-boot.ts")]]).toContainEqual(offenders);
  });
});
