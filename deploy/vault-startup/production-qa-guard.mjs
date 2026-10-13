#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, lstatSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACT = "vault-production-review-only-qa";
const VERSION = 2;
const DATABASE = "/data/dev.db";
const MANIFEST = "/data/vault-production-qa.private.json";
const TRACE = "/data/vault-production-qa.trace.private.json";
const RECEIPT = "/data/vault-production-qa.consumed.private.json";
const UPSTREAM_ORIGIN = "https://reformaflow-api.fly.dev";
const SQLITE_BINARY = "/usr/bin/sqlite3";
const GUARD_HOST = "127.0.0.1";
const GUARD_PORT = 4317;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;
const SQLITE_DEADLINE_MILLISECONDS = 30_000;
const MAX_WINDOW_MILLISECONDS = 4 * 60 * 60 * 1000;
const EXECUTE_ACTION = "importSessions.execute";
const FINANCIAL_TABLES = Object.freeze([
  "bank_accounts",
  "bank_statement_imports",
  "budget_allocations",
  "cash_flow_entries",
  "credit_cards",
  "credit_card_imports",
  "cross_project_settlements",
  "expenses",
  "imported_invoice_liquidations",
  "invoice_adjustments",
  "rateio_allocations",
  "receipts",
]);
const FORBIDDEN_PATH =
  /^(?:\/api)?\/import-sessions\/[^/]+\/(?:confirmation-challenge|confirm|execute)\/?$/i;
const IMPORT_SESSION_PATH = /^(?:\/api)?\/import-sessions(?:\/|$)/i;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,199}$/;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

class ProductionQaError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new ProductionQaError(code);
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function timestamp(value) {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  )
    fail("QA_INVALID_WINDOW");
  return milliseconds;
}

function validateMetadata(metadata, now = Date.now()) {
  if (
    !exactObject(metadata, [
      "releaseSha",
      "releaseId",
      "imageDigest",
      "windowId",
      "windowStart",
      "windowEnd",
      "qaActor",
    ]) ||
    !RELEASE_SHA.test(metadata.releaseSha) ||
    !IMAGE_DIGEST.test(metadata.imageDigest) ||
    ![metadata.releaseId, metadata.windowId, metadata.qaActor].every(
      (value) => typeof value === "string" && SAFE_REFERENCE.test(value),
    )
  )
    fail("QA_INVALID_METADATA");
  const startsAt = timestamp(metadata.windowStart);
  const expiresAt = timestamp(metadata.windowEnd);
  if (
    expiresAt <= startsAt ||
    expiresAt - startsAt > MAX_WINDOW_MILLISECONDS ||
    now < startsAt ||
    now >= expiresAt
  )
    fail("QA_WINDOW_NOT_ACTIVE");
  return metadata;
}

function assertAbsoluteNormalized(target) {
  if (
    typeof target !== "string" ||
    !path.isAbsolute(target) ||
    path.normalize(target) !== target
  )
    fail("QA_PRIVATE_FILE_UNSAFE");
}

function assertNoSymlinkComponents(target, includeLeaf) {
  assertAbsoluteNormalized(target);
  const parsed = path.parse(target);
  const components = target
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  const limit = includeLeaf ? components.length : components.length - 1;
  let current = parsed.root;
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch {
      fail("QA_PRIVATE_FILE_UNSAFE");
    }
    if (stat.isSymbolicLink()) fail("QA_PRIVATE_FILE_UNSAFE");
    if (index < limit - 1 && !stat.isDirectory())
      fail("QA_PRIVATE_FILE_UNSAFE");
  }
}

function secureRegularStat(
  target,
  requiredMode = null,
  code = "QA_PRIVATE_FILE_UNSAFE",
) {
  try {
    assertNoSymlinkComponents(target, true);
  } catch {
    fail(code);
  }
  let stat;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch {
    fail(code);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (requiredMode !== null && Number(stat.mode & 0o777n) !== requiredMode)
  )
    fail(code);
  return stat;
}

