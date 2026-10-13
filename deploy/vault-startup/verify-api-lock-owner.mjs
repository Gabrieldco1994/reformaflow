#!/usr/bin/env node

import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROC_ROOT = "/proc";
const INIT_EXE = "/fly/init";
const NODE_EXE = "/usr/local/bin/node";
const API_CMDLINE = Buffer.from("node\0apps/api/dist/main.js\0");
const API_CWD = "/app";
const LOCK_FD = 9;
const LOCK_PATH = "/data/import-vault/.lock";
const UINT64_LIMIT = 1n << 64n;

const FLOCK_LINE =
  /^lock:\t\d+: +FLOCK +ADVISORY +(WRITE|READ) +(-?\d+) +([0-9a-f]{1,8}):([0-9a-f]{1,8}):(0|[1-9]\d{0,19}) +0 +EOF$/;

const realProc = Object.freeze({
  readFile(path, encoding) {
    return readFileSync(path, encoding);
  },
  readlink(path) {
    return readlinkSync(path);
  },
  lstat(path) {
    return lstatSync(path, { bigint: true });
  },
  stat(path) {
    return statSync(path, { bigint: true });
  },
});

class VerificationFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function deny(reason) {
  throw new VerificationFailure(reason);
}

function isUint64(value) {
  return typeof value === "bigint" && value >= 0n && value < UINT64_LIMIT;
}

function parseChildren(text) {
  if (typeof text !== "string") deny("CHILDREN_FORMAT");
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const values = trimmed.split(/\s+/);
  const children = [];
  const seen = new Set();
  for (const value of values) {
    if (!/^[1-9]\d*$/.test(value)) deny("CHILDREN_FORMAT");
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid))
      deny("CHILDREN_FORMAT");
    seen.add(pid);
    children.push(pid);
  }
  return children.sort((left, right) => left - right);
}

function parseProcessStat(text, expectedPid) {
  if (typeof text !== "string") deny("PROCESS_FACTS");
  const separator = text.lastIndexOf(") ");
  const prefix = `${expectedPid} (`;
  if (!text.startsWith(prefix) || separator < prefix.length)
    deny("PROCESS_FACTS");
  const fields = text
    .slice(separator + 2)
    .trimEnd()
    .split(" ");
  if (
    fields.length < 20 ||
    fields.some((field) => field === "") ||
    !/^[A-Za-z]$/.test(fields[0]) ||
    !/^[1-9]\d*$/.test(fields[1]) ||
    !/^(0|[1-9]\d*)$/.test(fields[19])
  ) {
    deny("PROCESS_FACTS");
  }
  const ppid = Number(fields[1]);
  const startTime = BigInt(fields[19]);
  if (!Number.isSafeInteger(ppid) || ppid < 1 || !isUint64(startTime)) {
    deny("PROCESS_FACTS");
  }
  return { ppid, startTime };
}

function readChildren(proc) {
  try {
    return parseChildren(
      proc.readFile(`${PROC_ROOT}/1/task/1/children`, "utf8"),
    );
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    deny("CHILDREN_READ");
  }
}

function readProcessIdentity(proc, pid) {
  try {
    const stat = parseProcessStat(
      proc.readFile(`${PROC_ROOT}/${pid}/stat`, "utf8"),
      pid,
    );
    return {
      pid,
      ppid: stat.ppid,
      startTime: stat.startTime,
      exe: proc.readlink(`${PROC_ROOT}/${pid}/exe`),
      cmdline: proc.readFile(`${PROC_ROOT}/${pid}/cmdline`),
      cwd: proc.readlink(`${PROC_ROOT}/${pid}/cwd`),
    };
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    deny("PROCESS_FACTS");
  }
}

function isApiCandidate(identity) {
  return (
    identity.ppid === 1 &&
    identity.exe === NODE_EXE &&
    Buffer.isBuffer(identity.cmdline) &&
    identity.cmdline.equals(API_CMDLINE) &&
    identity.cwd === API_CWD
  );
}

function findCandidate(proc, children) {
  const candidates = children
    .map((pid) => readProcessIdentity(proc, pid))
    .filter(isApiCandidate);
  if (candidates.length !== 1) deny("CANDIDATE_COUNT");
  return candidates[0];
}

function decodeLinuxDevice(dev) {
  if (!isUint64(dev)) return null;
  return {
    major: Number(
      ((dev & 0x00000000000fff00n) >> 8n) |
        ((dev & 0xfffff00000000000n) >> 32n),
    ),
    minor: Number(
      (dev & 0x00000000000000ffn) | ((dev & 0x00000ffffff00000n) >> 12n),
    ),
  };
}

