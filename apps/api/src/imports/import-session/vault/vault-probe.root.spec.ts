import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Stats } from "node:fs";
import express from "express";
import { resolveUploadsRoots } from "../../../common/uploads-roots";
import { classifyRootFacts, type FsNode, type RootFacts } from "./vault-root";

/**
 * B2a slice 5 RED, AMENDED (contract: b2a-slice5-root-collector v1, v2, v3 and parent mediations;
 * final mediation v2 > v3 > first mediation > v2 > v1): `collectRootFacts(rootDir, roots, euid,
 * isSettled): Promise<RootFacts>`, a future addition to `vault-probe.ts` that does not exist yet
 * and that nobody imports. Portable (POSIX).
 *
 * EFFECTIVE roots (final mediation): all three roots, the vault root included, are normalized
 * lexically (`posix.normalize`, no terminal slash except `/`) BEFORE any filesystem lookup, which
 * is what serve-static (`path.resolve`) and `path.join` do for their consumers; the four node
 * lstats use that same effective vault root. The existing prefix is then resolved with
 * `fs.promises.realpath` and the missing suffix appended. Every candidate whose realpath failed
 * with ENOENT/ENOTDIR is lstat-ed before climbing: it climbs only on ENOENT/ENOTDIR, and an
 * existing candidate (a dangling symlink, or a race) makes the resolution INDETERMINATE, which
 * returns the inert sentinel (raw captured inputs, four absent nodes, never OK). This inverts the
 * c102d2d9 spec (snapshot e0968171) at exactly: RR3(c2) both cases, the old raw-V mediation
 * positive, RR3(f) `////`, and every event log that contains a missing root (an lstat after each
 * failed realpath). The old raw-V positive now FAILS the policy (outside holds only `link`).
 *
 * Provenance is labelled per test:
 * - REAL: real FS in a private temp directory (0700); expectations use literal modes/UIDs and
 *   anchors computed with `fs.realpathSync.native` (the kernel lookup; the JS `fs.realpathSync` normalizes `link/..` lexically first and would be a wrong oracle), never with the collector's own algorithm.
 * - DERIVED: a REAL `fs.Stats` descendant (methods kept) with `mode`/`uid` overridden, or the real
 *   stat of another real node delivered for a different path. These are not OS captures.
 * - SYNTHETIC: an errno, a stall or a scripted answer injected through a spy on the fs property.
 *
 * Instrument limits: a pending lstat is a LOGICAL stall of the test double, not a kernel or
 * threadpool hang; the suite proves the seam between path lookups and facts on this platform
 * (Mac/Node24 here), not Linux, not the production mount and not the absence of races. The
 * operation order is pinned through an event log shared by the spies and `isSettled`. Errors are
 * compared by IDENTITY.
 *
 * Not certified here: Linux, HTTP exposure of the public root, internal aliases below a root, ABA
 * and races, and the future launcher/FD/bootstrap/writer agreement on the effective vault root.
 * Consumer path construction is characterized in uploads-roots.characterization.spec.ts.
 *
 * The export is loaded lazily: while `collectRootFacts` is absent the RED is an assertion on the
 * missing export (the module itself loads, `collectLockFacts` is the control), and a missing
 * TRANSITIVE dependency is rethrown, never masked.
 */
type RootsArg = Pick<RootFacts["resolved"], "publicDir" | "privateDir">;
type CollectRoot = (
  rootDir: string,
  roots: RootsArg,
  euid: number | null,
  isSettled: () => boolean,
) => Promise<RootFacts>;

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

function loadModule(): Record<string, unknown> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("./vault-probe");
  } catch (error) {
    if (!isMissingProbeModule(error)) throw error;
    return undefined;
  }
}

function load(): CollectRoot {
  const loaded = loadModule();
  const found = loaded?.collectRootFacts;
  expect(typeof found).toBe("function");
  if (typeof found !== "function") throw new Error("unreachable");
  return (...args) => Reflect.apply(found, undefined, args);
}

const realFs = jest.requireActual<typeof import("node:fs")>("node:fs");
const originalLstat = realFs.promises.lstat;
const originalRealpath = realFs.promises.realpath;

const euidFn = process.geteuid;
if (euidFn === undefined) throw new Error("POSIX only: no process.geteuid");
const E = euidFn.call(process);

const ABSENT: FsNode = { kind: "absent" };
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const typeBits = (node: FsNode): number =>
  node.kind === "absent" ? -1 : node.mode & S_IFMT;