function secureDirectoryStat(target, code = "QA_DATABASE_UNSAFE") {
  try {
    assertNoSymlinkComponents(target, true);
  } catch {
    fail(code);
  }
  let stat;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch {
    fail(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
  return stat;
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function publicIdentity(stat) {
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function samePublicIdentity(left, right) {
  return (
    exactObject(left, ["device", "inode"]) &&
    exactObject(right, ["device", "inode"]) &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function assertAbsent(target) {
  assertNoSymlinkComponents(target, false);
  try {
    lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("QA_PRIVATE_FILE_UNSAFE");
  }
  fail("QA_WINDOW_REUSED");
}

async function readHandleBytes(handle, expectedLength) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0)
    fail("QA_PRIVATE_FILE_UNSAFE");
  const bytes = Buffer.alloc(expectedLength);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesRead === 0) fail("QA_PRIVATE_FILE_REPLACED");
    offset += bytesRead;
  }
  return bytes;
}

async function verifyPrivateFile(opened) {
  const descriptorBefore = await opened.handle.stat({ bigint: true });
  const pathStat = secureRegularStat(opened.path, 0o600);
  if (
    !sameIdentity(opened.stat, descriptorBefore) ||
    !sameIdentity(descriptorBefore, pathStat) ||
    descriptorBefore.size !== BigInt(opened.bytes.length)
  )
    fail("QA_PRIVATE_FILE_REPLACED");
  const bytes = await readHandleBytes(opened.handle, opened.bytes.length);
  const descriptorAfter = await opened.handle.stat({ bigint: true });
  const pathAfter = secureRegularStat(opened.path, 0o600);
  if (
    !bytes.equals(opened.bytes) ||
    !sameIdentity(descriptorBefore, descriptorAfter) ||
    !sameIdentity(descriptorAfter, pathAfter)
  )
    fail("QA_PRIVATE_FILE_REPLACED");
}

async function createPrivateFile(target, value) {
  assertNoSymlinkComponents(target, false);
  const bytes = canonicalBytes(value);
  if (bytes.length > MAX_PRIVATE_FILE_BYTES) fail("QA_PRIVATE_FILE_UNSAFE");
  let handle;
  try {
    handle = await open(
      target,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") fail("QA_WINDOW_REUSED");
    fail("QA_PRIVATE_FILE_UNSAFE");
  }
  try {
    const created = await handle.stat({ bigint: true });
    if (
      !created.isFile() ||
      created.nlink !== 1n ||
      Number(created.mode & 0o777n) !== 0o600
    )
      fail("QA_PRIVATE_FILE_UNSAFE");
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    const pathStat = secureRegularStat(target, 0o600);
    if (
      written.size !== BigInt(bytes.length) ||
      !sameIdentity(written, pathStat)
    )
      fail("QA_PRIVATE_FILE_REPLACED");
    const opened = { path: target, bytes, handle, stat: written };
    await verifyPrivateFile(opened);
    return opened;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readSecureArtifact(target) {
  const before = secureRegularStat(target, null, "QA_ARTIFACT_UNSAFE");
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("QA_ARTIFACT_UNSAFE");
  }
  try {
    const descriptor = await handle.stat({ bigint: true });
    if (!sameIdentity(before, descriptor)) fail("QA_ARTIFACT_UNSAFE");
    const bytes = await readHandleBytes(handle, Number(descriptor.size));
    const after = secureRegularStat(target, null, "QA_ARTIFACT_UNSAFE");
    const descriptorAfter = await handle.stat({ bigint: true });
    if (
      !sameIdentity(descriptor, descriptorAfter) ||
      !sameIdentity(descriptorAfter, after)
    )
      fail("QA_ARTIFACT_UNSAFE");
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertLinuxDescriptorIdentity(processId, expected) {
  if (process.platform !== "linux") return;
  let matches = 0;
  try {
    for (const descriptor of readdirSync(`/proc/${processId}/fd`)) {
      try {
        const stat = statSync(`/proc/${processId}/fd/${descriptor}`, {
          bigint: true,
        });
        if (sameObject(stat, expected)) matches += 1;
      } catch {
        // Descriptor churn is rejected by the exact final count.
      }
    }
  } catch {
    fail("QA_DESCRIPTOR_PROOF_FAILED");
  }
  if (matches !== 1) fail("QA_DESCRIPTOR_PROOF_FAILED");
}

class ReadonlySqlite {
  constructor(databasePath, sqliteBinary, expectedIdentity) {
    this.databasePath = databasePath;
    this.sqliteBinary = sqliteBinary;
    this.expectedIdentity = expectedIdentity;
    this.sequence = 0;
    this.pending = null;
    this.stdout = "";
    this.stderr = "";
    this.closed = false;
  }

  async start() {
    this.child = spawn(
      this.sqliteBinary,
      ["-batch", "-readonly", this.databasePath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 64 * 1024) this.child.kill("SIGKILL");
    });
    this.exit = new Promise((resolve) => {
      this.child.once("close", (code) => {
        this.closed = true;
        if (this.pending) {
          clearTimeout(this.pending.deadline);
          this.pending.reject(new ProductionQaError("QA_DATABASE_READ_FAILED"));
          this.pending = null;
        }
        resolve(code);
      });
    });
    this.child.once("error", () => {
      if (this.pending) {
        clearTimeout(this.pending.deadline);
        this.pending.reject(new ProductionQaError("QA_DATABASE_OPEN_FAILED"));
        this.pending = null;
      }
    });
    this.child.stdin.write(".bail on\n.timeout 0\n.headers on\n.mode json\n");
    await this.requestRaw("PRAGMA query_only = ON;");
    const queryOnly = await this.requestJson(
      "SELECT CAST(query_only AS TEXT) AS value FROM pragma_query_only;",
    );
    if (
      queryOnly.length !== 1 ||
      !exactObject(queryOnly[0], ["value"]) ||
      queryOnly[0].value !== "1"
    )
      fail("QA_QUERY_ONLY_NOT_ENFORCED");
    const databases = await this.requestJson(
      "SELECT file FROM pragma_database_list WHERE name = 'main';",
    );
    if (
      databases.length !== 1 ||
      !exactObject(databases[0], ["file"]) ||
      databases[0].file !== this.databasePath
    )
      fail("QA_DATABASE_PATH_MISMATCH");
    assertLinuxDescriptorIdentity(this.child.pid, this.expectedIdentity);
  }

  onStdout(chunk) {
    this.stdout += chunk;
    if (!this.pending) return;
    const marker = `${this.pending.marker}\n`;
    const markerAt = this.stdout.indexOf(marker);
    if (markerAt < 0) return;
    const response = this.stdout.slice(0, markerAt).trim();
    this.stdout = this.stdout.slice(markerAt + marker.length);
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.deadline);
    if (this.stderr !== "") {
      pending.reject(new ProductionQaError("QA_DATABASE_READ_FAILED"));
      return;
    }
    pending.resolve(response);
  }

  requestRaw(script) {
    if (this.pending || this.closed || !this.child?.stdin.writable)
      return Promise.reject(new ProductionQaError("QA_DATABASE_READ_FAILED"));
    const marker = `__RF_QA_${process.pid}_${this.sequence}_${randomBytes(8).toString("hex")}__`;
    this.sequence += 1;
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => this.child.kill("SIGKILL"),
        SQLITE_DEADLINE_MILLISECONDS,
      );
      this.pending = { marker, resolve, reject, deadline };
      this.child.stdin.write(`${script}\n.print ${marker}\n`, (error) => {
        if (error && this.pending?.marker === marker) {
          clearTimeout(this.pending.deadline);
          this.pending = null;
          reject(new ProductionQaError("QA_DATABASE_READ_FAILED"));
        }
      });
    });
  }

  async requestJson(statement) {
    const raw = await this.requestRaw(statement);
    if (raw === "") return [];
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) fail("QA_DATABASE_READ_FAILED");
      return value;
    } catch {
      fail("QA_DATABASE_READ_FAILED");
    }
  }

  async close() {
    if (!this.child) return;
    if (!this.closed && this.child.stdin.writable)
      this.child.stdin.end(".exit\n");
    await this.exit;
  }
}

