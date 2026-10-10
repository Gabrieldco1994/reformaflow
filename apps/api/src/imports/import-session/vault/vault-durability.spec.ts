import {
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import type { BigIntStatsFs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canonical, type RootFacts } from "./vault-root";

type FsFailure = {
  ok: false;
  outcome: "FS_ERROR";
  code: string;
  closeCode?: string;
};
type Settled = { ok: false; outcome: "SETTLED" };
interface Durability {
  boundedCode(error: unknown): string;
  fsyncProbe(
    dir: string,
    settled: () => boolean,
    cleanup: (error: { step: "fsync-close"; code: string }) => void,
  ): Promise<{ ok: true } | FsFailure | Settled>;
  availableBytes(
    dir: string,
    settled: () => boolean,
  ): Promise<
    | { ok: true; available: bigint }
    | FsFailure
    | Settled
    | { ok: false; outcome: "INVALID_STATFS" }
  >;
}
function load(): Durability {
  expect({
    module: "vault-durability",
    exists: existsSync(join(__dirname, "vault-durability.ts")),
  }).toEqual({ module: "vault-durability", exists: true });
  return jest.requireActual<Durability>("./vault-durability");
}
const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
const probes = jest.requireActual<{
  collectRootFacts(
    root: string,
    uploads: Pick<RootFacts["resolved"], "publicDir" | "privateDir">,
    euid: number | null,
    settled: () => boolean,
  ): Promise<RootFacts>;
}>("./vault-probe");
const realOpen = fs.promises.open;
const realStatfs = fs.promises.statfs;
const errno = (code: string) =>
  Object.assign(new Error("private /secret/path"), { code });
const failure = (code: string, closeCode?: string): FsFailure => ({
  ok: false,
  outcome: "FS_ERROR",
  code,
  ...(closeCode ? { closeCode } : {}),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let tmp: string;
let t: string;
let handles: FileHandle[];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vault-durability-"));
  chmodSync(tmp, 0o700);
  t = join(tmp, "t");
  mkdirSync(t, { mode: 0o700 });
  handles = [];
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const handle of handles) if (handle.fd !== -1) await handle.close();
  const evidence = process.env.VAULT_BOOT_TEST_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    cpSync(tmp, join(evidence, basename(tmp)), {
      recursive: true,
      dereference: false,
    });
  }
  rmSync(tmp, { recursive: true, force: true });
});