const dirNode = (mode = 0o40700, uid = E): FsNode => ({
  kind: "dir",
  mode,
  uid,
});
const fileNode = (mode = 0o100600, uid = E): FsNode => ({
  kind: "file",
  mode,
  uid,
});
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code} (synthetic)`), { code });
const errorFor = (label: string): Error =>
  label === "RangeError"
    ? new RangeError("range (synthetic)")
    : label === "TypeError"
      ? new TypeError("type (synthetic)")
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

/** DERIVED: a real Stats descendant with mode/uid overridden; isDirectory() and the rest are the real methods. */
function derive(real: Stats, over: { mode?: number; uid?: number }): Stats {
  const props: PropertyDescriptorMap = {};
  if (over.mode !== undefined)
    props.mode = { value: over.mode, enumerable: true };
  if (over.uid !== undefined) props.uid = { value: over.uid, enumerable: true };
  return Object.create(real, props);
}

type Answer<T> =
  | { value: T }
  | { error: Error }
  | { hold: Promise<void> }
  | { gate: Promise<void>; error: Error };
interface Script {
  lstat?: (nth: number, path: string) => Answer<Stats> | undefined;
  realpath?: (nth: number, path: string) => Answer<string> | undefined;
  /** isSettled answers true from its k-th call on. */
  settledFrom?: number;
  /** isSettled throws on its k-th call. */
  settledThrowsAt?: { call: number; error: Error };
}

const restorers: Array<() => void> = [];
let tmp: string;
let realTmp: string;
let realV: string;
let V: string;
let P: string;
let R: string;

/** Records every operation and answers as scripted; without an answer it delegates to the real fs. */
function harness(script: Script = {}) {
  const events: string[] = [];
  const waiters: Array<{ event: string; times: number; resolve: () => void }> =
    [];
  const occurrences = (event: string) =>
    events.filter((seen) => seen === event).length;
  const record = (event: string) => {
    events.push(event);
    for (const waiter of waiters)
      if (waiter.event === event && occurrences(event) >= waiter.times)
        waiter.resolve();
  };
  const count = { lstat: 0, realpath: 0, settled: 0 };
  let settled = false;
  const isSettled = () => {
    count.settled += 1;
    record("settled");
    if (script.settledThrowsAt?.call === count.settled)
      throw script.settledThrowsAt.error;
    if (script.settledFrom !== undefined && count.settled >= script.settledFrom)
      settled = true;
    return settled;
  };
  const lstat = jest
    .spyOn(realFs.promises, "lstat")
    .mockImplementation((path, options) => {
      const name = String(path);
      record(`lstat:${name}`);
      const answer = script.lstat?.((count.lstat += 1), name);
      if (!answer) return originalLstat(path, options);
      if ("gate" in answer)
        return answer.gate.then(() => Promise.reject(answer.error));
      if ("error" in answer) return Promise.reject(answer.error);
      if ("hold" in answer)
        return answer.hold.then(() => originalLstat(path, options));
      return Promise.resolve(answer.value);
    });
  const realpath = jest
    .spyOn(realFs.promises, "realpath")
    .mockImplementation((path, options) => {
      const name = String(path);
      record(`realpath:${name}`);
      const answer = script.realpath?.((count.realpath += 1), name);
      if (!answer) return originalRealpath(path, options);
      if ("gate" in answer)
        return answer.gate.then(() => Promise.reject(answer.error));
      if ("error" in answer) return Promise.reject(answer.error);
      if ("hold" in answer)
        return answer.hold.then(() => originalRealpath(path, options));
      return Promise.resolve(answer.value);
    });
  return {
    events,
    isSettled,
    /** Resolves once the operation has STARTED for the `times`-th time (deterministic; no tick counting). */
    reached: (event: string, times = 1) =>
      occurrences(event) >= times
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
            waiters.push({ event, times, resolve }),
          ),
    settle: () => {
      settled = true;
    },
    spies: { lstat, realpath },
  };
}

/** settled before every operation, and once more at the end. */
const withSettled = (ops: string[]) => [
  ...ops.flatMap((op) => ["settled", op]),
  "settled",
];
const nodeOps = (root: string) => [
  `lstat:${root}`,
  `lstat:${root}/.lock`,
  `lstat:${root}/t`,
  `lstat:${root}/trash`,
];
/**
 * The exact operations of a happy run over V with P and R missing: each failed realpath is followed
 * by an lstat of that candidate before climbing.
 */
const happyOps = () => [
  ...nodeOps(V),
  `realpath:${V}`,
  `realpath:${P}`,
  `lstat:${P}`,
  `realpath:${tmp}`,
  `realpath:${R}`,
  `lstat:${R}`,
  `realpath:${tmp}`,
];
const happyEvents = () => withSettled(happyOps());
const prefixThroughOp = (index: number) =>
  happyEvents().slice(0, 2 * (index + 1));
const SETTLED_CALLS = 12;

const happyFacts = (over: Partial<RootFacts> = {}): RootFacts => ({
  euid: E,
  resolved: {
    root: realV,
    publicDir: `${realTmp}/uploads`,
    privateDir: `${realTmp}/private-uploads`,
  },
  root: dirNode(),
  lock: fileNode(),
  t: dirNode(),
  trash: dirNode(),
  ...over,
});
/** The inert guard/settled sentinel: captured raw inputs, all four nodes absent. Never an observation. */
const sentinel = (
  euid: number | null,
  root: string,
  publicDir: string,
  privateDir: string,
): RootFacts => ({
  euid,
  resolved: { root, publicDir, privateDir },
  root: ABSENT,
  lock: ABSENT,
  t: ABSENT,
  trash: ABSENT,
});

function makeVault(dir: string) {
  realFs.mkdirSync(dir);
  realFs.chmodSync(dir, 0o700);
  realFs.writeFileSync(join(dir, ".lock"), "");
  realFs.chmodSync(join(dir, ".lock"), 0o600);
  for (const name of ["t", "trash"]) {
    realFs.mkdirSync(join(dir, name));
    realFs.chmodSync(join(dir, name), 0o700);
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vault-probe-root-"));
  realFs.chmodSync(tmp, 0o700);
  realTmp = realFs.realpathSync.native(tmp);
  V = join(tmp, "vault");
  P = join(tmp, "uploads");
  R = join(tmp, "private-uploads");
  makeVault(V);
  realV = realFs.realpathSync.native(V);
});

afterEach(() => {
  jest.restoreAllMocks();
  while (restorers.length) restorers.pop()?.();
  rmSync(tmp, { recursive: true, force: true });
});

const run = (
  collect: CollectRoot,
  rootDir: string,
  roots: RootsArg,
  euid: number | null,
  script: Script = {},
) => {
  const h = harness(script);
  return { h, done: collect(rootDir, roots, euid, h.isSettled) };
};

const ROOTS = () => ({ publicDir: P, privateDir: R });
const collectHappy = (
  collect: CollectRoot,
  script: Script = {},
  euid: number | null = E,
) => run(collect, V, ROOTS(), euid, script);

describe("controls (pass today: instrument, fixtures and seams only)", () => {
  it("the probe module loads and still exports the lock collector, so a missing collectRootFacts is a plain missing export", () => {
    const loaded = loadModule();
    expect(typeof loaded?.collectLockFacts).toBe("function");
  });

  it("REAL fixture: the vault tree has the literal modes the classifier wants", () => {
    expect(realFs.lstatSync(V).mode).toBe(0o40700);
    expect(realFs.lstatSync(`${V}/.lock`).mode).toBe(0o100600);
    expect(realFs.lstatSync(`${V}/t`).mode).toBe(0o40700);
    expect(realFs.lstatSync(`${V}/trash`).mode).toBe(0o40700);
    expect(realFs.lstatSync(V).uid).toBe(E);
    expect(realFs.existsSync(P)).toBe(false);
    expect(realFs.existsSync(R)).toBe(false);
    expect(classifyRootFacts(happyFacts())).toEqual({ ok: true });
  });

  it("the roots parameter accepts the UploadsRoots that resolveUploadsRoots returns (compile and value)", () => {
    const roots: RootsArg = resolveUploadsRoots({ UPLOADS_DIR: P }, tmp);
    expect(roots).toEqual({ publicDir: P, privateDir: R });
  });

  it("DERIVED stats keep the real methods and override only mode/uid", () => {
    const real = realFs.lstatSync(V);
    const derived = derive(real, { mode: 0o40755, uid: E + 1 });
    expect(derived.isDirectory()).toBe(true);
    expect(derived.isFile()).toBe(false);
    expect(derived.mode).toBe(0o40755);
    expect(derived.uid).toBe(E + 1);
    expect(derived.size).toBe(real.size);
    expect(derive(real, {}).mode).toBe(0o40700);
  });

  it("the harness delegates to the real fs and records the raw argument, unnormalized", async () => {
    const h = harness();
    const raw = `${tmp}/vault/../vault/.lock`;
    expect((await realFs.promises.lstat(raw)).mode).toBe(0o100600);
    expect(await realFs.promises.realpath(`${tmp}/vault/./t`)).toBe(
      `${realV}/t`,
    );
    expect(h.events).toEqual([`lstat:${raw}`, `realpath:${tmp}/vault/./t`]);
  });

  it("NATIVE kernel oracle (informative, NOT the criterion): `outside/link/..` is the vault natively, but the effective root is the lexical `outside`, and the classifier authorizes only the effective one", () => {
    const outside = join(tmp, "outside");
    realFs.mkdirSync(outside);
    realFs.symlinkSync(`${V}/t`, `${outside}/link`);
    const publicDir = `${outside}/link/..`;
    expect(realFs.realpathSync.native(publicDir)).toBe(realV);
    expect(posix.normalize(publicDir)).toBe(outside);
    const facts = happyFacts();
    expect(
      classifyRootFacts({
        ...facts,
        resolved: { ...facts.resolved, publicDir: posix.normalize(publicDir) },
      }),
    ).toEqual({ ok: true });
    expect(
      classifyRootFacts({
        ...facts,
        resolved: { ...facts.resolved, publicDir: realV },
      }),
    ).toEqual({ ok: false, step: "disjoint-public" });
  });

  it("Node behavior the contract leans on (a pin, not a consumer proof): resolve and join normalize `link/..` lexically", () => {
    expect(posix.resolve("/o/link/..")).toBe("/o");
    expect(posix.join("/o/link/..", "vehicle-documents")).toBe(
      "/o/vehicle-documents",
    );
    expect(posix.normalize("/o/missing/../link")).toBe("/o/link");
    expect(posix.normalize("////")).toBe("/");
  });

  it("the installed express.static consumer selects the LEXICAL root, not the raw-native one (loopback only, synthetic markers, own deadline and closure)", async () => {
    const pub = join(tmp, "pub");
    const deep = join(tmp, "elsewhere", "deep");
    realFs.mkdirSync(pub);
    realFs.mkdirSync(deep, { recursive: true });
    realFs.writeFileSync(join(pub, "marker.txt"), "LEXICAL-synthetic-marker");
    realFs.writeFileSync(
      join(tmp, "elsewhere", "marker.txt"),
      "NATIVE-synthetic-marker",
    );
    realFs.symlinkSync(deep, join(pub, "deeplink"));
    const root = `${pub}/deeplink/..`;
    expect(realFs.realpathSync.native(root)).toBe(
      realFs.realpathSync.native(join(tmp, "elsewhere")),
    );
    expect(resolveUploadsRoots({ UPLOADS_DIR: root }, tmp).publicDir).toBe(
      root,
    );
    const app = express();
    app.use(express.static(root));
    const server = http.createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("no loopback port");
      const answer = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            request.destroy();
            reject(new Error("deadline (synthetic loopback request)"));
          }, 3000);
          const request = http.get(
            {
              host: "127.0.0.1",
              port: address.port,
              path: "/marker.txt",
              agent: false,
            },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => {
                body += chunk;
              });
              response.on("end", () => {
                clearTimeout(timer);
                resolve({ status: response.statusCode ?? 0, body });
              });
            },
          );
          request.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        },
      );
      expect(answer).toEqual({ status: 200, body: "LEXICAL-synthetic-marker" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("GAP-8: the exported collector, once it exists, has exactly the contract signature (compile-time check; `absent` today)", () => {
    type Exported = typeof import("./vault-probe") extends {
      collectRootFacts: infer F;
    }
      ? F
      : never;
    type Status = [Exported] extends [never]
      ? "absent"
      : [Exported] extends [CollectRoot]
        ? [CollectRoot] extends [Exported]
          ? "exact"
          : "narrower-than-contract"
        : "incompatible";
    const accepted: Status extends "absent" | "exact" ? true : never = true;
    expect(accepted).toBe(true);
  });
});

describe("RR1 happy path (REAL fs)", () => {
  it("collects exactly the RootFacts shape with canonical resolved paths, and the seam classifies OK", async () => {
    const collect = load();
    const { done } = collectHappy(collect);
    const facts = await done;
    expect(facts).toEqual(happyFacts());
    expect(Object.keys(facts).sort()).toEqual([
      "euid",
      "lock",
      "resolved",
      "root",
      "t",
      "trash",
    ]);
    expect(Object.keys(facts.resolved).sort()).toEqual([
      "privateDir",
      "publicDir",
      "root",
    ]);
    expect(classifyRootFacts(facts)).toEqual({ ok: true });
  });

  it("an existing public root resolves to the same canonical path", async () => {
    const collect = load();
    realFs.mkdirSync(P);
    const { done } = collectHappy(collect);
    expect(await done).toEqual(happyFacts());
  });

  it("roots produced by resolveUploadsRoots drive the same collection", async () => {
    const collect = load();
    const roots = resolveUploadsRoots({ UPLOADS_DIR: P }, tmp);
    const { done } = run(collect, V, roots, E);
    expect(await done).toEqual(happyFacts());
  });

  it("a rootDir already given as the canonical path collects the same facts", async () => {
    const collect = load();
    const { done } = run(collect, realV, ROOTS(), E);
    expect(await done).toEqual(happyFacts());
  });
});

describe("RR2 node facts (REAL and DERIVED); the collector reports facts, the classifier decides", () => {
  it("REAL: a missing root makes all four nodes absent, with a canonical resolved root, and the verdict is `root`", async () => {
    const collect = load();
    const missing = join(tmp, "nothing-here");
    const { h, done } = run(collect, missing, ROOTS(), E);
    const facts = await done;
    // The canonical resolved root is observable in the lookups themselves (raw and real tmp differ
    // on macOS but not on Linux, so the facts alone could not tell an inert sentinel apart there).
    expect(h.events).toEqual(
      withSettled([
        ...nodeOps(missing),
        `realpath:${missing}`,
        `lstat:${missing}`,
        `realpath:${tmp}`,
        `realpath:${P}`,
        `lstat:${P}`,
        `realpath:${tmp}`,
        `realpath:${R}`,
        `lstat:${R}`,
        `realpath:${tmp}`,
      ]),
    );
    expect(facts).toEqual({
      ...happyFacts(),
      resolved: { ...happyFacts().resolved, root: `${realTmp}/nothing-here` },
      root: ABSENT,
      lock: ABSENT,
      t: ABSENT,
      trash: ABSENT,
    });
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "root" });
  });

  it("REAL: a root below a regular file (real ENOTDIR) is absent, four times, and resolves through the existing prefix", async () => {
    const collect = load();
    realFs.writeFileSync(join(tmp, "afile"), "x");
    const below = join(tmp, "afile", "vault");
    const { h, done } = run(collect, below, ROOTS(), E);
    const facts = await done;
    expect(h.events).toEqual(
      withSettled([
        ...nodeOps(below),
        `realpath:${below}`,
        `lstat:${below}`,
        `realpath:${tmp}/afile`,
        `realpath:${P}`,
        `lstat:${P}`,
        `realpath:${tmp}`,
        `realpath:${R}`,
        `lstat:${R}`,
        `realpath:${tmp}`,
      ]),
    );
    expect(facts.root).toEqual(ABSENT);
    expect(facts.lock).toEqual(ABSENT);
    expect(facts.t).toEqual(ABSENT);
    expect(facts.trash).toEqual(ABSENT);
    expect(facts.resolved.root).toBe(`${realTmp}/afile/vault`);
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "root" });
  });

  it("REAL: a symlink to the vault is a `symlink` node (lstat, not stat) and the verdict is `root`", async () => {
    const collect = load();
    const link = join(tmp, "vlink");
    realFs.symlinkSync(V, link);
    const { done } = run(collect, link, ROOTS(), E);
    const facts = await done;
    expect(typeBits(facts.root)).toBe(S_IFLNK);
    expect(facts.root).toMatchObject({ kind: "symlink", uid: E });
    expect(facts.resolved.root).toBe(realV);
    expect(facts.lock).toEqual(fileNode());
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "root" });
  });

  it("REAL: `.lock` as a directory is kind dir and the verdict is `lock`", async () => {
    const collect = load();
    realFs.rmSync(`${V}/.lock`);
    realFs.mkdirSync(`${V}/.lock`);
    realFs.chmodSync(`${V}/.lock`, 0o700);
    const facts = await collectHappy(collect).done;
    expect(facts.lock).toEqual(dirNode());
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "lock" });
  });

  it("REAL: `t` as a symlink is kind symlink and the verdict is `t`", async () => {
    const collect = load();
    realFs.rmdirSync(`${V}/t`);
    realFs.symlinkSync(`${V}/trash`, `${V}/t`);
    const facts = await collectHappy(collect).done;
    expect(typeBits(facts.t)).toBe(S_IFLNK);
    expect(facts.t.kind).toBe("symlink");
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "t" });
  });

  it("REAL: a missing `t` and a missing `trash` are absent and give `t` then `trash`", async () => {
    const collect = load();
    realFs.rmdirSync(`${V}/trash`);
    const noTrash = await collectHappy(collect).done;
    expect(noTrash.trash).toEqual(ABSENT);
    expect(noTrash.t).toEqual(dirNode());
    expect(classifyRootFacts(noTrash)).toEqual({ ok: false, step: "trash" });
    realFs.rmdirSync(`${V}/t`);
    const noT = await collectHappy(collect).done;
    expect(noT.t).toEqual(ABSENT);
    expect(classifyRootFacts(noT)).toEqual({ ok: false, step: "t" });
  });

  it("REAL: modes are reported RAW, type bits included: 0755 root and 0644 lock", async () => {
    const collect = load();
    realFs.chmodSync(V, 0o755);
    realFs.chmodSync(`${V}/.lock`, 0o644);
    const facts = await collectHappy(collect).done;
    expect(facts.root).toEqual(dirNode(0o40755));
    expect(facts.lock).toEqual(fileNode(0o100644));
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "root" });
    realFs.chmodSync(V, 0o700);
    const second = await collectHappy(collect).done;
    expect(second.lock).toEqual(fileNode(0o100644));
    expect(classifyRootFacts(second)).toEqual({ ok: false, step: "lock" });
  });

  it.each([
    ["root", () => V, "root"],
    ["lock", () => `${V}/.lock`, "lock"],
    ["t", () => `${V}/t`, "t"],
    ["trash", () => `${V}/trash`, "trash"],
  ] as const)(
    "DERIVED: a foreign uid on `%s` alone is reported exactly for that node and gives `%s`",
    async (name, target, step) => {
      const collect = load();
      const path = target();
      const real = realFs.lstatSync(path);
      const facts = await collectHappy(collect, {
        lstat: (_nth, asked) =>
          asked === path ? { value: derive(real, { uid: E + 1 }) } : undefined,
      }).done;
      const expected = happyFacts();
      const changed: FsNode =
        name === "lock" ? fileNode(0o100600, E + 1) : dirNode(0o40700, E + 1);
      expect(facts).toEqual({ ...expected, [name]: changed });
      expect(classifyRootFacts(facts)).toEqual({ ok: false, step });
    },
  );

  it("DERIVED: setuid on the lock is passed through RAW (0o104600) and gives `lock`", async () => {
    const collect = load();
    const real = realFs.lstatSync(`${V}/.lock`);
    const facts = await collectHappy(collect, {
      lstat: (_nth, path) =>
        path === `${V}/.lock`
          ? { value: derive(real, { mode: 0o104600 }) }
          : undefined,
    }).done;
    expect(facts.lock).toEqual(fileNode(0o104600));
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "lock" });
  });

  it("DERIVED: sticky on the root is passed through RAW (0o41700) and gives `root`", async () => {
    const collect = load();
    const real = realFs.lstatSync(V);
    const facts = await collectHappy(collect, {
      lstat: (nth) =>
        nth === 1 ? { value: derive(real, { mode: 0o41700 }) } : undefined,
    }).done;
    expect(facts.root).toEqual(dirNode(0o41700));
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "root" });
  });

  it("DERIVED: a character device stat delivered for the lock is `other` with its real mode and uid", async () => {
    const collect = load();
    const device = realFs.lstatSync("/dev/null");
    const facts = await collectHappy(collect, {
      lstat: (_nth, path) =>
        path === `${V}/.lock` ? { value: device } : undefined,
    }).done;
    expect(facts.lock).toEqual({
      kind: "other",
      mode: device.mode,
      uid: device.uid,
    });
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "lock" });
  });
});

type Which = "public" | "private";
const WHICH: readonly Which[] = ["public", "private"];
const rootsWith = (which: Which, value: string): RootsArg =>
  which === "public"
    ? { publicDir: value, privateDir: R }
    : { publicDir: P, privateDir: value };
const pick = (facts: RootFacts, which: Which) =>
  which === "public" ? facts.resolved.publicDir : facts.resolved.privateDir;
const refusal = (which: Which) => ({
  ok: false as const,
  step:
    which === "public"
      ? ("disjoint-public" as const)
      : ("disjoint-private" as const),
});
const baseName = (which: Which) =>
  which === "public" ? "uploads" : "private-uploads";
const rawOf = (which: Which) => (which === "public" ? P : R);
/** The ops the collector runs BEFORE it reaches the root under test (V, plus P when R is the subject). */
const before = (which: Which) =>
  which === "public"
    ? [...nodeOps(V), `realpath:${V}`]
    : [
        ...nodeOps(V),
        `realpath:${V}`,
        `realpath:${P}`,
        `lstat:${P}`,
        `realpath:${tmp}`,
      ];
const sentinelFor = (which: Which, raw: string) =>
  which === "public" ? sentinel(E, V, raw, R) : sentinel(E, V, P, raw);

function makeOutside(mode = 0o700): string {
  const outside = join(tmp, "outside");
  realFs.mkdirSync(outside);
  realFs.chmodSync(outside, mode);
  return outside;
}

describe("RR3 effective paths: lexical normalization BEFORE the lookup, the existing prefix resolved with fs.promises.realpath, the missing suffix appended", () => {
  describe.each(WHICH)("the %s root", (which) => {
    const collectFor = (collect: CollectRoot, value: string, rootDir = V) =>
      run(collect, rootDir, rootsWith(which, value), E);

    it("(a) REAL: a root that is a symlink into the vault resolves to the vault subdirectory and is refused", async () => {
      const collect = load();
      realFs.symlinkSync(`${V}/t`, rawOf(which));
      const facts = await collectFor(collect, rawOf(which)).done;
      expect(pick(facts, which)).toBe(`${realV}/t`);
      expect(classifyRootFacts(facts)).toEqual(refusal(which));
    });

    it("(b) REAL: a not-yet-existing directory under a symlink into the vault resolves below the vault and is refused", async () => {
      const collect = load();
      realFs.symlinkSync(V, join(tmp, "via-vault"));
      const facts = await collectFor(collect, `${tmp}/via-vault/newdir`).done;
      expect(pick(facts, which)).toBe(`${realV}/newdir`);
      expect(classifyRootFacts(facts)).toEqual(refusal(which));
    });

    it("(c) REAL: `${V}/t/x/..` with `x` missing is the effective `${realV}/t` and is refused", async () => {
      const collect = load();
      const facts = await collectFor(collect, `${V}/t/x/..`).done;
      expect(pick(facts, which)).toBe(`${realV}/t`);
      expect(classifyRootFacts(facts)).toEqual(refusal(which));
    });

    it("(c2, INVERTED) REAL: `outside/link/..` with link -> V/t is the lexical `outside` (what the consumers serve), disjoint from the vault and OK; the native lookup (the vault) is informative only", async () => {
      const collect = load();
      const outside = makeOutside();
      realFs.symlinkSync(`${V}/t`, `${outside}/link`);
      const raw = `${outside}/link/..`;
      expect(realFs.realpathSync.native(raw)).toBe(realV);
      const realOutside = realFs.realpathSync.native(outside);
      const facts = await collectFor(collect, raw).done;
      expect(pick(facts, which)).toBe(realOutside);
      expect(pick(facts, which)).not.toBe(realV);
      expect(classifyRootFacts(facts)).toEqual({ ok: true });
    });

    it("(c2, INVERTED) REAL: `outside/link/../newdir` lands below the lexical `outside`, OK", async () => {
      const collect = load();
      const outside = makeOutside();
      realFs.symlinkSync(`${V}/t`, `${outside}/link`);
      const facts = await collectFor(collect, `${outside}/link/../newdir`).done;
      expect(pick(facts, which)).toBe(
        `${realFs.realpathSync.native(outside)}/newdir`,
      );
      expect(classifyRootFacts(facts)).toEqual({ ok: true });
    });

    it("(inverse) REAL: a raw path under the vault whose `link/..` would natively ESCAPE is the effective path under the vault, and is refused", async () => {
      const collect = load();
      const deep = join(tmp, "elsewhere", "deep");
      realFs.mkdirSync(deep, { recursive: true });
      realFs.mkdirSync(`${V}/sub`);
      realFs.symlinkSync(deep, `${V}/sub/link`);
      const raw = `${V}/sub/link/..`;
      expect(realFs.realpathSync.native(raw)).toBe(
        realFs.realpathSync.native(join(tmp, "elsewhere")),
      );
      const facts = await collectFor(collect, raw).done;
      expect(pick(facts, which)).toBe(`${realV}/sub`);
      expect(classifyRootFacts(facts)).toEqual(refusal(which));
    });

    it.each([
      ["trailing slash", (base: string) => `${tmp}/${base}/`],
      ["double slash", (base: string) => `${tmp}//${base}`],
      ["trailing dot", (base: string) => `${tmp}/${base}/.`],
      ["dot and dotdot", (base: string) => `${tmp}/./${base}/../${base}`],
    ])(
      "(d) REAL: %s is canonical, without slashes or dots, and the vault stays OK",
      async (_label, build) => {
        const collect = load();
        const facts = await collectFor(collect, build(baseName(which))).done;
        expect(pick(facts, which)).toBe(`${realTmp}/${baseName(which)}`);
        expect(classifyRootFacts(facts)).toEqual({ ok: true });
      },
    );

    it("REAL: an EXISTING root resolves to the same canonical path", async () => {
      const collect = load();
      realFs.mkdirSync(rawOf(which));
      const facts = await collectFor(collect, rawOf(which)).done;
      expect(facts).toEqual(happyFacts());
      expect(classifyRootFacts(facts)).toEqual({ ok: true });
    });

    it("(g) REAL: a path below a regular file (real ENOTDIR) climbs to the existing prefix", async () => {
      const collect = load();
      realFs.writeFileSync(join(tmp, "afile"), "x");
      const facts = await collectFor(collect, `${tmp}/afile/sub`).done;
      expect(pick(facts, which)).toBe(`${realTmp}/afile/sub`);
    });

    describe("dangling symlinks (REAL): the resolution is INDETERMINATE and answers the inert sentinel of the raw inputs", () => {
      const dangling = () => {
        const outside = makeOutside();
        realFs.symlinkSync(`${V}/future-tenant`, `${outside}/link`);
        return outside;
      };

      it("(g) a dangling link as the root: sentinel, never OK, no climb past the link; a later mkdir of the target changes the verdict", async () => {
        const collect = load();
        const outside = dangling();
        const link = `${outside}/link`;
        const first = collectFor(collect, link);
        const facts = await first.done;
        expect(facts).toEqual(sentinelFor(which, link));
        expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "root" });
        expect(first.h.events).toEqual(
          withSettled([...before(which), `realpath:${link}`, `lstat:${link}`]),
        );
        // CONTROL (the parent's oracle): resolving the parent and appending the name would have said OK.
        const naive = happyFacts();
        expect(
          classifyRootFacts({
            ...naive,
            resolved: {
              ...naive.resolved,
              [which === "public" ? "publicDir" : "privateDir"]:
                `${realFs.realpathSync.native(outside)}/link`,
            },
          }),
        ).toEqual({ ok: true });
        realFs.mkdirSync(`${V}/future-tenant`);
        jest.restoreAllMocks();
        const after = await collectFor(collect, link).done;
        expect(pick(after, which)).toBe(`${realV}/future-tenant`);
        expect(classifyRootFacts(after)).toEqual(refusal(which));
      });

      it("(h) `outside/missing/../link` is the dangling `outside/link` after normalization: sentinel with the raw text verbatim", async () => {
        const collect = load();
        const outside = dangling();
        const raw = `${outside}/missing/../link`;
        const { h, done } = collectFor(collect, raw);
        const facts = await done;
        expect(facts).toEqual(sentinelFor(which, raw));
        expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "root" });
        expect(h.events).toEqual(
          withSettled([
            ...before(which),
            `realpath:${outside}/link`,
            `lstat:${outside}/link`,
          ]),
        );
      });

      it("(i) a lookup through the dangling link (`outside/link/sub`) climbs to the link and stops there: sentinel", async () => {
        const collect = load();
        const outside = dangling();
        const raw = `${outside}/link/sub`;
        const { h, done } = collectFor(collect, raw);
        const facts = await done;
        expect(facts).toEqual(sentinelFor(which, raw));
        expect(h.events).toEqual(
          withSettled([
            ...before(which),
            `realpath:${raw}`,
            `lstat:${raw}`,
            `realpath:${outside}/link`,
            `lstat:${outside}/link`,
          ]),
        );
      });
    });

    it.each(["ENOENT", "ENOTDIR", "EACCES", "no code"])(
      "REGRESSION (9cb): an isSettled callback throwing %s at the final ask of the indeterminate branch rejects with that SAME object: not an lstat absence, no climb, nothing more starts, never OK",
      async (label) => {
        const collect = load();
        const link = `${makeOutside()}/link`;
        realFs.symlinkSync(`${V}/future-tenant`, link);
        const ops = [...before(which), `realpath:${link}`, `lstat:${link}`];
        // The callback error is SYNTHETIC: it comes from the callback, never from the filesystem.
        const failure = errorFor(label);
        const { h, done } = run(collect, V, rootsWith(which, link), E, {
          settledThrowsAt: { call: ops.length + 1, error: failure },
        });
        await expect(done).rejects.toBe(failure);
        expect(h.events).toEqual(withSettled(ops));
      },
    );

    it.each(["dir", "file"])(
      "(l) SYNTHETIC race: realpath says ENOENT for a candidate that a REAL lstat then finds as a %s: indeterminate, sentinel (not OK, not a rejection)",
      async (kind) => {
        const collect = load();
        const target = rawOf(which);
        if (kind === "dir") realFs.mkdirSync(target);
        else realFs.writeFileSync(target, "x");
        const nth = which === "public" ? 2 : 4;
        const { h, done } = run(collect, V, rootsWith(which, target), E, {
          realpath: (n) => (n === nth ? { error: errno("ENOENT") } : undefined),
        });
        const facts = await done;
        expect(facts).toEqual(sentinelFor(which, target));
        expect(classifyRootFacts(facts).ok).toBe(false);
        expect(h.events).toEqual(
          withSettled([
            ...before(which),
            `realpath:${target}`,
            `lstat:${target}`,
          ]),
        );
      },
    );
  });

  it("(d) SYNTHETIC: rootDir `/` resolves to `/` and its first realpath is `/`", async () => {
    const collect = load();
    const h = harness({ lstat: () => ({ error: errno("ENOENT") }) });
    const facts = await collect("/", ROOTS(), E, h.isSettled);
    expect(facts.resolved.root).toBe("/");
    expect(facts.root).toEqual(ABSENT);
    expect(h.events.filter((e) => e.startsWith("realpath:"))[0]).toBe(
      "realpath:/",
    );
    expect(h.events.filter((e) => e.startsWith("lstat:"))[0]).toBe("lstat:/");
  });

  it("(e) REAL: a vault reached through a symlinked parent resolves to the real vault and is still a plain dir", async () => {
    const collect = load();
    realFs.symlinkSync(tmp, join(tmp, "via"));
    const { done } = run(collect, `${tmp}/via/vault`, ROOTS(), E);
    expect(await done).toEqual(happyFacts());
  });

  describe("(f) SYNTHETIC: termination is bounded, every lookup is absolute and each failed candidate is lstat-ed before climbing", () => {
    it("`/a/b` climbs `/a/b`, `/a`, then `/`, rejects with the SAME error and never lstat-s `/`", async () => {
      const collect = load();
      const failure = errno("ENOENT");
      const h = harness({
        lstat: () => ({ error: errno("ENOENT") }),
        realpath: () => ({ error: failure }),
      });
      await expect(collect("/a/b", ROOTS(), E, h.isSettled)).rejects.toBe(
        failure,
      );
      expect(h.events).toEqual(
        withSettled([
          ...nodeOps("/a/b"),
          "realpath:/a/b",
          "lstat:/a/b",
          "realpath:/a",
          "lstat:/a",
          "realpath:/",
        ]).slice(0, -1),
      );
    });

    it.each(["/", "////"])(
      "rootDir %j is `/` after normalization: realpath is asked only about `/`, the SAME error is rejected and `/` is never lstat-ed as a candidate",
      async (rootDir) => {
        const collect = load();
        const failure = errno("ENOENT");
        const h = harness({
          lstat: () => ({ error: errno("ENOENT") }),
          realpath: () => ({ error: failure }),
        });
        await expect(collect(rootDir, ROOTS(), E, h.isSettled)).rejects.toBe(
          failure,
        );
        const asked = h.events.filter((e) => e.startsWith("realpath:"));
        expect(asked).toEqual(["realpath:/"]);
        expect(h.events.filter((e) => e.startsWith("lstat:"))).toHaveLength(4);
        expect(h.events[h.events.length - 1]).toBe("realpath:/");
      },
    );

    it("a missing ancestor chain is climbed one component at a time, lstat-ing each candidate, with an exact bound", async () => {
      const collect = load();
      const h = harness({
        realpath: (_nth, path) =>
          path === tmp ? { value: realTmp } : { error: errno("ENOENT") },
      });
      const root = `${tmp}/p/q/r/s`;
      const facts = await collect(root, ROOTS(), E, h.isSettled);
      const ops = h.events.filter((e) => e !== "settled");
      const start = ops.indexOf(`realpath:${root}`);
      expect(ops.slice(start, start + 9)).toEqual([
        `realpath:${root}`,
        `lstat:${root}`,
        `realpath:${tmp}/p/q/r`,
        `lstat:${tmp}/p/q/r`,
        `realpath:${tmp}/p/q`,
        `lstat:${tmp}/p/q`,
        `realpath:${tmp}/p`,
        `lstat:${tmp}/p`,
        `realpath:${tmp}`,
      ]);
      expect(facts.resolved.root).toBe(`${realTmp}/p/q/r/s`);
    });
  });

  it("(k) REAL: a non-canonical vault root (`x/../vault/`) is looked up canonically: the four node lstats use the effective root and the facts equal the canonical ones", async () => {
    const collect = load();
    const { h, done } = run(collect, `${tmp}/x/../vault/`, ROOTS(), E);
    expect(await done).toEqual(happyFacts());
    expect(h.events.filter((e) => e.startsWith("lstat:")).slice(0, 4)).toEqual(
      nodeOps(V),
    );
  });

  it("(k2) REAL: `via-t/../vault` with via-t -> V/t is the lexical `tmp/vault`, not the native `V/vault` (absent)", async () => {
    const collect = load();
    realFs.symlinkSync(`${V}/t`, join(tmp, "via-t"));
    const { h, done } = run(collect, `${tmp}/via-t/../vault`, ROOTS(), E);
    expect(await done).toEqual(happyFacts());
    expect(h.events.filter((e) => e.startsWith("lstat:")).slice(0, 4)).toEqual(
      nodeOps(V),
    );
  });

  it("(k3, INVERTED old raw-V positive) REAL: `outside/link/..` as the VAULT root is the effective `outside`, which holds only `link`: its children are absent and the policy REFUSES (outside is not filled in to make it pass)", async () => {
    const collect = load();
    const outside = makeOutside();
    realFs.symlinkSync(`${V}/t`, `${outside}/link`);
    expect(realFs.readdirSync(outside)).toEqual(["link"]);
    const raw = `${outside}/link/..`;
    const { h, done } = run(collect, raw, ROOTS(), E);
    const facts = await done;
    expect(h.events.filter((e) => e.startsWith("lstat:")).slice(0, 4)).toEqual(
      nodeOps(outside),
    );
    expect(facts).toEqual({
      euid: E,
      resolved: {
        root: realFs.realpathSync.native(outside),
        publicDir: `${realTmp}/uploads`,
        privateDir: `${realTmp}/private-uploads`,
      },
      root: dirNode(0o40700),
      lock: ABSENT,
      t: ABSENT,
      trash: ABSENT,
    });
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "lock" });
  });
});

