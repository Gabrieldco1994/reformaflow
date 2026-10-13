import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  formatVerificationResult,
  verifyApiLockOwner,
} from "../verify-api-lock-owner.mjs";

const SOURCE = new URL("../verify-api-lock-owner.mjs", import.meta.url);
const LOCK_PATH = "/data/import-vault/.lock";
const API_PID = 643;
const DEVICE = 2049n;
const INODE = 44n;

function procStat(pid, ppid = 1, startTime = 123456n) {
  const fields = [
    "S",
    String(ppid),
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    String(startTime),
    "0",
    "0",
  ];
  return `${pid} (node) ${fields.join(" ")}\n`;
}

function apiProcess(overrides = {}) {
  return {
    pid: API_PID,
    ppid: 1,
    startTime: 123456n,
    exe: "/usr/local/bin/node",
    cmdline: Buffer.from("node\0apps/api/dist/main.js\0"),
    cwd: "/app",
    fdTarget: LOCK_PATH,
    fdDev: DEVICE,
    fdIno: INODE,
    ...overrides,
  };
}

function unrelatedProcess(pid = 700) {
  return apiProcess({
    pid,
    exe: "/usr/bin/vector",
    cmdline: Buffer.from("vector\0"),
    cwd: "/",
  });
}

function snapshot(overrides = {}) {
  const process = apiProcess();
  return {
    children: String(API_PID),
    processes: new Map([[API_PID, process]]),
    lock: {
      dev: DEVICE,
      ino: INODE,
      nlink: 1n,
      isFile: true,
      isSymbolicLink: false,
    },
    fdinfo:
      "pos:\t0\nflags:\t02100000\nlock:\t1: FLOCK ADVISORY WRITE 643 08:01:44 0 EOF\n",
    ...overrides,
  };
}

function cloneSnapshot(base = snapshot()) {
  return {
    ...base,
    processes: new Map(
      [...base.processes].map(([pid, process]) => [
        pid,
        { ...process, cmdline: Buffer.from(process.cmdline) },
      ]),
    ),
    lock: { ...base.lock },
  };
}

function statFact({ dev, ino, nlink = 1n, isFile = true }) {
  return {
    dev,
    ino,
    nlink,
    isFile: () => isFile,
    isSymbolicLink: () => false,
  };
}

class FakeProc {
  constructor(snapshots, initExe = "/fly/init") {
    this.snapshots = snapshots;
    this.initExe = initExe;
    this.phase = -1;
    this.accesses = [];
  }

  current() {
    const value = this.snapshots[this.phase];
    if (!value) throw new Error("fixture exhausted");
    return value;
  }

  process(pid) {
    const value = this.current().processes.get(pid);
    if (!value) throw new Error("process exited");
    return value;
  }

  readlink(path) {
    this.accesses.push(["readlink", path]);
    if (path === "/proc/1/exe") return this.initExe;
    const match = /^\/proc\/(\d+)\/(exe|cwd|fd\/9)$/.exec(path);
    if (!match) throw new Error("unexpected readlink");
    const process = this.process(Number(match[1]));
    if (match[2] === "exe") return process.exe;
    if (match[2] === "cwd") return process.cwd;
    return process.fdTarget;
  }

  readFile(path, encoding) {
    this.accesses.push(["readFile", path]);
    if (path === "/proc/1/task/1/children") {
      this.phase += 1;
      return this.current().children;
    }
    const match = /^\/proc\/(\d+)\/(stat|cmdline|fdinfo\/9)$/.exec(path);
    if (!match) throw new Error("unexpected read");
    const process = this.process(Number(match[1]));
    if (match[2] === "stat") {
      return (
        process.stat ?? procStat(process.pid, process.ppid, process.startTime)
      );
    }
    if (match[2] === "cmdline") return Buffer.from(process.cmdline);
    assert.equal(encoding, "utf8");
    return this.current().fdinfo;
  }

  lstat(path) {
    this.accesses.push(["lstat", path]);
    assert.equal(path, LOCK_PATH);
    const lock = this.current().lock;
    if (lock === null) throw new Error("missing lock");
    return {
      dev: lock.dev,
      ino: lock.ino,
      nlink: lock.nlink,
      isFile: () => lock.isFile,
      isSymbolicLink: () => lock.isSymbolicLink,
    };
  }

  stat(path) {
    this.accesses.push(["stat", path]);
    const match = /^\/proc\/(\d+)\/fd\/9$/.exec(path);
    if (!match) throw new Error("unexpected stat");
    const process = this.process(Number(match[1]));
    return statFact({ dev: process.fdDev, ino: process.fdIno });
  }
}

function verify(first = snapshot(), second = cloneSnapshot(first), initExe) {
  const proc = new FakeProc([first, second], initExe);
  return { proc, result: verifyApiLockOwner(proc) };
}