function proveFlock(fdinfo, dev, ino) {
  if (typeof fdinfo !== "string") deny("LOCK_NOT_OWNED");
  const lockLines = fdinfo
    .split("\n")
    .filter((line) => line.trimStart().startsWith("lock:"));
  if (lockLines.length !== 1) deny("LOCK_NOT_OWNED");
  const match = FLOCK_LINE.exec(lockLines[0]);
  const device = decodeLinuxDevice(dev);
  if (
    !match ||
    !device ||
    match[1] !== "WRITE" ||
    parseInt(match[3], 16) !== device.major ||
    parseInt(match[4], 16) !== device.minor ||
    BigInt(match[5]) !== ino
  ) {
    deny("LOCK_NOT_OWNED");
  }
  return Object.freeze({
    mode: "WRITE",
    owner: match[2],
    major: device.major,
    minor: device.minor,
    ino,
  });
}

function readLockFacts(proc, candidate) {
  let path;
  try {
    path = proc.lstat(LOCK_PATH);
  } catch {
    deny("LOCK_PATH");
  }
  if (
    path.isSymbolicLink() ||
    !path.isFile() ||
    path.nlink !== 1n ||
    !isUint64(path.dev) ||
    !isUint64(path.ino)
  ) {
    deny("LOCK_PATH");
  }

  const descriptorPath = `${PROC_ROOT}/${candidate.pid}/fd/${LOCK_FD}`;
  let target;
  try {
    target = proc.readlink(descriptorPath);
  } catch {
    deny("LOCK_FD_TARGET");
  }
  if (target !== LOCK_PATH) deny("LOCK_FD_TARGET");

  let descriptor;
  try {
    descriptor = proc.stat(descriptorPath);
  } catch {
    deny("LOCK_FD");
  }
  if (
    !descriptor.isFile() ||
    !isUint64(descriptor.dev) ||
    !isUint64(descriptor.ino) ||
    descriptor.dev !== path.dev ||
    descriptor.ino !== path.ino
  ) {
    deny("LOCK_IDENTITY");
  }

  let fdinfo;
  try {
    fdinfo = proc.readFile(
      `${PROC_ROOT}/${candidate.pid}/fdinfo/${LOCK_FD}`,
      "utf8",
    );
  } catch {
    deny("LOCK_FDINFO");
  }
  const flock = proveFlock(fdinfo, descriptor.dev, descriptor.ino);
  return Object.freeze({
    target,
    dev: descriptor.dev,
    ino: descriptor.ino,
    flock,
  });
}

function sameChildren(first, second) {
  return (
    first.length === second.length &&
    first.every((pid, index) => pid === second[index])
  );
}

function sameCandidate(first, second) {
  return (
    first.pid === second.pid &&
    first.ppid === second.ppid &&
    first.startTime === second.startTime &&
    first.exe === second.exe &&
    first.cmdline.equals(second.cmdline) &&
    first.cwd === second.cwd
  );
}

function sameLock(first, second) {
  return (
    first.target === second.target &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.flock.mode === second.flock.mode &&
    first.flock.owner === second.flock.owner &&
    first.flock.major === second.flock.major &&
    first.flock.minor === second.flock.minor &&
    first.flock.ino === second.flock.ino
  );
}

export function verifyApiLockOwner(proc = realProc) {
  try {
    let initExe;
    try {
      initExe = proc.readlink(`${PROC_ROOT}/1/exe`);
    } catch {
      deny("INIT_IDENTITY");
    }
    if (initExe !== INIT_EXE) deny("INIT_IDENTITY");

    const firstChildren = readChildren(proc);
    const firstCandidate = findCandidate(proc, firstChildren);
    const firstLock = readLockFacts(proc, firstCandidate);

    const secondChildren = readChildren(proc);
    if (!sameChildren(firstChildren, secondChildren)) deny("CHILD_SET_CHANGED");
    const secondCandidate = findCandidate(proc, secondChildren);
    if (!sameCandidate(firstCandidate, secondCandidate))
      deny("CANDIDATE_CHANGED");
    const secondLock = readLockFacts(proc, secondCandidate);
    if (!sameLock(firstLock, secondLock)) deny("LOCK_CHANGED");

    return Object.freeze({
      ok: true,
      pid: secondCandidate.pid,
      ppid: secondCandidate.ppid,
      startTime: secondCandidate.startTime,
      dev: secondLock.dev,
      ino: secondLock.ino,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason:
        error instanceof VerificationFailure ? error.reason : "READ_FAILURE",
    });
  }
}

export function formatVerificationResult(result) {
  if (!result.ok) return `state=DENIED reason=${result.reason}`;
  return `state=VERIFIED pid=${result.pid} ppid=${result.ppid} start=${result.startTime} dev=${result.dev} inode=${result.ino}`;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const result =
    process.argv.length === 2
      ? verifyApiLockOwner()
      : Object.freeze({ ok: false, reason: "UNSUPPORTED_ARGS" });
  console.log(formatVerificationResult(result));
  process.exitCode = result.ok ? 0 : 1;
}
