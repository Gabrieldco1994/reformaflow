export interface LinuxDev {
  major: number;
  minor: number;
}

const UINT64_LIMIT = 1n << 64n;

/**
 * Decodes a Linux dev_t carried by a uint64 st_dev (glibc gnu_dev_major/gnu_dev_minor layout):
 * major = bits 8..19 and 44..63, minor = bits 0..7 and 20..43. Outside uint64 there is no dev_t.
 */
export function decodeLinuxDev(dev: bigint): LinuxDev | null {
  if (dev < 0n || dev >= UINT64_LIMIT) return null;
  const major =
    ((dev & 0x00000000000fff00n) >> 8n) | ((dev & 0xfffff00000000000n) >> 32n);
  const minor =
    (dev & 0x00000000000000ffn) | ((dev & 0x00000ffffff00000n) >> 12n);
  return { major: Number(major), minor: Number(minor) };
}

export type FlockMode = "WRITE" | "READ";

export type FdinfoLockEntry =
  | {
      kind: "FLOCK";
      mode: FlockMode;
      major: number;
      minor: number;
      ino: bigint;
    }
  | { kind: "OTHER" };

export type LockFdFact =
  | { kind: "file"; dev: bigint; ino: bigint }
  | { kind: "other" };

export type LockPathFact =
  | { kind: "file"; dev: bigint; ino: bigint }
  | { kind: "missing" | "symlink" | "other" };

export interface LockFacts {
  lockFd: number | null;
  platform: "linux" | "other";
  fd: LockFdFact;
  path: LockPathFact;
  fdinfo: string | null;
}

export type LockProofReason =
  | "NO_LOCK_FD"
  | "FD_NOT_LOCKFILE"
  | "BAD_ROOT"
  | "NO_FDINFO"
  | "LOCK_NOT_OWNED";

export type LockProof = { ok: true } | { ok: false; reason: LockProofReason };

// Only the canonical shape is FLOCK; pid and ordinal are matched but never exposed.
const FLOCK_LINE =
  /^lock:\t\d+: +FLOCK +ADVISORY +(WRITE|READ) +-?\d+ +([0-9a-f]{1,8}):([0-9a-f]{1,8}):(0|[1-9]\d{0,19}) +0 +EOF$/;

/**
 * One entry per fdinfo line whose text (after leading whitespace) starts with `lock:`; every other
 * line is metadata and is ignored. Anything not canonical is OTHER, which never authorizes.
 */
export function parseFdinfoLockLines(text: string): FdinfoLockEntry[] {
  const entries: FdinfoLockEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("lock:")) continue;
    const match = FLOCK_LINE.exec(line);
    if (!match || BigInt(match[4]) >= UINT64_LIMIT) {
      entries.push({ kind: "OTHER" });
      continue;
    }
    entries.push({
      kind: "FLOCK",
      mode: match[1] as FlockMode,
      major: parseInt(match[2], 16),
      minor: parseInt(match[3], 16),
      ino: BigInt(match[4]),
    });
  }
  return entries;
}

const denied = (reason: LockProofReason): LockProof => ({ ok: false, reason });

/**
 * Fail-closed ownership proof: exactly one canonical FLOCK WRITE line naming the device and inode
 * of the descriptor, which must itself be the lock file at the configured path. "Exactly one" is a
 * conservative policy, not a claim about every kernel or filesystem.
 */
export function decideLockProof(facts: LockFacts): LockProof {
  const { lockFd, fd, path } = facts;
  if (lockFd === null || !Number.isSafeInteger(lockFd) || lockFd < 3)
    return denied("NO_LOCK_FD");
  if (facts.platform !== "linux") return denied("NO_FDINFO");
  if (fd.kind !== "file") return denied("FD_NOT_LOCKFILE");
  if (path.kind !== "file") return denied("BAD_ROOT");
  if (path.dev !== fd.dev || path.ino !== fd.ino)
    return denied("FD_NOT_LOCKFILE");
  if (facts.fdinfo === null) return denied("NO_FDINFO");
  const dev = decodeLinuxDev(fd.dev);
  const entries = parseFdinfoLockLines(facts.fdinfo);
  if (dev === null || entries.length !== 1) return denied("LOCK_NOT_OWNED");
  const [entry] = entries;
  if (
    entry.kind !== "FLOCK" ||
    entry.mode !== "WRITE" ||
    entry.major !== dev.major ||
    entry.minor !== dev.minor ||
    entry.ino !== fd.ino
  )
    return denied("LOCK_NOT_OWNED");
  return { ok: true };
}
