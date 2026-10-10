import * as fs from "node:fs";
import * as path from "node:path";
import type { LockFacts } from "./vault-lock";
import type { FsNode, RootFacts } from "./vault-root";

type FdFact = LockFacts["fd"];
type PathFact = LockFacts["path"];

const LOCK_FD_MIN = 3;
const OTHER = { kind: "other" } as const;

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function fstatBigint(fd: number): Promise<fs.BigIntStats> {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, { bigint: true }, (error, stats) =>
      error ? reject(error) : resolve(stats),
    );
  });
}

// Only EBADF is a fact ("that descriptor is not usable"); any other error is rethrown as is.
async function fdFact(fd: number): Promise<FdFact> {
  try {
    const stats = await fstatBigint(fd);
    return stats.isFile()
      ? { kind: "file", dev: stats.dev, ino: stats.ino }
      : OTHER;
  } catch (error) {
    if (errorCode(error) === "EBADF") return OTHER;
    throw error;
  }
}

async function pathFact(path: string): Promise<PathFact> {
  try {
    const stats = await fs.promises.lstat(path, { bigint: true });
    if (stats.isSymbolicLink()) return { kind: "symlink" };
    return stats.isFile()
      ? { kind: "file", dev: stats.dev, ino: stats.ino }
      : OTHER;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ENOTDIR") return OTHER;
    throw error;
  }
}

async function readFdinfo(lockFd: number): Promise<string | null> {
  try {
    return await fs.promises.readFile(`/proc/self/fdinfo/${lockFd}`, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Collects the raw facts `decideLockProof` consumes. It never opens, closes or writes the .lock or
 * the inherited descriptor (both stay untouched). The one exception is the /proc/self/fdinfo read
 * for platform "linux": `fs.promises.readFile` opens and closes its own short-lived /proc
 * descriptor internally, so this is not a zero-descriptor promise. It asks
 * `isSettled` before every operation and once more before answering: once the outcome is settled
 * it answers a conservative fact set that can never authorize. Operational errors are not facts;
 * they reject with the original error. The recheck DETECTS an observed dev/ino change between two
 * fstat calls; it does not make the snapshot atomic.
 */
export async function collectLockFacts(
  lockFd: number | null,
  lockPath: string,
  platform: string,
  isSettled: () => boolean,
): Promise<LockFacts> {
  const linux = platform === "linux";
  const label: LockFacts["platform"] = linux ? "linux" : "other";
  if (lockFd === null || !Number.isSafeInteger(lockFd) || lockFd < LOCK_FD_MIN)
    return {
      lockFd: null,
      platform: label,
      fd: OTHER,
      path: OTHER,
      fdinfo: null,
    };
  const conservative: LockFacts = {
    lockFd,
    platform: label,
    fd: OTHER,
    path: OTHER,
    fdinfo: null,
  };
  if (isSettled()) return conservative;
  const first = await fdFact(lockFd);
  if (isSettled()) return conservative;
  const path = await pathFact(lockPath);
  let fdinfo: string | null = null;
  if (linux) {
    if (isSettled()) return conservative;
    fdinfo = await readFdinfo(lockFd);
  }
  let fd = first;
  if (linux && first.kind === "file") {
    if (isSettled()) return conservative;
    const second = await fdFact(lockFd);
    if (
      second.kind !== "file" ||
      second.dev !== first.dev ||
      second.ino !== first.ino
    )
      fd = OTHER;
  }
  if (isSettled()) return conservative;
  return { lockFd, platform: label, fd, path, fdinfo };
}

const ABSENT: FsNode = { kind: "absent" };

function isAbsentCode(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function usable(candidate: string): boolean {
  return candidate.startsWith("/") && !candidate.includes("\0");
}

// The lexical form its consumers hand to the kernel: normalized, no terminal slash except "/".
function effective(raw: string): string {
  const normalized = path.posix.normalize(raw);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

async function nodeFact(target: string): Promise<FsNode> {
  try {
    const stats = await fs.promises.lstat(target);
    const kind = stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "dir"
        : stats.isFile()
          ? "file"
          : "other";
    return { kind, mode: stats.mode, uid: stats.uid };
  } catch (error) {
    if (isAbsentCode(error)) return ABSENT;
    throw error;
  }
}

/**
 * realpath of the longest existing prefix plus the missing suffix, or null when it is
 * indeterminate: settled, or a candidate that realpath could not resolve but lstat still finds
 * (a dangling symlink or a race). Any other error rejects as is.
 */
async function resolveEffective(
  target: string,
  isSettled: () => boolean,
): Promise<string | null> {
  let candidate = target;
  const rest: string[] = [];
  for (;;) {
    if (isSettled()) return null;
    try {
      return path.posix.join(await fs.promises.realpath(candidate), ...rest);
    } catch (error) {
      if (!isAbsentCode(error) || candidate === "/") throw error;
    }
    if (isSettled()) return null;
    let exists = true;
    try {
      await fs.promises.lstat(candidate);
    } catch (error) {
      if (!isAbsentCode(error)) throw error;
      exists = false;
    }
    if (exists) {
      // Outside the try: an error from this callback is not a filesystem absence.
      // Asked once more, as a completed collection would; the answer is the sentinel either way.
      isSettled();
      return null;
    }
    rest.unshift(path.posix.basename(candidate));
    candidate = path.posix.dirname(candidate);
  }
}

/**
 * Collects the facts `classifyRootFacts` consumes: the four nodes under the vault root and the
 * effective path of the three roots. Each root is normalized lexically before any lookup, then its
 * existing prefix is resolved. It only reads (lstat/realpath) and asks `isSettled` before every
 * operation and once more before answering. An input that is not an absolute path, a settled
 * outcome or an indeterminate resolution answers an inert sentinel (raw inputs, four absent nodes)
 * that can never be OK; operational errors reject with the original error. It observes paths at
 * instants and certifies neither races nor aliases below a root.
 */
export async function collectRootFacts(
  rootDir: string,
  roots: Pick<RootFacts["resolved"], "publicDir" | "privateDir">,
  euid: number | null,
  isSettled: () => boolean,
): Promise<RootFacts> {
  const publicDir = roots.publicDir;
  const privateDir = roots.privateDir;
  const inert: RootFacts = {
    euid,
    resolved: { root: rootDir, publicDir, privateDir },
    root: ABSENT,
    lock: ABSENT,
    t: ABSENT,
    trash: ABSENT,
  };
  if (![rootDir, publicDir, privateDir].every(usable)) return inert;
  const root = effective(rootDir);
  const nodes: FsNode[] = [];
  for (const target of [
    root,
    path.posix.join(root, ".lock"),
    path.posix.join(root, "t"),
    path.posix.join(root, "trash"),
  ]) {
    if (isSettled()) return inert;
    nodes.push(await nodeFact(target));
  }
  const resolved: string[] = [];
  for (const target of [root, effective(publicDir), effective(privateDir)]) {
    const found = await resolveEffective(target, isSettled);
    if (found === null) return inert;
    resolved.push(found);
  }
  if (isSettled()) return inert;
  return {
    euid,
    resolved: {
      root: resolved[0],
      publicDir: resolved[1],
      privateDir: resolved[2],
    },
    root: nodes[0],
    lock: nodes[1],
    t: nodes[2],
    trash: nodes[3],
  };
}