function parseCount(value) {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    fail("QA_DATABASE_READ_FAILED");
  const count = Number(value);
  if (!Number.isSafeInteger(count)) fail("QA_DATABASE_READ_FAILED");
  return count;
}

function quoteSql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function databaseFingerprint(database, original, hook) {
  const pathBefore = secureRegularStat(
    database.databasePath,
    null,
    "QA_DATABASE_UNSAFE",
  );
  const parentBefore = secureDirectoryStat(
    path.dirname(database.databasePath),
    "QA_DATABASE_UNSAFE",
  );
  if (!sameObject(pathBefore, original)) fail("QA_DATABASE_REPLACED");
  assertLinuxDescriptorIdentity(database.child.pid, original);
  const versionBeforeRows = await database.requestJson(
    "SELECT CAST(data_version AS TEXT) AS value FROM pragma_data_version;",
  );
  if (
    versionBeforeRows.length !== 1 ||
    !exactObject(versionBeforeRows[0], ["value"])
  )
    fail("QA_DATABASE_READ_FAILED");
  const dataVersion = parseCount(versionBeforeRows[0].value);
  let transactionOpen = false;
  try {
    await database.requestRaw("BEGIN;");
    transactionOpen = true;
    if (hook) await hook();
    const countQuery = FINANCIAL_TABLES.map(
      (table) =>
        `SELECT ${quoteSql(table)} AS name, CAST(COUNT(*) AS TEXT) AS count FROM "${table}"`,
    ).join("\nUNION ALL\n");
    const countRows = await database.requestJson(
      `${countQuery}\nORDER BY name;`,
    );
    const tables = countRows.map((row) => {
      if (
        !exactObject(row, ["name", "count"]) ||
        !FINANCIAL_TABLES.includes(row.name)
      )
        fail("QA_DATABASE_READ_FAILED");
      return { name: row.name, count: parseCount(row.count) };
    });
    const expectedTableOrder = [...FINANCIAL_TABLES].sort();
    if (
      tables.length !== FINANCIAL_TABLES.length ||
      tables.some((table, index) => table.name !== expectedTableOrder[index])
    )
      fail("QA_DATABASE_READ_FAILED");
    const financialScript = [
      ".headers on",
      ".mode quote",
      ...FINANCIAL_TABLES.flatMap((table) => [
        `SELECT ${quoteSql(table)} AS "__rf_table__";`,
        `SELECT * FROM "${table}" ORDER BY rowid;`,
      ]),
      ".headers on",
      ".mode json",
    ].join("\n");
    const financialRows = await database.requestRaw(financialScript);
    const auditCountRows = await database.requestJson(
      `SELECT CAST(COUNT(*) AS TEXT) AS count
         FROM user_activity_logs
        WHERE action = ${quoteSql(EXECUTE_ACTION)};`,
    );
    if (
      auditCountRows.length !== 1 ||
      !exactObject(auditCountRows[0], ["count"])
    )
      fail("QA_DATABASE_READ_FAILED");
    const auditRows = await database.requestRaw(
      `.headers on
.mode quote
SELECT * FROM user_activity_logs
 WHERE action = ${quoteSql(EXECUTE_ACTION)}
 ORDER BY rowid;
.headers on
.mode json`,
    );
    assertLinuxDescriptorIdentity(database.child.pid, original);
    const pathDuring = secureRegularStat(
      database.databasePath,
      null,
      "QA_DATABASE_REPLACED",
    );
    if (!sameObject(pathDuring, original)) fail("QA_DATABASE_REPLACED");
    await database.requestRaw("ROLLBACK;");
    transactionOpen = false;
    const versionAfterRows = await database.requestJson(
      "SELECT CAST(data_version AS TEXT) AS value FROM pragma_data_version;",
    );
    const changes = await database.requestJson(
      "SELECT CAST(total_changes() AS TEXT) AS value;",
    );
    const pathAfter = secureRegularStat(
      database.databasePath,
      null,
      "QA_DATABASE_REPLACED",
    );
    const parentAfter = secureDirectoryStat(
      path.dirname(database.databasePath),
      "QA_DATABASE_REPLACED",
    );
    assertLinuxDescriptorIdentity(database.child.pid, original);
    if (
      versionAfterRows.length !== 1 ||
      !exactObject(versionAfterRows[0], ["value"]) ||
      parseCount(versionAfterRows[0].value) !== dataVersion ||
      changes.length !== 1 ||
      !exactObject(changes[0], ["value"]) ||
      changes[0].value !== "0" ||
      !sameIdentity(pathBefore, pathAfter) ||
      !sameIdentity(parentBefore, parentAfter)
    )
      fail("QA_DATABASE_REPLACED");
    return {
      databaseIdentity: publicIdentity(original),
      dataVersion,
      financial: { tables, digest: sha256(financialRows) },
      executeAudit: {
        count: parseCount(auditCountRows[0].count),
        digest: sha256(auditRows),
      },
    };
  } finally {
    if (transactionOpen && !database.closed) {
      try {
        await database.requestRaw("ROLLBACK;");
      } catch {
        // The original bounded failure remains authoritative.
      }
    }
  }
}