const NODE_NAMES = ["root", "lock", "t", "trash"] as const;
const absentAt = (node: (typeof NODE_NAMES)[number]): RootFacts => {
  const facts = happyFacts();
  return {
    ...facts,
    root: node === "root" ? ABSENT : facts.root,
    lock: node === "lock" ? ABSENT : facts.lock,
    t: node === "t" ? ABSENT : facts.t,
    trash: node === "trash" ? ABSENT : facts.trash,
  };
};
const REALPATH_TARGETS: ReadonlyArray<readonly [string, number, number]> = [
  ["root", 1, 4],
  ["public", 2, 5],
  ["public-parent", 3, 7],
  ["private", 4, 8],
  ["private-parent", 5, 10],
];
// The lstat of a candidate whose realpath failed: #5 is P (op 6), #6 is R (op 9).
const ASCENT_LSTATS: ReadonlyArray<readonly [string, number, number]> = [
  ["public", 5, 6],
  ["private", 6, 9],
];
const OP_ERRORS = [
  "EACCES",
  "ELOOP",
  "ENAMETOOLONG",
  "EIO",
  "EBADF",
  "no code",
  "RangeError",
  "TypeError",
];

describe("RR4 the error map is per operation and rejects by IDENTITY (SYNTHETIC)", () => {
  it.each(
    NODE_NAMES.flatMap((node, index) =>
      ["ENOENT", "ENOTDIR"].map((code) => [node, index, code] as const),
    ),
  )(
    "lstat %s (node index %i) with %s is `absent`, the other nodes are unaffected and the run completes",
    async (node, index, code) => {
      const collect = load();
      const { h, done } = collectHappy(collect, {
        lstat: (nth) =>
          nth === index + 1 ? { error: errno(code) } : undefined,
      });
      expect(await done).toEqual(absentAt(node));
      expect(h.events).toEqual(happyEvents());
    },
  );

  it.each(
    NODE_NAMES.flatMap((node, index) =>
      OP_ERRORS.map((label) => [node, index, label] as const),
    ),
  )(
    "lstat %s (node index %i) failing with %s rejects with the SAME error and nothing else starts",
    async (_node, index, label) => {
      const collect = load();
      const failure = errorFor(label);
      const { h, done } = collectHappy(collect, {
        lstat: (nth) => (nth === index + 1 ? { error: failure } : undefined),
      });
      await expect(done).rejects.toBe(failure);
      expect(h.events).toEqual(prefixThroughOp(index));
    },
  );

  // realpath attempts in a happy run: #1 root, #2 public (missing), #3 its parent, #4 private (missing), #5 its parent.
  it.each(
    REALPATH_TARGETS.flatMap(([name, nth, op]) =>
      OP_ERRORS.map((label) => [name, nth, op, label] as const),
    ),
  )(
    "realpath of the %s root (attempt #%i, op #%i) failing with %s rejects with the SAME error, without climbing",
    async (_name, nth, op, label) => {
      const collect = load();
      const failure = errorFor(label);
      const { h, done } = collectHappy(collect, {
        realpath: (n) => (n === nth ? { error: failure } : undefined),
      });
      await expect(done).rejects.toBe(failure);
      expect(h.events).toEqual(prefixThroughOp(op));
    },
  );

  it.each(
    ASCENT_LSTATS.flatMap(([name, nth]) =>
      ["ENOENT", "ENOTDIR"].map((code) => [name, nth, code] as const),
    ),
  )(
    "the climbing lstat of the %s candidate (lstat #%i) answering %s climbs and the run completes",
    async (_name, nth, code) => {
      const collect = load();
      const { h, done } = collectHappy(collect, {
        lstat: (n) => (n === nth ? { error: errno(code) } : undefined),
      });
      expect(await done).toEqual(happyFacts());
      expect(h.events).toEqual(happyEvents());
    },
  );

  it.each(
    ASCENT_LSTATS.flatMap(([name, nth, op]) =>
      [...OP_ERRORS, "EMFILE"].map((label) => [name, nth, op, label] as const),
    ),
  )(
    "the climbing lstat of the %s candidate (lstat #%i, op #%i) failing with %s rejects with the SAME error and nothing else starts",
    async (_name, nth, op, label) => {
      const collect = load();
      const failure = errorFor(label);
      const { h, done } = collectHappy(collect, {
        lstat: (n) => (n === nth ? { error: failure } : undefined),
      });
      await expect(done).rejects.toBe(failure);
      expect(h.events).toEqual(prefixThroughOp(op));
    },
  );

  it("REAL ELOOP (a -> b -> a) on the public root rejects with the very error realpath produced, never absent or sentinel", async () => {
    const collect = load();
    realFs.symlinkSync(`${tmp}/b`, `${tmp}/a`);
    realFs.symlinkSync(`${tmp}/a`, `${tmp}/b`);
    const { h, done } = run(
      collect,
      V,
      { publicDir: `${tmp}/a`, privateDir: R },
      E,
    );
    const rejection = await done.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(Reflect.get(Object(rejection), "code")).toBe("ELOOP");
    const reasons = await Promise.all(
      h.spies.realpath.mock.results.map((result) =>
        Promise.resolve(result.value).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );
    expect(reasons.filter((reason) => reason !== undefined)).toHaveLength(1);
    expect(reasons.find((reason) => reason !== undefined)).toBe(rejection);
    expect(h.events.filter((e) => e.startsWith("lstat:"))).toHaveLength(4);
  });

  it("an errno that is not the operation's mapped code (lstat EMFILE) rejects by identity", async () => {
    const collect = load();
    const failure = errno("EMFILE");
    const { done } = collectHappy(collect, {
      lstat: (nth) => (nth === 1 ? { error: failure } : undefined),
    });
    await expect(done).rejects.toBe(failure);
  });

  it("the lstat map does not leak into realpath: ELOOP or ENOSYS there also reject, never absent", async () => {
    const collect = load();
    for (const label of ["ELOOP", "ENOSYS"]) {
      const failure = errno(label);
      const { done } = collectHappy(collect, {
        realpath: (nth) => (nth === 1 ? { error: failure } : undefined),
      });
      await expect(done).rejects.toBe(failure);
      jest.restoreAllMocks();
    }
  });

  it.each(Array.from({ length: SETTLED_CALLS }, (_, index) => index + 1))(
    "isSettled throwing on its call #%i rejects with the SAME error and starts nothing after it",
    async (call) => {
      const collect = load();
      const failure = new Error("isSettled failed (synthetic)");
      const { h, done } = collectHappy(collect, {
        settledThrowsAt: { call, error: failure },
      });
      await expect(done).rejects.toBe(failure);
      const expected = happyEvents();
      let seenSettled = 0;
      const cut = expected.findIndex((event) => {
        if (event === "settled") seenSettled += 1;
        return seenSettled === call;
      });
      expect(h.events).toEqual(expected.slice(0, cut + 1));
    },
  );
});

describe("RR5 isSettled is asked before every operation and once more at the end", () => {
  it("REAL: the exact event log of the happy run (raw lookups, then the resolutions, then FINAL)", async () => {
    const collect = load();
    const { h, done } = collectHappy(collect);
    await done;
    expect(h.events).toEqual([
      "settled",
      `lstat:${V}`,
      "settled",
      `lstat:${V}/.lock`,
      "settled",
      `lstat:${V}/t`,
      "settled",
      `lstat:${V}/trash`,
      "settled",
      `realpath:${V}`,
      "settled",
      `realpath:${P}`,
      "settled",
      `lstat:${P}`,
      "settled",
      `realpath:${tmp}`,
      "settled",
      `realpath:${R}`,
      "settled",
      `lstat:${R}`,
      "settled",
      `realpath:${tmp}`,
      "settled",
    ]);
  });

  it.each(Array.from({ length: SETTLED_CALLS }, (_, index) => index + 1))(
    "settled from call #%i on: nothing new starts and the answer is the inert sentinel of the raw inputs, never OK",
    async (from) => {
      const collect = load();
      const { h, done } = collectHappy(collect, { settledFrom: from });
      const facts = await done;
      expect(facts).toEqual(sentinel(E, V, P, R));
      expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "root" });
      const expected = happyEvents();
      let seenSettled = 0;
      const cut = expected.findIndex((event) => {
        if (event === "settled") seenSettled += 1;
        return seenSettled === from;
      });
      expect(h.events).toEqual(expected.slice(0, cut + 1));
    },
  );

  it("with a null euid the sentinel keeps the null and the verdict names `euid`", async () => {
    const collect = load();
    const { done } = collectHappy(collect, { settledFrom: 1 }, null);
    const facts = await done;
    expect(facts).toEqual(sentinel(null, V, P, R));
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "euid" });
  });
});

