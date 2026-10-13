#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync } from "node:fs";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACT = "vault-production-review-only-qa";
const VERSION = 1;
const DATABASE = "/data/dev.db";
const MANIFEST = "/data/vault-production-qa.private.json";
const TRACE = "/data/vault-production-qa.trace.private.json";
const RECEIPT = "/data/vault-production-qa.consumed.private.json";
const UPSTREAM_ORIGIN = "https://reformaflow-api.fly.dev";
const GUARD_HOST = "127.0.0.1";
const GUARD_PORT = 4317;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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
    expiresAt - startsAt > 4 * 60 * 60 * 1000 ||
    now < startsAt ||
    now >= expiresAt
  )
    fail("QA_WINDOW_NOT_ACTIVE");
  return metadata;
}

function databaseIdentity(database) {
  let entry;
  try {
    entry = lstatSync(database, { bigint: true });
  } catch {
    fail("QA_DATABASE_UNSAFE");
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n)
    fail("QA_DATABASE_UNSAFE");
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
  };
}

function exactIdentity(left, right) {
  return (
    exactObject(left, ["device", "inode"]) &&
    exactObject(right, ["device", "inode"]) &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function quoteSql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseFingerprint(database) {
  const before = databaseIdentity(database);
  const countStatements = FINANCIAL_TABLES.map(
    (table) =>
      `SELECT ${quoteSql(`__RF_COUNT_${table}__`)} || CAST(COUNT(*) AS TEXT) FROM "${table}";`,
  );
  const rowStatements = FINANCIAL_TABLES.map(
    (table) => `SELECT * FROM "${table}" ORDER BY rowid;`,
  );
  const input = [
    ".bail on",
    ".timeout 0",
    ".headers off",
    ".mode list",
    "PRAGMA query_only = ON;",
    "BEGIN;",
    "SELECT '__RF_QUERY_ONLY__' || CAST(query_only AS TEXT) FROM pragma_query_only;",
    ...countStatements,
    `SELECT '__RF_COUNT_EXECUTE__' || CAST(COUNT(*) AS TEXT) FROM user_activity_logs WHERE action = ${quoteSql(EXECUTE_ACTION)};`,
    ".print __RF_FINANCIAL_ROWS__",
    ".headers on",
    ".mode quote",
    ...rowStatements,
    ".print __RF_EXECUTE_ROWS__",
    `SELECT * FROM user_activity_logs WHERE action = ${quoteSql(EXECUTE_ACTION)} ORDER BY rowid;`,
    ".headers off",
    ".mode list",
    "SELECT '__RF_TOTAL_CHANGES__' || CAST(total_changes() AS TEXT);",
    "ROLLBACK;",
  ].join("\n");
  const result = spawnSync("sqlite3", ["-batch", "-readonly", database], {
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0 || result.stderr !== "")
    fail("QA_DATABASE_READ_FAILED");
  const financialMarker = "\n__RF_FINANCIAL_ROWS__\n";
  const executeMarker = "\n__RF_EXECUTE_ROWS__\n";
  const financialAt = result.stdout.indexOf(financialMarker);
  const executeAt = result.stdout.indexOf(executeMarker);
  if (financialAt < 0 || executeAt <= financialAt)
    fail("QA_DATABASE_READ_FAILED");
  const preamble = result.stdout.slice(0, financialAt).trim().split("\n");
  if (
    preamble.shift() !== "__RF_QUERY_ONLY__1" ||
    preamble.length !== FINANCIAL_TABLES.length + 1
  )
    fail("QA_DATABASE_READ_FAILED");
  const tables = FINANCIAL_TABLES.map((table) => {
    const prefix = `__RF_COUNT_${table}__`;
    const line = preamble.shift();
    if (
      !line?.startsWith(prefix) ||
      !/^(?:0|[1-9][0-9]*)$/.test(line.slice(prefix.length))
    )
      fail("QA_DATABASE_READ_FAILED");
    return { name: table, count: Number(line.slice(prefix.length)) };
  });
  const executeLine = preamble.shift();
  const executePrefix = "__RF_COUNT_EXECUTE__";
  if (
    !executeLine?.startsWith(executePrefix) ||
    !/^(?:0|[1-9][0-9]*)$/.test(executeLine.slice(executePrefix.length))
  )
    fail("QA_DATABASE_READ_FAILED");
  const executeTail = result.stdout.slice(executeAt + executeMarker.length);
  const changesMarker = "__RF_TOTAL_CHANGES__0\n";
  const changesAt = executeTail.lastIndexOf(changesMarker);
  if (changesAt < 0) fail("QA_DATABASE_READ_FAILED");
  const financialRows = result.stdout.slice(
    financialAt + financialMarker.length,
    executeAt,
  );
  const executeRows = executeTail.slice(
    0,
    changesAt > 0 && executeTail[changesAt - 1] === "\n"
      ? changesAt - 1
      : changesAt,
  );
  const after = databaseIdentity(database);
  if (!exactIdentity(before, after)) fail("QA_DATABASE_REPLACED");
  return {
    databaseIdentity: before,
    financial: {
      tables,
      digest: sha256(financialRows),
    },
    executeAudit: {
      count: Number(executeLine.slice(executePrefix.length)),
      digest: sha256(executeRows),
    },
  };
}

function assertAbsent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("QA_PRIVATE_FILE_UNSAFE");
  }
  fail("QA_WINDOW_REUSED");
}

function readPrivateJson(path) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    fail("QA_PRIVATE_FILE_UNSAFE");
  }
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    (entry.mode & 0o777) !== 0o600 ||
    entry.size > 1024 * 1024
  )
    fail("QA_PRIVATE_FILE_UNSAFE");
  const bytes = readFileSync(path);
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    fail("QA_PRIVATE_FILE_INVALID");
  }
  if (!bytes.equals(canonicalBytes(value))) fail("QA_PRIVATE_FILE_INVALID");
  return value;
}

