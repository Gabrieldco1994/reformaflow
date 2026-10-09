import { posix } from "node:path";
import type { UploadsRoots } from "../../../common/uploads-roots";

/** Inclusive. `available` is BigInt because statfs byte counts can exceed 2^53. */
export function headroomSatisfied(
  available: bigint,
  headroom: number,
): boolean {
  return available >= BigInt(headroom);
}

/** An lstat-style fact: `kind` carries the file type, `mode` is the raw st_mode. */
export type FsNode =
  | { kind: "absent" }
  | { kind: "dir" | "file" | "symlink" | "other"; mode: number; uid: number };

/** Facts about the vault root, already collected. Nothing here touches a filesystem. */
export interface RootFacts {
  euid: number | null;
  /**
   * EFFECTIVE absolute paths of the three roots, resolved by the collector and compared here only
   * lexically. Each raw root is first normalized lexically (`posix.normalize`, no terminal slash
   * except `/`), which is what its consumers do before the kernel sees it (serve-static resolves
   * the public root, `path.join` builds the private one) and which the vault root gets by decision,
   * as no vault writer exists yet; the existing prefix of that path is then resolved on the
   * filesystem and the missing suffix appended. The four node facts describe the same effective
   * vault root. A COMPLETED collection returns these paths.
   *
   * The guard/settled/indeterminate fallback is different: an inert sentinel that carries the raw
   * captured inputs verbatim, marks all four nodes `absent` and can never be OK. It is returned
   * when a lookup cannot be completed (a settled outcome, an input that is not an absolute path,
   * or a resolution that stays indeterminate, such as a dangling symlink). It is not an
   * observation that the directories disappeared. A collector observes paths at instants; it does
   * not certify the absence of races, internal aliases below a root, or public exposure.
   */
  resolved: UploadsRoots & { root: string };
  root: FsNode;
  lock: FsNode;
  t: FsNode;
  trash: FsNode;
}

export type RootStep =
  | "euid"
  | "root"
  | "disjoint-public"
  | "disjoint-private"
  | "lock"
  | "t"
  | "trash";

export type RootVerdict = { ok: true } | { ok: false; step: RootStep };

const PERMISSION_BITS = 0o7777; // includes setuid/setgid/sticky, excludes the file-type bits
const DIR_MODE = 0o700;
const LOCK_MODE = 0o600;

export function canonical(path: string): string | null {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  const normalized = posix.normalize(path);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

function within(path: string, ancestor: string): boolean {
  return (
    path === ancestor ||
    path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`)
  );
}

function related(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function owned(
  node: FsNode,
  kind: "dir" | "file",
  mode: number,
  euid: number,
): boolean {
  return (
    node.kind === kind &&
    node.uid === euid &&
    (node.mode & PERMISSION_BITS) === mode
  );
}

/**
 * Pure verdict over collected facts; the first failing check wins. It compares strings and
 * lstat-style facts only: it proves neither realpath resolution nor the absence of a race, which
 * belong to the collector. `step` is a bounded diagnostic token, never a path.
 */
export function classifyRootFacts(facts: RootFacts): RootVerdict {
  const fail = (step: RootStep): RootVerdict => ({ ok: false, step });
  const { euid, resolved } = facts;
  if (euid === null) return fail("euid");

  const root = canonical(resolved.root);
  if (root === null || !owned(facts.root, "dir", DIR_MODE, euid))
    return fail("root");
  const publicDir = canonical(resolved.publicDir);
  if (publicDir === null || related(root, publicDir))
    return fail("disjoint-public");
  const privateDir = canonical(resolved.privateDir);
  if (privateDir === null || related(root, privateDir))
    return fail("disjoint-private");

  if (!owned(facts.lock, "file", LOCK_MODE, euid)) return fail("lock");
  if (!owned(facts.t, "dir", DIR_MODE, euid)) return fail("t");
  if (!owned(facts.trash, "dir", DIR_MODE, euid)) return fail("trash");
  return { ok: true };
}
