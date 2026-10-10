"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isUtf8 } = require("node:buffer");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const NODE = "/bin/node";
const WORKER = "/app/worker.js";
const SELF = "/test/x2-runtime-smoke.cjs";
const GUARD = "/test/scripts/test-db-env.cjs";
const DATABASE = "/test/x2-smoke.test.db";
const DATABASE_URL = `file:${DATABASE}`;
const WORKER_ARGS = ["--require", GUARD, WORKER];
const WORKER_ENV = { TZ: "UTC", TEST_DATABASE_URL: DATABASE_URL };
const WORKER_TIMEOUT_MS = 60000;
const MAX_BYTES = 1048576;
const MAX_MANIFEST_ENTRIES = 4096;
const MAX_RECORD_BYTES = 8 * MAX_BYTES;
const MAX_RECORDS = 10;
const PROFILES = [
  { format: "PDF", profile: 1, parserVersion: "card-local-pdf-v1", occurrences: 1, amountCents: 1234 },
  { format: "XLS", profile: 2, parserVersion: "card-local-xls-v1", occurrences: 1, amountCents: 1234 },
  { format: "XLSX", profile: 3, parserVersion: "card-local-xlsx-v1", occurrences: 1, amountCents: 1234 },
];
let records = 0;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorRecord(error) {
  return {
    name: String(error?.name ?? "Error").slice(0, 80),
    message: String(error?.message ?? error).slice(0, 2048),
    code: typeof error?.code === "string" ? error.code.slice(0, 80) : null,
  };
}

function emit(event, data) {
  const line = JSON.stringify({ protocol: "X2_ROOT_SMOKE_V1", event, ...data }) + "\n";
  assert(Buffer.byteLength(line) <= MAX_RECORD_BYTES, "Smoke record exceeds its fixed budget");
  assert(records < MAX_RECORDS, "Smoke record count exceeds its fixed budget");
  records++;
  process.stdout.write(line);
}

function readonlyFile(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile(), `Not a regular packaged file: ${file}`);
  assert.equal(fs.realpathSync(file), file, `Unexpected symlink: ${file}`);
  assert.equal(stat.uid, 0, `Not root-owned: ${file}`);
  assert.equal(stat.gid, 0, `Not root-group-owned: ${file}`);
  assert.equal(stat.mode & 0o222, 0, `Writable packaged file: ${file}`);
  return stat;
}

function readSmall(file) {
  assert(readonlyFile(file).size <= MAX_BYTES, `Metadata too large: ${file}`);
  return fs.readFileSync(file);
}

function hashFile(file) {
  readonlyFile(file);
  const digest = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(65536);
    let size;
    while ((size = fs.readSync(fd, chunk, 0, chunk.length, null)) !== 0)
      digest.update(chunk.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest("hex");
}

function absentDatabase() {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    assert.equal(fs.lstatSync(DATABASE + suffix, { throwIfNoEntry: false }), undefined, "Smoke DB must not exist");
}

function closureSnapshot() {
  const manifest = readSmall("/.x2-manifest");
  const seal = readSmall("/.x2-seal");
  assert(isUtf8(manifest) && isUtf8(seal), "Non-UTF8 closure metadata");
  assert(/^[a-f0-9]{64}\n$/.test(seal.toString()), "Invalid closure seal");
  assert.equal(hash(manifest), seal.toString().trim(), "Manifest/seal mismatch");
  assert(manifest.length > 0 && manifest.at(-1) === 10, "Incomplete manifest");
  const lines = manifest.toString().slice(0, -1).split("\n");
  assert(lines.length <= MAX_MANIFEST_ENTRIES, "Manifest entry budget exceeded");
  const entries = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (\/[\x21-\x7e]+)$/.exec(line);
    assert(match, "Invalid manifest line");
    const [, expected, file] = match;
    assert.equal(path.posix.normalize(file), file, "Noncanonical manifest path");
    assert(file !== "/" && !file.startsWith("/test/"), "Manifest overlaps test-only files");
    assert(!entries.has(file), "Duplicate manifest path");
    entries.add(file);
    assert.equal(hashFile(file), expected, `Packaged hash mismatch: ${file}`);
  }
  for (const file of [NODE, WORKER, "/app/statement-document.js", "/app/node_modules/xlsx/xlsx.js"])
    assert(entries.has(file), `Missing required packaged entry: ${file}`);
  return {
    entries,
    record: {
      manifest: { bytes: manifest.length, base64: manifest.toString("base64"), sha256: hash(manifest) },
      seal: seal.toString().trim(),
      files: entries.size,
      nodeSha256: hashFile(NODE),
      workerSha256: hashFile(WORKER),
      guardSha256: hashFile(GUARD),
      harnessSha256: hashFile(SELF),
    },
  };
}