function decodedPath(requestUrl) {
  try {
    return decodeURIComponent(
      new URL(requestUrl, "http://guard.invalid").pathname,
    );
  } catch {
    fail("QA_INVALID_REQUEST_PATH");
  }
}

function responseSessionState(requestPath, bytes, contentType) {
  if (
    !IMPORT_SESSION_PATH.test(requestPath) ||
    !contentType.includes("application/json")
  )
    return null;
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return null;
  return body;
}

export class ProductionQaGuard {
  constructor({
    upstreamOrigin,
    evidenceNonce = randomBytes(32).toString("hex"),
  }) {
    this.upstreamOrigin = upstreamOrigin;
    this.allowedRequests = 0;
    this.forbiddenRequests = 0;
    this.readyObserved = false;
    this.stateViolations = 0;
    this.ordinal = 0;
    this.requestHash = createHash("sha256").update(evidenceNonce);
    this.terminal = new Promise((resolve) => {
      this.resolveTerminal = resolve;
    });
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        this.record("internal-rejection");
        this.stateViolations += 1;
        this.resolveTerminal("violation");
        if (!response.headersSent) response.writeHead(502);
        response.end("production QA guard rejected request\n");
      });
    });
  }

  record(outcome) {
    this.requestHash.update(canonicalBytes({ ordinal: this.ordinal, outcome }));
    this.ordinal += 1;
  }

  get origin() {
    const address = this.server.address();
    if (!address || typeof address === "string") fail("QA_GUARD_NOT_LISTENING");
    return `http://127.0.0.1:${address.port}`;
  }

  async listen({ host = "127.0.0.1", port = 0 } = {}) {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
  }

  async close() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  waitForTerminal() {
    return this.terminal;
  }

  summary() {
    return {
      allowedRequests: this.allowedRequests,
      forbiddenRequests: this.forbiddenRequests,
      readyObserved: this.readyObserved,
      stateViolations: this.stateViolations,
    };
  }

  evidenceSummary() {
    return {
      ...this.summary(),
      requestSummarySha256: this.requestHash.copy().digest("hex"),
    };
  }

  async handle(request, response) {
    const requestPath = decodedPath(request.url ?? "/");
    if (
      (request.method ?? "").toUpperCase() === "POST" &&
      FORBIDDEN_PATH.test(requestPath)
    ) {
      this.record("forbidden");
      this.forbiddenRequests += 1;
      this.resolveTerminal("violation");
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("production QA guard forbids financial action\n");
      return;
    }
    if (this.readyObserved && IMPORT_SESSION_PATH.test(requestPath)) {
      this.record("after-ready");
      response.writeHead(409, { "content-type": "text/plain" });
      response.end("production QA READY is terminal\n");
      return;
    }
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("connection");
    headers.delete("content-length");
    const hasBody = !["GET", "HEAD"].includes(request.method ?? "GET");
    const upstream = await fetch(
      `${this.upstreamOrigin}${request.url ?? "/"}`,
      {
        method: request.method,
        headers,
        body: hasBody ? request : undefined,
        duplex: hasBody ? "half" : undefined,
        redirect: "manual",
      },
    );
    const length = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)
      fail("QA_RESPONSE_TOO_LARGE");
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) fail("QA_RESPONSE_TOO_LARGE");
    const session = responseSessionState(
      requestPath,
      bytes,
      upstream.headers.get("content-type") ?? "",
    );
    if (session?.state === "CONFIRMED" || session?.state === "APPLIED") {
      this.record("state-violation");
      this.stateViolations += 1;
      this.resolveTerminal("violation");
      response.writeHead(502, { "content-type": "text/plain" });
      response.end("production QA guard rejected session state\n");
      return;
    }
    if (session?.state === "READY") {
      if (
        session.proposal === null ||
        session.proposal === undefined ||
        session.confirmation !== null ||
        session.receipt !== null
      ) {
        this.record("state-violation");
        this.stateViolations += 1;
        this.resolveTerminal("violation");
        response.writeHead(502, { "content-type": "text/plain" });
        response.end("production QA guard rejected READY contract\n");
        return;
      }
      this.readyObserved = true;
    }
    this.record(this.readyObserved ? "ready" : "allowed");
    this.allowedRequests += 1;
    const responseHeaders = {};
    for (const [name, value] of upstream.headers) {
      if (!["content-length", "connection", "transfer-encoding"].includes(name))
        responseHeaders[name] = value;
    }
    if (this.readyObserved)
      response.once("finish", () => this.resolveTerminal("ready"));
    response.writeHead(upstream.status, responseHeaders);
    response.end(bytes);
  }
}