describe("RR6 inputs: captured as given, guarded without I/O, euid passed through", () => {
  // Built lazily: V, P and R only exist once beforeEach has run.
  const RAW_CASES: Array<[string, () => [string, RootsArg]]> = [
    ["a relative root", () => ["vault", { publicDir: P, privateDir: R }]],
    ["an empty root", () => ["", { publicDir: P, privateDir: R }]],
    ["a root with NUL", () => [`${V}\0x`, { publicDir: P, privateDir: R }]],
    [
      "a relative public root",
      () => [V, { publicDir: "uploads", privateDir: R }],
    ],
    ["an empty public root", () => [V, { publicDir: "", privateDir: R }]],
    [
      "a public root with NUL",
      () => [V, { publicDir: `${P}\0`, privateDir: R }],
    ],
    [
      "a relative private root",
      () => [V, { publicDir: P, privateDir: "private" }],
    ],
    ["an empty private root", () => [V, { publicDir: P, privateDir: "" }]],
    [
      "a private root with NUL",
      () => [V, { publicDir: P, privateDir: `\0${R}` }],
    ],
  ];

  it.each(RAW_CASES)(
    "%s: no lstat and no realpath, the inert sentinel of the raw inputs, never OK",
    async (_label, build) => {
      const collect = load();
      const [rootDir, roots] = build();
      expect(roots.publicDir).not.toBeUndefined();
      expect(roots.privateDir).not.toBeUndefined();
      const { h, done } = run(collect, rootDir, roots, E);
      const facts = await done;
      expect(h.spies.lstat).not.toHaveBeenCalled();
      expect(h.spies.realpath).not.toHaveBeenCalled();
      expect(facts).toEqual(
        sentinel(E, rootDir, roots.publicDir, roots.privateDir),
      );
      expect(classifyRootFacts(facts).ok).toBe(false);
    },
  );

  it("frozen inputs are never written and give the same facts", async () => {
    const collect = load();
    const roots = Object.freeze({ publicDir: P, privateDir: R });
    const { done } = run(collect, V, roots, E);
    expect(await done).toEqual(happyFacts());
    expect(roots).toEqual({ publicDir: P, privateDir: R });
  });

  it("a null euid is repassed as null, the collection still completes and the verdict is `euid`", async () => {
    const collect = load();
    const facts = await collectHappy(collect, {}, null).done;
    expect(facts).toEqual(happyFacts({ euid: null }));
    expect(classifyRootFacts(facts)).toEqual({ ok: false, step: "euid" });
  });

  it("NaN and -1 are passed through unvalidated and never match a real uid", async () => {
    const collect = load();
    const nan = await collectHappy(collect, {}, Number.NaN).done;
    expect(Number.isNaN(nan.euid)).toBe(true);
    expect(classifyRootFacts(nan)).toEqual({ ok: false, step: "root" });
    const minus = await collectHappy(collect, {}, -1).done;
    expect(minus.euid).toBe(-1);
    expect(classifyRootFacts(minus)).toEqual({ ok: false, step: "root" });
  });
});