test("accepts the sole API child of Fly init even though PID1 has no fd9", () => {
  const { proc, result } = verify();
  assert.deepEqual(result, {
    ok: true,
    pid: API_PID,
    ppid: 1,
    startTime: 123456n,
    dev: DEVICE,
    ino: INODE,
  });
  assert.equal(
    proc.accesses.some(([, path]) => path === "/proc/1/fd/9"),
    false,
  );
});

test("ignores an unrelated stable direct sibling", () => {
  const first = snapshot({
    children: `${API_PID} 700`,
    processes: new Map([
      [API_PID, apiProcess()],
      [700, unrelatedProcess()],
    ]),
  });
  const { result } = verify(first, cloneSnapshot(first));
  assert.equal(result.ok, true);
});

test("rejects the wrong init executable, zero candidates, and multiple candidates", () => {
  assert.deepEqual(verify(snapshot(), undefined, "/usr/bin/tini").result, {
    ok: false,
    reason: "INIT_IDENTITY",
  });

  const none = snapshot({
    children: "700",
    processes: new Map([[700, unrelatedProcess()]]),
  });
  assert.deepEqual(verify(none, cloneSnapshot(none)).result, {
    ok: false,
    reason: "CANDIDATE_COUNT",
  });

  const multiple = snapshot({
    children: `${API_PID} 644`,
    processes: new Map([
      [API_PID, apiProcess()],
      [644, apiProcess({ pid: 644 })],
    ]),
  });
  const multipleProof = verify(multiple, cloneSnapshot(multiple));
  assert.deepEqual(multipleProof.result, {
    ok: false,
    reason: "CANDIDATE_COUNT",
  });
  assert.equal(
    multipleProof.proc.accesses.some(
      ([operation, path]) => operation === "lstat" || path.endsWith("/fd/9"),
    ),
    false,
  );
});

test("rejects each inexact API identity field", () => {
  for (const [name, change] of [
    ["exe", { exe: "/usr/bin/node" }],
    [
      "argv0",
      { cmdline: Buffer.from("/usr/local/bin/node\0apps/api/dist/main.js\0") },
    ],
    ["script", { cmdline: Buffer.from("node\0dist/main.js\0") }],
    [
      "extra arg",
      { cmdline: Buffer.from("node\0apps/api/dist/main.js\0--inspect\0") },
    ],
    ["cwd", { cwd: "/workspace" }],
    ["ppid", { ppid: 2 }],
  ]) {
    const invalid = apiProcess(change);
    const first = snapshot({ processes: new Map([[API_PID, invalid]]) });
    assert.deepEqual(
      verify(first, cloneSnapshot(first)).result,
      { ok: false, reason: "CANDIDATE_COUNT" },
      name,
    );
  }
});

test("rejects malformed child and stat records", () => {
  for (const children of ["643 nope", "0643", "643 643", "-1", "1.5"]) {
    assert.deepEqual(verify(snapshot({ children })).result, {
      ok: false,
      reason: "CHILDREN_FORMAT",
    });
  }

  for (const stat of [
    "",
    "643 node S 1",
    "644 (node) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123456",
    "643 (node) S nope 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123456",
    "643 (node) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 nope",
  ]) {
    const malformed = apiProcess({ stat });
    const first = snapshot({ processes: new Map([[API_PID, malformed]]) });
    assert.deepEqual(verify(first, cloneSnapshot(first)).result, {
      ok: false,
      reason: "PROCESS_FACTS",
    });
  }
});

test("rejects missing, replaced, symlink, and multiply-linked lock paths", () => {
  for (const [name, lock] of [
    ["missing", null],
    [
      "symlink",
      {
        dev: DEVICE,
        ino: INODE,
        nlink: 1n,
        isFile: false,
        isSymbolicLink: true,
      },
    ],
    [
      "multilink",
      {
        dev: DEVICE,
        ino: INODE,
        nlink: 2n,
        isFile: true,
        isSymbolicLink: false,
      },
    ],
  ]) {
    assert.deepEqual(
      verify(snapshot({ lock })).result,
      { ok: false, reason: "LOCK_PATH" },
      name,
    );
  }

  const second = snapshot({
    lock: {
      dev: DEVICE,
      ino: 45n,
      nlink: 1n,
      isFile: true,
      isSymbolicLink: false,
    },
  });
  assert.deepEqual(verify(snapshot(), second).result, {
    ok: false,
    reason: "LOCK_IDENTITY",
  });
});

test("rejects fd target and fd/path device or inode mismatches", () => {
  for (const [name, change] of [
    ["target", { fdTarget: "/data/import-vault/other" }],
    ["device", { fdDev: 2050n }],
    ["inode", { fdIno: 45n }],
  ]) {
    const process = apiProcess(change);
    const first = snapshot({ processes: new Map([[API_PID, process]]) });
    assert.deepEqual(
      verify(first).result,
      {
        ok: false,
        reason: name === "target" ? "LOCK_FD_TARGET" : "LOCK_IDENTITY",
      },
      name,
    );
  }
});