function exactFingerprint(left, right) {
  return (
    samePublicIdentity(left.databaseIdentity, right.databaseIdentity) &&
    canonicalBytes(left.financial).equals(canonicalBytes(right.financial)) &&
    canonicalBytes(left.executeAudit).equals(canonicalBytes(right.executeAudit))
  );
}

export class ProductionQaSupervisor {
  constructor({
    database,
    manifest,
    trace,
    receipt,
    upstreamOrigin,
    artifactPath,
    sqliteBinary = SQLITE_BINARY,
    host = GUARD_HOST,
    port = GUARD_PORT,
    testHooks = {},
  }) {
    this.databasePath = database;
    this.manifestPath = manifest;
    this.tracePath = trace;
    this.receiptPath = receipt;
    this.upstreamOrigin = upstreamOrigin;
    this.artifactPath = artifactPath;
    this.sqliteBinary = sqliteBinary;
    this.host = host;
    this.port = port;
    this.testHooks = testHooks;
    this.privateFiles = [];
    this.state = "new";
  }

  get origin() {
    if (!this.guard) fail("QA_GUARD_NOT_LISTENING");
    return this.guard.origin;
  }

  async start(metadata) {
    if (this.state !== "new") fail("QA_WINDOW_REUSED");
    validateMetadata(metadata);
    if (
      new Set([
        this.databasePath,
        this.manifestPath,
        this.tracePath,
        this.receiptPath,
      ]).size !== 4
    )
      fail("QA_PRIVATE_FILE_UNSAFE");
    assertAbsent(this.manifestPath);
    assertAbsent(this.tracePath);
    assertAbsent(this.receiptPath);
    const artifactBytes = await readSecureArtifact(this.artifactPath);
    this.artifactSha256 = sha256(artifactBytes);
    this.metadata = structuredClone(metadata);
    this.nonce = randomBytes(32).toString("hex");
    this.monotonicStartNs = process.hrtime.bigint();
    this.startedAt = new Date().toISOString();
    this.expiration = new Promise((resolve) => {
      this.expirationTimer = setTimeout(
        () => resolve("expired"),
        timestamp(this.metadata.windowEnd) - Date.now(),
      );
    });
    this.databaseIdentity = secureRegularStat(
      this.databasePath,
      null,
      "QA_DATABASE_UNSAFE",
    );
    this.database = new ReadonlySqlite(
      this.databasePath,
      this.sqliteBinary,
      this.databaseIdentity,
    );
    await this.database.start();
    this.baseline = await databaseFingerprint(
      this.database,
      this.databaseIdentity,
      this.testHooks.afterSnapshotBegin,
    );
    const manifest = {
      version: VERSION,
      contract: CONTRACT,
      state: "captured",
      metadata: this.metadata,
      nonce: this.nonce,
      artifactSha256: this.artifactSha256,
      monotonicStartNs: this.monotonicStartNs.toString(),
      startedAt: this.startedAt,
      baseline: this.baseline,
    };
    this.manifest = await createPrivateFile(this.manifestPath, manifest);
    this.privateFiles.push(this.manifest);
    if (this.testHooks.afterCapture) await this.testHooks.afterCapture();
    this.guard = new ProductionQaGuard({
      upstreamOrigin: this.upstreamOrigin,
      evidenceNonce: this.nonce,
    });
    await this.guard.listen({ host: this.host, port: this.port });
    this.state = "guarding";
  }