const FORBIDDEN_FS = [
  "statfs",
  "statfsSync",
  "createReadStream",
  "createWriteStream",
  "watch",
  "watchFile",
  "fstat",
  "fstatSync",
  "read",
  "readSync",
  "lutimes",
  "lutimesSync",
  "open",
  "openSync",
  "close",
  "closeSync",
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
  "mkdtemp",
  "mkdtempSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "truncate",
  "truncateSync",
  "ftruncate",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "utimes",
  "utimesSync",
  "symlink",
  "symlinkSync",
  "link",
  "linkSync",
  "copyFile",
  "copyFileSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "opendir",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "realpath",
  "realpathSync",
  "access",
  "accessSync",
  "exists",
  "existsSync",
];
const FORBIDDEN_PROMISES = [
  "statfs",
  "lutimes",
  "open",
  "writeFile",
  "appendFile",
  "rename",
  "unlink",
  "mkdir",
  "mkdtemp",
  "rm",
  "rmdir",
  "truncate",
  "chmod",
  "chown",
  "utimes",
  "symlink",
  "link",
  "copyFile",
  "readFile",
  "readdir",
  "readlink",
  "opendir",
  "stat",
  "access",
];

/** Wraps (never mocks the result of) every fs entry the collector must not use; only calls on the fixture tree count. */
function watchForbidden(): { used: () => string[] } {
  const seen: string[] = [];
  const wrap = (target: object, label: string, name: string) => {
    const original: unknown = Reflect.get(target, name);
    // Some entry points do not exist on every Node/OS (statfs, lutimes); a missing one cannot be called.
    if (typeof original !== "function") return;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      const first = args[0];
      if (
        typeof first === "string" &&
        (first.startsWith(tmp) || first.startsWith(realTmp))
      )
        seen.push(`${label}${name}`);
      return Reflect.apply(original, this, args);
    };
    Reflect.set(target, name, wrapper);
    restorers.push(() => Reflect.set(target, name, original));
  };
  for (const name of FORBIDDEN_FS) wrap(realFs, "fs.", name);
  for (const name of FORBIDDEN_PROMISES)
    wrap(realFs.promises, "fs.promises.", name);
  return { used: () => [...seen] };
}