function checkModuleOrigins(entries) {
  for (const file of Object.keys(require.cache))
    assert(file === SELF || file === GUARD || entries.has(file), `Module outside packaged closure: ${file}`);
}

function packageVersion(file, entries) {
  assert(entries.has(file), `Package metadata outside closure: ${file}`);
  const version = JSON.parse(readSmall(file).toString("utf8")).version;
  assert(typeof version === "string" && version.length <= 80, "Invalid package version");
  return version;
}

function environmentCheck() {
  assert.equal(process.platform, "linux", "Linux-only smoke");
  assert.equal(process.arch, "x64", "Initial amd64 closure only");
  assert.equal(process.version, "v20.20.2", "Unexpected packaged Node");
  assert.equal(process.execPath, NODE);
  assert.equal(process.cwd(), "/test");
  assert(process.getuid() !== 0 && process.getgid() !== 0, "Smoke must be non-root");
  assert(process.argv.length === 2 && process.argv[1] === SELF, "Unexpected harness arguments");
  assert(process.execArgv.length === 2 && process.execArgv[0] === "--require" && process.execArgv[1] === GUARD,
    "Canonical guard must be preloaded explicitly");
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "LD_LIBRARY_PATH", "LD_PRELOAD"])
    assert(!Object.hasOwn(process.env, key), `Forbidden inherited environment key: ${key}`);
  assert.equal(process.env.TZ, "UTC");
  assert.equal(process.env.TEST_DATABASE_URL, DATABASE_URL);
  assert.equal(process.env.DATABASE_URL, DATABASE_URL, "Guard did not set the expected unused DB URL");
  assert(require.cache[GUARD]?.loaded, "Canonical guard was not loaded");
  absentDatabase();
}

function frame(kind, payload = Buffer.alloc(0), profile = 1) {
  const h = Buffer.from("58324e310001000000000000", "hex");
  h[4] = kind;
  h[5] = profile;
  h.writeUInt32BE(payload.length, 8);
  return Buffer.concat([h, payload]);
}

// Keep the frozen worker spec's fixture blocks byte-exact, including indentation.
function spreadsheet(XLSX, format) {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ["Fatura de cartao"],
          ["Vencimento 10/11/2025"],
          ["Lancamentos desta fatura"],
          ["Data", "Descricao", "Valor"],
          ["23/10/2025", "LOJA SINTETICA", "12,34"],
        ]),
        "Fatura",
      );
      const bytes = Buffer.from(
        XLSX.write(workbook, {
          type: "buffer",
          bookType: format === "XLS" ? "biff8" : "xlsx",
        }),
      );
  return bytes;
}