  waitForTerminal() {
    if (this.state !== "guarding") fail("QA_GUARD_NOT_LISTENING");
    return Promise.race([this.guard.waitForTerminal(), this.expiration]);
  }

  async finish() {
    if (this.state !== "guarding") fail("QA_WINDOW_REUSED");
    this.state = "finishing";
    await this.guard.close();
    const monotonicEndNs = process.hrtime.bigint();
    const endedAt = new Date().toISOString();
    validateMetadata(this.metadata);
    if (
      monotonicEndNs <= this.monotonicStartNs ||
      timestamp(endedAt) < timestamp(this.startedAt)
    )
      fail("QA_MONOTONIC_WINDOW_INVALID");
    const summary = this.guard.evidenceSummary();
    const trace = {
      version: VERSION,
      contract: CONTRACT,
      state: "guarded",
      metadata: this.metadata,
      nonce: this.nonce,
      artifactSha256: this.artifactSha256,
      databaseIdentity: publicIdentity(this.databaseIdentity),
      monotonicStartNs: this.monotonicStartNs.toString(),
      monotonicEndNs: monotonicEndNs.toString(),
      endedAt,
      summary,
    };
    this.trace = await createPrivateFile(this.tracePath, trace);
    this.privateFiles.push(this.trace);
    if (this.testHooks.afterTrace) await this.testHooks.afterTrace();
    await verifyPrivateFile(this.manifest);
    await verifyPrivateFile(this.trace);
    if (
      summary.forbiddenRequests !== 0 ||
      summary.stateViolations !== 0 ||
      summary.readyObserved !== true
    )
      fail("QA_TRACE_REJECTED");
    const current = await databaseFingerprint(
      this.database,
      this.databaseIdentity,
      this.testHooks.afterFinalSnapshotBegin,
    );
    if (!exactFingerprint(this.baseline, current)) fail("QA_DATABASE_DRIFT");
    await verifyPrivateFile(this.manifest);
    await verifyPrivateFile(this.trace);
    const comparisonSha256 = sha256(canonicalBytes(current));
    const receipt = {
      version: VERSION,
      contract: CONTRACT,
      state: "consumed",
      metadata: this.metadata,
      nonce: this.nonce,
      artifactSha256: this.artifactSha256,
      manifestSha256: sha256(this.manifest.bytes),
      traceSha256: sha256(this.trace.bytes),
      comparisonSha256,
      monotonicStartNs: this.monotonicStartNs.toString(),
      monotonicEndNs: monotonicEndNs.toString(),
      consumedAt: new Date().toISOString(),
    };
    this.receipt = await createPrivateFile(this.receiptPath, receipt);
    this.privateFiles.push(this.receipt);
    await verifyPrivateFile(this.receipt);
    this.state = "complete";
    await this.database.close();
    return `vault-production-qa run ok financial_tables=${FINANCIAL_TABLES.length} execute_events=${current.executeAudit.count} hash=${comparisonSha256.slice(0, 12)}`;
  }