interface TreeEntry {
  path: string;
  type: number;
  mode: number;
  uid: number;
  size: number;
  mtimeMs: number;
}
/** Names, types, mode, uid, size and mtime; deliberately NOT atime (reading updates it) and not a byte-identity claim. */
function snapshotTree(dir: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (current: string) => {
    for (const name of realFs.readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = realFs.lstatSync(path);
      out.push({
        path: path.slice(dir.length),
        type: stat.mode & S_IFMT,
        mode: stat.mode,
        uid: stat.uid,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out;
}

describe("RR7 no effects: none of the LISTED fs entry points other than fs.promises.lstat/realpath is used and the tree is unchanged (names, types, mode, uid, size, mtime; not atime)", () => {
  it("REAL: a happy run and a broken-tree run touch none of the listed fs entry points and leave the fixture tree as it was", async () => {
    const collect = load();
    realFs.mkdirSync(P);
    realFs.symlinkSync(`${V}/t`, join(tmp, "link"));
    const before = snapshotTree(tmp);
    const watch = watchForbidden();
    const h = harness();
    const facts = await collect(V, ROOTS(), E, h.isSettled);
    const broken = await collect(`${tmp}/link`, ROOTS(), E, h.isSettled);
    expect(facts).toEqual(happyFacts());
    expect(broken.root).toMatchObject({ kind: "symlink" });
    expect(watch.used()).toEqual([]);
    jest.restoreAllMocks();
    while (restorers.length) restorers.pop()?.();
    expect(snapshotTree(tmp)).toEqual(before);
    expect(
      h.events.filter((e) => !/^(settled|lstat:|realpath:)/.test(e)),
    ).toEqual([]);
  });

  it("the wrapper really sees a forbidden call on the fixture tree (instrument control)", () => {
    const watch = watchForbidden();
    realFs.readdirSync(tmp);
    expect(watch.used()).toContain("fs.readdirSync");
  });
});

describe("RR8 logical pending (SYNTHETIC hold; NOT a threadpool or FS hang proof)", () => {
  it("a pending first lstat starts nothing else; every deferred is released in finally, and the late answer completes normally", async () => {
    const collect = load();
    const gate = deferred();
    let finished = false;
    const { h, done } = collectHappy(collect, {
      lstat: (nth) => (nth === 1 ? { hold: gate.promise } : undefined),
    });
    const tracked = done.then(
      (value) => {
        finished = true;
        return value;
      },
      (error: unknown) => {
        finished = true;
        throw error;
      },
    );
    try {
      await tick();
      await tick();
      expect(finished).toBe(false);
      expect(h.events).toEqual(["settled", `lstat:${V}`]);
    } finally {
      gate.resolve();
    }
    expect(await tracked).toEqual(happyFacts());
  });

  it("a late lstat answer after isSettled became true gives the sentinel and starts nothing more", async () => {
    const collect = load();
    const gate = deferred();
    const { h, done } = collectHappy(collect, {
      lstat: (nth) => (nth === 1 ? { hold: gate.promise } : undefined),
    });
    try {
      await h.reached(`lstat:${V}`);
      h.settle();
    } finally {
      gate.resolve();
    }
    expect(await done).toEqual(sentinel(E, V, P, R));
    expect(h.events.filter((e) => e !== "settled")).toEqual([`lstat:${V}`]);
  });

  it("a late realpath answer after isSettled became true gives the sentinel and starts nothing more", async () => {
    const collect = load();
    const gate = deferred();
    const { h, done } = collectHappy(collect, {
      realpath: (nth) => (nth === 1 ? { hold: gate.promise } : undefined),
    });
    try {
      await h.reached(`realpath:${V}`);
      h.settle();
    } finally {
      gate.resolve();
    }
    expect(await done).toEqual(sentinel(E, V, P, R));
    expect(h.events.filter((e) => e !== "settled")).toEqual([
      `lstat:${V}`,
      `lstat:${V}/.lock`,
      `lstat:${V}/t`,
      `lstat:${V}/trash`,
      `realpath:${V}`,
    ]);
  });

  it("a late CLIMBING lstat answer (ENOENT) after isSettled became true gives the sentinel and starts nothing more", async () => {
    const collect = load();
    const gate = deferred();
    const { h, done } = collectHappy(collect, {
      lstat: (nth) =>
        nth === 5 ? { gate: gate.promise, error: errno("ENOENT") } : undefined,
    });
    try {
      await h.reached(happyOps()[6]);
      h.settle();
    } finally {
      gate.resolve();
    }
    expect(await done).toEqual(sentinel(E, V, P, R));
    expect(h.events.filter((e) => e !== "settled")).toEqual(
      happyOps().slice(0, 7),
    );
  });

  it.each([
    ["lstat", 1, 0],
    ["lstat", 4, 3],
    ["lstat", 5, 6],
    ["lstat", 6, 9],
    ["realpath", 1, 4],
    ["realpath", 2, 5],
    ["realpath", 4, 8],
    ["realpath", 5, 10],
  ] as const)(
    "a LATE EIO of %s #%i (op #%s), released only after isSettled became true, still rejects with the SAME error and starts nothing more",
    async (op, nth, index) => {
      const collect = load();
      const gate = deferred();
      const failure = errno("EIO");
      const answer = { gate: gate.promise, error: failure };
      const { h, done } = collectHappy(
        collect,
        op === "lstat"
          ? { lstat: (n) => (n === nth ? answer : undefined) }
          : { realpath: (n) => (n === nth ? answer : undefined) },
      );
      const outcome = done.then(
        () => "resolved",
        (error: unknown) => error,
      );
      try {
        const ops = happyOps();
        // The same path can be looked up twice (the shared ancestor), so wait for THIS occurrence.
        await h.reached(
          ops[index],
          ops.slice(0, index + 1).filter((op) => op === ops[index]).length,
        );
        h.settle();
      } finally {
        gate.resolve();
      }
      expect(await outcome).toBe(failure);
      expect(h.events.filter((e) => e !== "settled")).toEqual(
        happyOps().slice(0, index + 1),
      );
    },
  );
});

describe("RR9 the arguments are captured once, before the first await", () => {
  it("REAL: each roots property is read exactly once by the time the call returns; mutating them during a pending lstat changes nothing", async () => {
    const collect = load();
    const reads = { publicDir: 0, privateDir: 0 };
    let publicDir = P;
    let privateDir = R;
    const roots = {
      get publicDir() {
        reads.publicDir += 1;
        return publicDir;
      },
      set publicDir(value: string) {
        publicDir = value;
      },
      get privateDir() {
        reads.privateDir += 1;
        return privateDir;
      },
      set privateDir(value: string) {
        privateDir = value;
      },
    };
    const gate = deferred();
    const h = harness({
      lstat: (nth) => (nth === 1 ? { hold: gate.promise } : undefined),
    });
    const done = collect(V, roots, E, h.isSettled);
    try {
      expect(reads).toEqual({ publicDir: 1, privateDir: 1 });
      await h.reached(`lstat:${V}`);
      publicDir = `${V}/t`;
      privateDir = `${V}/trash`;
    } finally {
      gate.resolve();
    }
    const facts = await done;
    expect(facts).toEqual(happyFacts());
    expect(reads).toEqual({ publicDir: 1, privateDir: 1 });
    expect(h.events).toEqual(happyEvents());
  });
});