function pdfFixture() {
    const lines = [
      "Fatura de cartao",
      "Vencimento 10/11/2025",
      "Lancamentos desta fatura",
      "Data Descricao Valor",
      "23/10/2025 LOJA SINTETICA 12,34",
    ];
    const stream = lines
      .map(
        (line, index) =>
          `BT /F1 10 Tf 1 0 0 1 36 ${800 - index * 16} Tm (${line}) Tj ET`,
      )
      .join("\n");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = objects.map((object, index) => {
      const offset = Buffer.byteLength(pdf);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      return offset;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function bytesRecord(bytes) {
  return { bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") };
}

function runWorker(profile, input) {
  return new Promise((resolve) => {
    const start = performance.now();
    const startedAt = new Date().toISOString();
    const channels = {
      stdout: { chunks: [], observed: 0, captured: 0, ended: false },
      stderr: { chunks: [], observed: 0, captured: 0, ended: false },
    };
    let child = null;
    let timer = null;
    let spawned = false;
    let exitSeen = false;
    let closed = false;
    let decided = false;
    let aborting = false;
    let submitted = false;
    let written = false;
    let failure = null;
    let kill = null;
    let exitCode = null;
    let signal = null;
    const raw = (name) => {
      const channel = channels[name];
      return { ...bytesRecord(Buffer.concat(channel.chunks)), observedBytes: channel.observed,
        complete: closed && channel.ended && channel.observed === channel.captured };
    };
    const finish = () => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      const durationMs = performance.now() - start;
      if (durationMs >= WORKER_TIMEOUT_MS && failure === null)
        failure = { reason: "WORKER_TIMEOUT" };
      resolve({
        pid: child?.pid ?? null, startedAt, durationMs, spawned, exitSeen, closed,
        exitCode, signal, failure, kill,
        cleanup: spawned && exitSeen && closed && channels.stdout.ended && channels.stderr.ended
          ? "CONFIRMED" : "UNCERTAIN",
        stdin: { ...bytesRecord(input), submitted, written },
        stdout: raw("stdout"), stderr: raw("stderr"),
      });
    };
    const abort = (reason, error) => {
      if (decided) return;
      if (aborting) {
        failure.secondary = { reason, error: error === undefined ? null : errorRecord(error) };
        return;
      }
      aborting = true;
      failure = { reason, error: error === undefined ? null : errorRecord(error) };
      if (child && !exitSeen && Number.isSafeInteger(child.pid)) {
        try {
          kill = { signal: "SIGKILL", requested: child.kill("SIGKILL") };
        } catch (killError) {
          kill = { signal: "SIGKILL", requested: false, error: errorRecord(killError) };
        }
      }
      // A kill request is not termination proof. No later profile starts on this path.
      finish();
    };
    try {
      child = spawn(NODE, WORKER_ARGS, {
        cwd: "/test", env: WORKER_ENV, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      abort("SPAWN_THROW", error);
      return;
    }
    child.once("error", (error) => abort("CHILD_ERROR", error));
    child.once("exit", (code, value) => { exitSeen = true; exitCode = code; signal = value; });
    child.once("close", (code, value) => {
      closed = true;
      exitCode = code;
      signal = value;
      if (decided) {
        emit("late-close", { profile, pid: child.pid ?? null, exitSeen, exitCode, signal,
          stdout: raw("stdout"), stderr: raw("stderr"), doesNotUpgradeVerdict: true });
      } else finish();
    });
    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        const channel = channels[name];
        channel.observed += chunk.length;
        const retained = chunk.subarray(0, Math.max(0, MAX_BYTES - channel.captured));
        if (retained.length) {
          channel.chunks.push(Buffer.from(retained));
          channel.captured += retained.length;
        }
        if (channel.observed > MAX_BYTES) abort(`${name.toUpperCase()}_BUDGET`);
      });
      child[name].once("end", () => { channels[name].ended = true; });
      child[name].once("error", (error) => abort(`${name.toUpperCase()}_ERROR`, error));
    }
    child.stdin.once("error", (error) => abort("STDIN_ERROR", error));
    child.once("spawn", () => {
      spawned = true;
      try {
        submitted = true;
        child.stdin.end(input, (error) => {
          if (error) abort("STDIN_ERROR", error);
          else written = true;
        });
      } catch (error) {
        abort("STDIN_THROW", error);
      }
    });
    timer = setTimeout(() => abort("WORKER_TIMEOUT"),
      Math.max(0, WORKER_TIMEOUT_MS - (performance.now() - start)));
  });
}

function validateResponse(run, expected, validateDocumentExtraction) {
  assert.equal(run.failure, null, "Worker failed or exceeded a smoke budget");
  assert.equal(run.cleanup, "CONFIRMED", "Worker termination/drainage unconfirmed");
  assert.equal(run.exitCode, 0, "Nonzero worker exit");
  assert.equal(run.signal, null, "Worker exited by signal");
  assert(run.stdin.written && run.stdout.complete && run.stderr.complete, "Incomplete channels");
  assert.equal(run.stderr.bytes, 0, "Unexpected worker stderr");
  const stdout = Buffer.from(run.stdout.base64, "base64");
  assert(stdout.length >= 24, "Missing READY/RESULT headers");
  for (const [offset, kind] of [[0, 10], [12, 5]]) {
    assert.equal(stdout.subarray(offset, offset + 4).toString("hex"), "58324e31", "Wrong frame magic");
    assert.equal(stdout[offset + 4], kind, "Unexpected frame kind");
    assert.equal(stdout[offset + 5], expected.profile, "Wrong frame profile");
    assert.equal(stdout.readUInt16BE(offset + 6), 0, "Nonzero reserved field");
  }
  assert.equal(stdout.readUInt32BE(8), 0, "READY must have no body");
  const length = stdout.readUInt32BE(20);
  assert(length > 0 && length <= MAX_BYTES, "Invalid RESULT length");
  assert.equal(stdout.length, 24 + length, "Truncated RESULT or extra bytes");
  const body = stdout.subarray(24);
  assert(isUtf8(body), "Invalid RESULT UTF8");
  const dto = validateDocumentExtraction(JSON.parse(body.toString("utf8")));
  assert.equal(dto.parserVersion, expected.parserVersion);
  assert.equal(dto.occurrences.length, expected.occurrences);
  assert.equal(dto.occurrences[0].amountCents, expected.amountCents);
  return dto;
}

async function main() {
  const cases = PROFILES.map(({ format, profile }) => ({ format, profile, status: "NOT_RUN" }));
  let before = null;
  let after = null;
  let fatal = null;
  let postError = null;
  let stopped = "PRECHECK_FAILED";
  try {
    environmentCheck();
    before = closureSnapshot();
    emit("start", {
      argv: [NODE, ...process.execArgv, SELF], pid: process.pid,
      versions: {
        node: process.version,
        xlsx: packageVersion("/app/node_modules/xlsx/package.json", before.entries),
        pdfParse: packageVersion("/app/node_modules/pdf-parse/package.json", before.entries),
        canvas: packageVersion("/app/node_modules/@napi-rs/canvas/package.json", before.entries),
      },
      manifestPre: before.record, workerArgv: [NODE, ...WORKER_ARGS], workerEnv: WORKER_ENV,
      budgets: { workerMs: WORKER_TIMEOUT_MS, fixtureBytes: MAX_BYTES, channelBytes: MAX_BYTES,
        recordBytes: MAX_RECORD_BYTES, records: MAX_RECORDS },
    });
    const XLSX = require("/app/node_modules/xlsx/xlsx.js");
    const { validateDocumentExtraction } = require("/app/statement-document.js");
    assert.equal(typeof validateDocumentExtraction, "function", "Missing packaged DTO validator");
    checkModuleOrigins(before.entries);
    for (const [index, expected] of PROFILES.entries()) {
      absentDatabase();
      const bytes = expected.format === "PDF" ? pdfFixture() : spreadsheet(XLSX, expected.format);
      assert(bytes.length > 0 && bytes.length <= MAX_BYTES, "Fixture exceeds smoke budget");
      const input = Buffer.concat([frame(9, Buffer.alloc(0), expected.profile), frame(4, bytes, expected.profile)]);
      const run = await runWorker(expected.profile, input);
      let dto = null;
      let error = null;
      try {
        dto = validateResponse(run, expected, validateDocumentExtraction);
        absentDatabase();
        checkModuleOrigins(before.entries);
      } catch (caught) {
        error = errorRecord(caught);
      }
      cases[index] = { format: expected.format, profile: expected.profile,
        status: error === null ? "PASS" : "FAIL", cleanup: run.cleanup };
      emit("case", { ...cases[index], fixture: bytesRecord(bytes), expected,
        argv: [NODE, ...WORKER_ARGS], cwd: "/test", run, dto, error });
      if (run.cleanup !== "CONFIRMED") {
        stopped = "PREVIOUS_WORKER_TERMINATION_UNCONFIRMED";
        break;
      }
    }
  } catch (error) {
    fatal = errorRecord(error);
    stopped = "HARNESS_FAILURE";
  }
  try {
    absentDatabase();
    if (before !== null) {
      after = closureSnapshot();
      assert.deepEqual(after.record, before.record, "Closure or test-only source changed");
      checkModuleOrigins(before.entries);
    }
  } catch (error) {
    postError = errorRecord(error);
  }
  for (const item of cases)
    if (item.status === "NOT_RUN") emit("not-run", { ...item, reason: stopped });
  const passed = fatal === null && postError === null && before !== null && after !== null
    && cases.length === 3 && cases.every((item) => item.status === "PASS" && item.cleanup === "CONFIRMED");
  emit("summary", { status: passed ? "PASS" : "FAIL", cases, fatal, postError,
    manifestPost: after?.record ?? null, unusedDatabaseAbsent: postError === null,
    postCheckAfterConfirmedTermination: cases.every((item) => item.status === "NOT_RUN" || item.cleanup === "CONFIRMED"),
    scope: "Three packaged-root goldens only; not launcher isolation or exhaustive runtime closure" });
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  process.exitCode = 1;
  process.stderr.write(JSON.stringify({ protocol: "X2_ROOT_SMOKE_V1", event: "fatal", error: errorRecord(error) }) + "\n");
});