  async close() {
    if (this.expirationTimer) clearTimeout(this.expirationTimer);
    if (this.guard) {
      try {
        await this.guard.close();
      } catch {
        // Preserve the original bounded failure.
      }
    }
    if (this.database) {
      try {
        await this.database.close();
      } catch {
        // Preserve the original bounded failure.
      }
    }
    for (const opened of this.privateFiles.splice(0)) {
      try {
        await opened.handle.close();
      } catch {
        // Preserve the original bounded failure.
      }
    }
  }
}

function metadataFromEnvironment() {
  return validateMetadata({
    releaseSha: process.env.VAULT_QA_RELEASE_SHA,
    releaseId: process.env.VAULT_QA_RELEASE_ID,
    imageDigest: process.env.VAULT_QA_IMAGE_DIGEST,
    windowId: process.env.VAULT_QA_WINDOW_ID,
    windowStart: process.env.VAULT_QA_WINDOW_START,
    windowEnd: process.env.VAULT_QA_WINDOW_END,
    qaActor: process.env.VAULT_QA_ACTOR,
  });
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "run")
    fail("QA_INVALID_ARGUMENTS");
  const runner = new ProductionQaSupervisor({
    database: DATABASE,
    manifest: MANIFEST,
    trace: TRACE,
    receipt: RECEIPT,
    upstreamOrigin: UPSTREAM_ORIGIN,
    artifactPath: fileURLToPath(import.meta.url),
  });
  try {
    await runner.start(metadataFromEnvironment());
    console.log(
      `vault-production-qa guard ready origin=http://${GUARD_HOST}:${GUARD_PORT}`,
    );
    const interrupted = new Promise((resolve) => {
      process.once("SIGINT", () => resolve("interrupted"));
      process.once("SIGTERM", () => resolve("interrupted"));
    });
    await Promise.race([runner.waitForTerminal(), interrupted]);
    console.log(await runner.finish());
  } finally {
    await runner.close();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]))
) {
  main().catch((error) => {
    const code =
      error instanceof ProductionQaError ? error.code : "QA_INTERNAL_ERROR";
    console.error(`vault-production-qa failed (${code})`);
    process.exitCode = 1;
  });
}