// Real OS FileHandles only. Spies wrap their own properties, never their prototype or a fake FD.
function instrument(
  options: {
    syncError?: string;
    closeError?: string;
    syncGate?: Promise<void>;
    closeGate?: Promise<void>;
    openGate?: Promise<void>;
  } = {},
) {
  const events: string[] = [];
  const opened = deferred<FileHandle>();
  const synced = deferred<void>();
  const closing = deferred<void>();
  const open = jest
    .spyOn(fs.promises, "open")
    .mockImplementation(async (path, flags, mode) => {
      expect(path).toBe(t);
      expect(flags).toBe(
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      events.push("open");
      const handle = await realOpen(path, flags, mode);
      handles.push(handle);
      const syncReal = handle.sync.bind(handle),
        closeReal = handle.close.bind(handle);
      jest.spyOn(handle, "sync").mockImplementation(async () => {
        events.push("sync");
        synced.resolve();
        await options.syncGate;
        if (options.syncError) throw errno(options.syncError);
        await syncReal();
      });
      jest.spyOn(handle, "close").mockImplementation(async () => {
        events.push("close");
        closing.resolve();
        await options.closeGate;
        await closeReal();
        if (options.closeError) throw errno(options.closeError);
      });
      opened.resolve(handle);
      await options.openGate;
      return handle;
    });
  return { open, opened, synced, closing, events };
}

describe("durability PB2-PB5: real Mac/host FS, injected failures labelled synthetic", () => {
  it("PB2a REAL: open -> sync -> close, empty t, own descriptor closed", async () => {
    const d = load();
    const i = instrument();
    await expect(d.fsyncProbe(t, () => false, jest.fn())).resolves.toEqual({
      ok: true,
    });
    expect(i.events).toEqual(["open", "sync", "close"]);
    expect((await i.opened.promise).fd).toBe(-1);
    expect(readdirSync(t)).toEqual([]);
  });
  it.each([
    ["EIO", undefined, failure("EIO")],
    [undefined, "EBADF", failure("EBADF")],
    ["EIO", "ENOSPC", failure("EIO", "ENOSPC")],
  ] as const)(
    "PB2b/c/d SYNTHETIC sync=%s close=%s, close exactly once",
    async (syncError, closeError, expected) => {
      const d = load();
      const i = instrument({ syncError, closeError });
      await expect(d.fsyncProbe(t, () => false, jest.fn())).resolves.toEqual(
        expected,
      );
      expect(i.events).toEqual(["open", "sync", "close"]);
      expect((await i.opened.promise).fd).toBe(-1);
    },
  );
  it("PB2e late open skips sync and closes only the owned handle, never borrowed .lock", async () => {
    const d = load();
    const borrowed = await realOpen(join(tmp, ".lock"), "wx", 0o600);
    handles.push(borrowed);
    const borrowedClose = jest.spyOn(borrowed, "close");
    const gate = deferred<void>();
    const i = instrument({ openGate: gate.promise });
    let settled = false;
    const pending = d.fsyncProbe(t, () => settled, jest.fn());
    await i.opened.promise;
    settled = true;
    gate.resolve();
    await expect(pending).resolves.toEqual({ ok: false, outcome: "SETTLED" });
    expect(i.events).toEqual(["open", "close"]);
    expect(borrowedClose).not.toHaveBeenCalled();
    expect((await borrowed.stat()).isFile()).toBe(true);
  });
  it.each([undefined, "EIO"])(
    "PB2f callback throw after open retains identity; cleanup failure %s is separate",
    async (closeError) => {
      const d = load();
      const i = instrument({ closeError });
      const cleanup = jest.fn();
      // Looks like an OS errno to expose accidental callback capture in an FS catch.
      const sentinel = errno("ENOENT");
      let calls = 0;
      await expect(
        d.fsyncProbe(
          t,
          () => {
            if (++calls === 2) throw sentinel;
            return false;
          },
          cleanup,
        ),
      ).rejects.toBe(sentinel);
      expect(i.events).toEqual(["open", "close"]);
      if (closeError)
        expect(cleanup).toHaveBeenCalledWith({
          step: "fsync-close",
          code: "EIO",
        });
      else expect(cleanup).not.toHaveBeenCalled();
    },
  );
  it("PB2f cleanup callback throws by identity, never recategorized as an FS error", async () => {
    const d = load();
    const i = instrument({ closeError: "EIO" });
    const sentinel = errno("ENOENT"),
      cleanupSentinel = errno("ENOTDIR");
    let calls = 0;
    await expect(
      d.fsyncProbe(
        t,
        () => {
          if (++calls === 2) throw sentinel;
          return false;
        },
        () => {
          throw cleanupSentinel;
        },
      ),
    ).rejects.toBe(cleanupSentinel);
    expect(i.events).toEqual(["open", "close"]);
  });
  it("PB2f/h before-open callback throw/settled never opens", async () => {
    const d = load();
    const i = instrument();
    const sentinel = errno("ENOENT");
    await expect(
      d.fsyncProbe(
        t,
        () => {
          throw sentinel;
        },
        jest.fn(),
      ),
    ).rejects.toBe(sentinel);
    await expect(d.fsyncProbe(t, () => true, jest.fn())).resolves.toEqual({
      ok: false,
      outcome: "SETTLED",
    });
    expect(i.open).not.toHaveBeenCalled();
  });
  it.each(["absent", "file", "symlink"] as const)(
    "PB2g REAL invalid t=%s cannot open a directory (symlink errno is OS-dependent)",
    async (kind) => {
      const d = load();
      rmSync(t, { recursive: true });
      if (kind === "file") writeFileSync(t, "", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(tmp, t);
      const i = instrument();
      const result = await d.fsyncProbe(t, () => false, jest.fn());
      if (kind === "symlink")
        expect([failure("ELOOP"), failure("ENOTDIR")]).toContainEqual(result);
      else
        expect(result).toEqual(
          failure(kind === "absent" ? "ENOENT" : "ENOTDIR"),
        );
      expect(i.events).toEqual(["open"]);
      expect(handles).toHaveLength(0);
    },
  );
  it("PB2j checks settlement before open, before sync and after close", async () => {
    const d = load();
    const i = instrument();
    const settled = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await expect(d.fsyncProbe(t, settled, jest.fn())).resolves.toEqual({
      ok: false,
      outcome: "SETTLED",
    });
    expect(settled).toHaveBeenCalledTimes(3);
    expect(i.events).toEqual(["open", "sync", "close"]);
  });
  it.each(["sync", "close"] as const)(
    "PB2 close gate: result waits for real %s completion, never early ok",
    async (at) => {
      const d = load();
      const gate = deferred<void>();
      const i = instrument(
        at === "sync"
          ? { syncGate: gate.promise }
          : { closeGate: gate.promise },
      );
      let answered = false;
      const pending = d
        .fsyncProbe(t, () => false, jest.fn())
        .then((result) => {
          answered = true;
          return result;
        });
      await (at === "sync" ? i.synced.promise : i.closing.promise);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      expect(answered).toBe(false);
      gate.resolve();
      await expect(pending).resolves.toEqual({ ok: true });
      expect(i.events).toEqual(["open", "sync", "close"]);
    },
  );
  it.each([
    ["EIO", undefined, failure("EIO")],
    [undefined, "ENOSPC", failure("ENOSPC")],
    ["EIO", "ENOSPC", failure("EIO", "ENOSPC")],
  ] as const)(
    "PB2 genuine late FS errors survive SETTLED: sync %s close %s",
    async (syncError, closeError, expected) => {
      const d = load();
      const gate = deferred<void>();
      const i = instrument({ syncGate: gate.promise, syncError, closeError });
      let settled = false;
      const pending = d.fsyncProbe(t, () => settled, jest.fn());
      await i.synced.promise;
      settled = true;
      gate.resolve();
      await expect(pending).resolves.toEqual(expected);
      expect(i.events).toEqual(["open", "sync", "close"]);
    },
  );
  it("PB2 late open error is not replaced by SETTLED", async () => {
    const d = load();
    const gate = deferred<void>();
    const entered = deferred<void>();
    jest.spyOn(fs.promises, "open").mockImplementation(async (path) => {
      expect(path).toBe(t);
      entered.resolve();
      await gate.promise;
      throw errno("EIO");
    });
    let settled = false;
    const pending = d.fsyncProbe(t, () => settled, jest.fn());
    await entered.promise;
    settled = true;
    gate.resolve();
    await expect(pending).resolves.toEqual(failure("EIO"));
  });
  it("PB3 REAL statfs(t,{bigint:true}) uses bavail*bsize", async () => {
    const d = load();
    let captured: BigIntStatsFs | undefined;
    const spy = jest
      .spyOn(fs.promises, "statfs")
      .mockImplementation(async (path, options) => {
        expect(path).toBe(t);
        expect(options).toEqual({ bigint: true });
        captured = await realStatfs(path, { bigint: true });
        return captured;
      });
    const result = await d.availableBytes(t, () => false);
    expect(spy).toHaveBeenCalledWith(t, { bigint: true });
    expect(captured).toBeDefined();
    expect(result).toEqual({
      ok: true,
      available: captured!.bavail * captured!.bsize,
    });
  });
  it.each([
    [3n, 4096n, 12288n],
    [0n, 4096n, 0n],
    [2n ** 40n, 4096n, 4503599627370496n],
    [2n ** 64n - 1n, 4096n, 75557863725914323415040n],
  ])(
    "PB3 SYNTHETIC exact BigInt %s * %s = %s",
    async (bavail, bsize, available) => {
      const d = load();
      const real = await realStatfs(t, { bigint: true });
      jest
        .spyOn(fs.promises, "statfs")
        .mockResolvedValue({ ...real, bavail, bsize });
      await expect(d.availableBytes(t, () => false)).resolves.toEqual({
        ok: true,
        available,
      });
    },
  );
  it.each([
    { bavail: 3n, bsize: 0n },
    { bavail: 3n, bsize: -1n },
    { bavail: -1n, bsize: 4096n },
    { bavail: 3, bsize: 4096 },
    {},
    undefined,
  ])(
    "PB3 invalid statfs vector %# is an internal outcome, not an errno",
    async (vector) => {
      const d = load();
      // Malformed external data, deliberately outside Node's declared return type.
      jest.spyOn(fs.promises, "statfs").mockResolvedValue(vector as never);
      await expect(d.availableBytes(t, () => false)).resolves.toEqual({
        ok: false,
        outcome: "INVALID_STATFS",
      });
    },
  );
  it.each(["ENOENT", "ESECRET123"])(
    "PB3 statfs failure %s and late failure remain visible",
    async (code) => {
      const d = load();
      let settled = false;
      jest.spyOn(fs.promises, "statfs").mockImplementation(async () => {
        settled = true;
        throw errno(code);
      });
      await expect(d.availableBytes(t, () => settled)).resolves.toEqual(
        failure(code === "ENOENT" ? code : "UNKNOWN"),
      );
    },
  );
  it("PB3 settlement before/after statfs suppresses work/value, callback throws remain by identity", async () => {
    const d = load();
    const real = await realStatfs(t, { bigint: true });
    const spy = jest.spyOn(fs.promises, "statfs").mockResolvedValue(real);
    await expect(d.availableBytes(t, () => true)).resolves.toEqual({
      ok: false,
      outcome: "SETTLED",
    });
    expect(spy).not.toHaveBeenCalled();
    const settled = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await expect(d.availableBytes(t, settled)).resolves.toEqual({
      ok: false,
      outcome: "SETTLED",
    });
    const sentinel = errno("ENOENT");
    let calls = 0;
    await expect(
      d.availableBytes(t, () => {
        if (++calls === 2) throw sentinel;
        return false;
      }),
    ).rejects.toBe(sentinel);
  });
  it.each([
    [null, "UNKNOWN"],
    ["x", "UNKNOWN"],
    [7, "UNKNOWN"],
    [undefined, "UNKNOWN"],
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
    [{ code: "SETTLED" }, "UNKNOWN"],
    [{ code: "INVALID_STATFS" }, "UNKNOWN"],
    [{ code: "ENOSPC" }, "ENOSPC"],
    [{ code: "EIO" }, "EIO"],
  ])("PB4 finite errno allowlist, hostile vector %#", (input, expected) => {
    expect(load().boundedCode(input)).toBe(expected);
  });
  it.each(["/a/b", "/a//b/", "/a/./b/../b", "/a/b//"])(
    "PB5 RB-D1 real collector uses canonical lexical input %s",
    async (raw) => {
      const spy = jest
        .spyOn(fs.promises, "lstat")
        .mockRejectedValue(errno("ENOENT"));
      // Stop after the first operation: no host path outside the owned fixture is actually read.
      let queries = 0;
      await probes.collectRootFacts(
        raw,
        { publicDir: "/uploads", privateDir: "/private" },
        501,
        () => ++queries > 1,
      );
      expect(canonical(raw)).toBe("/a/b");
      expect(spy.mock.calls).toEqual([[canonical(raw)]]);
    },
  );
});