test("rejects missing, multiple, non-WRITE, malformed, and wrong-object flocks", () => {
  const canonical = "lock:\t1: FLOCK ADVISORY WRITE 643 08:01:44 0 EOF\n";
  for (const [name, fdinfo] of [
    ["missing", "pos:\t0\n"],
    ["multiple", canonical + canonical],
    ["read", canonical.replace("WRITE", "READ")],
    ["non-flock", canonical.replace("FLOCK", "POSIX")],
    ["malformed owner", canonical.replace("WRITE 643", "WRITE owner")],
    ["wrong device", canonical.replace("08:01", "08:02")],
    ["wrong inode", canonical.replace(":44 ", ":45 ")],
  ]) {
    assert.deepEqual(
      verify(snapshot({ fdinfo })).result,
      { ok: false, reason: "LOCK_NOT_OWNED" },
      name,
    );
  }
});

test("accepts the canonical inherited-flock owner field without treating it as the API PID", () => {
  const first = snapshot({
    fdinfo: "lock:\t1: FLOCK ADVISORY WRITE -1 08:01:44 0 EOF\n",
  });
  assert.equal(verify(first, cloneSnapshot(first)).result.ok, true);
});

test("rejects child-set changes, candidate exit, and PID reuse", () => {
  const withSibling = snapshot({
    children: `${API_PID} 700`,
    processes: new Map([
      [API_PID, apiProcess()],
      [700, unrelatedProcess()],
    ]),
  });
  assert.deepEqual(verify(withSibling, snapshot()).result, {
    ok: false,
    reason: "CHILD_SET_CHANGED",
  });
  assert.deepEqual(verify(snapshot(), withSibling).result, {
    ok: false,
    reason: "CHILD_SET_CHANGED",
  });

  const exited = snapshot({ processes: new Map() });
  assert.deepEqual(verify(snapshot(), exited).result, {
    ok: false,
    reason: "PROCESS_FACTS",
  });

  const reused = snapshot({
    processes: new Map([[API_PID, apiProcess({ startTime: 123457n })]]),
  });
  assert.deepEqual(verify(snapshot(), reused).result, {
    ok: false,
    reason: "CANDIDATE_CHANGED",
  });
});

test("rejects identity, descriptor, path, and flock mutation between proofs", () => {
  const mutations = [
    snapshot({
      processes: new Map([[API_PID, apiProcess({ cwd: "/other" })]]),
    }),
    snapshot({
      processes: new Map([[API_PID, apiProcess({ fdIno: 45n })]]),
    }),
    snapshot({
      lock: {
        dev: DEVICE,
        ino: 45n,
        nlink: 1n,
        isFile: true,
        isSymbolicLink: false,
      },
      processes: new Map([[API_PID, apiProcess({ fdIno: 45n })]]),
      fdinfo: "lock:\t1: FLOCK ADVISORY WRITE 643 08:01:45 0 EOF\n",
    }),
    snapshot({
      fdinfo: "lock:\t1: FLOCK ADVISORY READ 643 08:01:44 0 EOF\n",
    }),
    snapshot({
      fdinfo: "lock:\t1: FLOCK ADVISORY WRITE 999 08:01:44 0 EOF\n",
    }),
  ];
  for (const second of mutations) {
    assert.equal(verify(snapshot(), second).result.ok, false);
  }
});

test("uses no environ data and formats only bounded public facts", () => {
  const { proc, result } = verify();
  assert.equal(
    proc.accesses.some(([, path]) => path.includes("environ")),
    false,
  );
  const output = formatVerificationResult(result);
  assert.equal(
    output,
    "state=VERIFIED pid=643 ppid=1 start=123456 dev=2049 inode=44",
  );
  assert.ok(output.length < 160);

  const denied = formatVerificationResult({
    ok: false,
    reason: "LOCK_NOT_OWNED",
  });
  assert.equal(denied, "state=DENIED reason=LOCK_NOT_OWNED");
  assert.ok(denied.length < 80);
});

test("source is fixed-purpose and read-only", () => {
  const source = readFileSync(SOURCE, "utf8");
  assert.doesNotMatch(source, /process\.env|\/environ\b/);
  assert.doesNotMatch(
    source,
    /node:child_process|\bspawn(?:Sync)?\b|process\.kill|setTimeout|setInterval/,
  );
  assert.doesNotMatch(
    source,
    /\b(?:writeFile|appendFile|truncate|unlink|rename|mkdir|chmod|chown|open)\w*Sync\b/,
  );
  for (const literal of [
    '"/proc"',
    '"/fly/init"',
    '"/usr/local/bin/node"',
    '"node\\0apps/api/dist/main.js\\0"',
    '"/app"',
    '"/data/import-vault/.lock"',
  ]) {
    assert.match(
      source,
      new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});