function createPrivateJson(path, value) {
  assertAbsent(path);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, canonicalBytes(value));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof ProductionQaError) throw error;
    fail("QA_PRIVATE_FILE_UNSAFE");
  }
  closeSync(descriptor);
}

function metadataEqual(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

export function captureProductionQaBaseline({ database, manifest, metadata }) {
  validateMetadata(metadata);
  assertAbsent(manifest);
  const fingerprint = databaseFingerprint(database);
  const capturedAt = new Date().toISOString();
  const payload = {
    version: VERSION,
    contract: CONTRACT,
    state: "captured",
    metadata,
    capturedAt,
    ...fingerprint,
  };
  createPrivateJson(manifest, {
    ...payload,
    integrity: sha256(canonicalBytes(payload)),
  });
  return `vault-production-qa capture ok financial_tables=${FINANCIAL_TABLES.length} execute_events=${fingerprint.executeAudit.count} hash=${sha256(canonicalBytes(payload)).slice(0, 12)}`;
}

function validateTrace(trace, metadata) {
  if (
    !exactObject(trace, ["version", "metadata", "summary"]) ||
    trace.version !== VERSION ||
    !metadataEqual(trace.metadata, metadata) ||
    !exactObject(trace.summary, [
      "allowedRequests",
      "forbiddenRequests",
      "readyObserved",
      "stateViolations",
    ]) ||
    !Number.isSafeInteger(trace.summary.allowedRequests) ||
    trace.summary.allowedRequests < 0 ||
    trace.summary.forbiddenRequests !== 0 ||
    trace.summary.readyObserved !== true ||
    trace.summary.stateViolations !== 0
  )
    fail("QA_TRACE_REJECTED");
}

export function compareProductionQaBaseline({
  database,
  manifest,
  trace,
  receipt,
  metadata,
}) {
  validateMetadata(metadata);
  assertAbsent(receipt);
  const baseline = readPrivateJson(manifest);
  const guardTrace = readPrivateJson(trace);
  if (
    !exactObject(baseline, [
      "version",
      "contract",
      "state",
      "metadata",
      "capturedAt",
      "databaseIdentity",
      "financial",
      "executeAudit",
      "integrity",
    ]) ||
    baseline.version !== VERSION ||
    baseline.contract !== CONTRACT ||
    baseline.state !== "captured" ||
    !metadataEqual(baseline.metadata, metadata)
  )
    fail("QA_METADATA_MISMATCH");
  const { integrity, ...payload } = baseline;
  if (integrity !== sha256(canonicalBytes(payload)))
    fail("QA_MANIFEST_TAMPERED");
  validateTrace(guardTrace, metadata);
  const current = databaseFingerprint(database);
  if (
    !exactIdentity(baseline.databaseIdentity, current.databaseIdentity) ||
    !canonicalBytes(baseline.financial).equals(
      canonicalBytes(current.financial),
    ) ||
    !canonicalBytes(baseline.executeAudit).equals(
      canonicalBytes(current.executeAudit),
    )
  )
    fail("QA_DATABASE_DRIFT");
  const comparisonDigest = sha256(canonicalBytes(current));
  createPrivateJson(receipt, {
    version: VERSION,
    contract: CONTRACT,
    state: "consumed",
    metadata,
    manifestSha256: sha256(readFileSync(manifest)),
    traceSha256: sha256(readFileSync(trace)),
    comparisonSha256: comparisonDigest,
    consumedAt: new Date().toISOString(),
  });
  return `vault-production-qa compare ok financial_tables=${FINANCIAL_TABLES.length} execute_events=${current.executeAudit.count} hash=${comparisonDigest.slice(0, 12)}`;
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

function responseSessionState(path, bytes, contentType) {
  if (
    !IMPORT_SESSION_PATH.test(path) ||
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
  constructor({ upstreamOrigin }) {
    this.upstreamOrigin = upstreamOrigin;
    this.allowedRequests = 0;
    this.forbiddenRequests = 0;
    this.readyObserved = false;
    this.stateViolations = 0;
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end("production QA guard rejected request\n");
      });
    });
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

  summary() {
    return {
      allowedRequests: this.allowedRequests,
      forbiddenRequests: this.forbiddenRequests,
      readyObserved: this.readyObserved,
      stateViolations: this.stateViolations,
    };
  }

  async handle(request, response) {
    const path = decodedPath(request.url ?? "/");
    if (
      (request.method ?? "").toUpperCase() === "POST" &&
      FORBIDDEN_PATH.test(path)
    ) {
      this.forbiddenRequests += 1;
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("production QA guard forbids financial action\n");
      return;
    }
    if (this.readyObserved && IMPORT_SESSION_PATH.test(path)) {
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
      path,
      bytes,
      upstream.headers.get("content-type") ?? "",
    );
    if (session?.state === "CONFIRMED" || session?.state === "APPLIED") {
      this.stateViolations += 1;
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
        this.stateViolations += 1;
        response.writeHead(502, { "content-type": "text/plain" });
        response.end("production QA guard rejected READY contract\n");
        return;
      }
      this.readyObserved = true;
    }
    this.allowedRequests += 1;
    const responseHeaders = {};
    for (const [name, value] of upstream.headers) {
      if (!["content-length", "connection", "transfer-encoding"].includes(name))
        responseHeaders[name] = value;
    }
    response.writeHead(upstream.status, responseHeaders);
    response.end(bytes);
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
  if (
    process.argv.length !== 3 ||
    !["capture", "guard", "compare"].includes(process.argv[2])
  )
    fail("QA_INVALID_ARGUMENTS");
  const mode = process.argv[2];
  const metadata = metadataFromEnvironment();
  if (mode === "capture") {
    console.log(
      captureProductionQaBaseline({
        database: DATABASE,
        manifest: MANIFEST,
        metadata,
      }),
    );
    return;
  }
  if (mode === "compare") {
    console.log(
      compareProductionQaBaseline({
        database: DATABASE,
        manifest: MANIFEST,
        trace: TRACE,
        receipt: RECEIPT,
        metadata,
      }),
    );
    return;
  }
  assertAbsent(TRACE);
  const guard = new ProductionQaGuard({ upstreamOrigin: UPSTREAM_ORIGIN });
  await guard.listen({ host: GUARD_HOST, port: GUARD_PORT });
  console.log(
    `vault-production-qa guard ready origin=http://${GUARD_HOST}:${GUARD_PORT}`,
  );
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await guard.close();
  const summary = guard.summary();
  createPrivateJson(TRACE, { version: VERSION, metadata, summary });
  if (
    summary.forbiddenRequests !== 0 ||
    summary.stateViolations !== 0 ||
    summary.readyObserved !== true
  )
    fail("QA_TRACE_REJECTED");
  console.log(
    `vault-production-qa guard ok allowed=${summary.allowedRequests} ready=1`,
  );
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
