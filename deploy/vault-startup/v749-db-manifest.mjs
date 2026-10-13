#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT = "v749-current-db-no-mutation";
const VERSION = 1;
const MAX_BUFFER = 256 * 1024 * 1024;
const DEFAULTS = Object.freeze({
  database: "/data/dev.db",
  preManifest: "/data/v749-compatibility.pre.private.json",
  postManifest: "/data/v749-compatibility.post.private.json",
  receipt: "/data/v749-compatibility.consumed.private.json",
  sqliteBinary: "/usr/bin/sqlite3",
});
const SIDECARS = Object.freeze(["dev.db-journal", "dev.db-shm", "dev.db-wal"]);

export class CompatibilityProofError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function fail(code) {
  throw new CompatibilityProofError(code);
}
function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeFile(target, mode = null) {
  const value = lstatSync(target, { bigint: true });
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1n ||
    (mode !== null && Number(value.mode & 0o777n) !== mode)
  )
    fail("UNSAFE_FILE");
  return value;
}
function sameFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
function createPrivateFile(target, value) {
  const parent = lstatSync(path.dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail("UNSAFE_PATH");
  let descriptor;
  try {
    descriptor = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeSync(descriptor, canonicalBytes(value));
    fsyncSync(descriptor);
  } catch (error) {
    if (error?.code === "EEXIST") fail("EVIDENCE_EXISTS");
    if (error instanceof CompatibilityProofError) throw error;
    fail("EVIDENCE_WRITE_FAILED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  safeFile(target, 0o600);
}
function readPrivateFile(target) {
  safeFile(target, 0o600);
  const bytes = readFileSync(target);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_EVIDENCE");
  }
  if (!canonicalBytes(value).equals(bytes)) fail("INVALID_EVIDENCE");
  return value;
}
function runSqlite(database, statement, sqliteBinary, json = false) {
  const result = spawnSync(
    sqliteBinary,
    ["-readonly", "-batch", ...(json ? ["-json"] : []), database, statement],
    { encoding: "utf8", maxBuffer: MAX_BUFFER },
  );
  if (result.status !== 0 || result.signal !== null) fail("SQLITE_READ_FAILED");
  return result.stdout;
}
function parseSingleJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("SQLITE_OUTPUT_INVALID");
  }
  if (!Array.isArray(value) || value.length !== 1)
    fail("SQLITE_OUTPUT_INVALID");
  return value[0];
}
function databaseHeader(database) {
  const bytes = readFileSync(database).subarray(0, 100);
  if (
    bytes.length !== 100 ||
    !bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))
  )
    fail("SQLITE_HEADER_INVALID");
  const uint32 = (offset) => bytes.readUInt32BE(offset);
  let pageSize = bytes.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  return {
    sha256: sha256(bytes),
    pageSize,
    writeVersion: bytes[18],
    readVersion: bytes[19],
    changeCounter: uint32(24),
    databasePages: uint32(28),
    freelistTrunk: uint32(32),
    freelistPages: uint32(36),
    schemaCookie: uint32(40),
    schemaFormat: uint32(44),
    textEncoding: uint32(56),
    userVersion: uint32(60),
    applicationId: uint32(68),
    versionValidFor: uint32(92),
    sqliteVersion: uint32(96),
  };
}
function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}
function tableCounts(database, sqliteBinary) {
  const tables = JSON.parse(
    runSqlite(
      database,
      "SELECT name FROM sqlite_schema WHERE type = char(116,97,98,108,101) ORDER BY name",
      sqliteBinary,
      true,
    ),
  );
  if (!Array.isArray(tables)) fail("SQLITE_OUTPUT_INVALID");
  return tables.map(({ name }) => {
    if (typeof name !== "string") fail("SQLITE_OUTPUT_INVALID");
    const row = parseSingleJson(
      runSqlite(
        database,
        "SELECT count(*) AS count FROM " + quoteIdentifier(name),
        sqliteBinary,
        true,
      ),
    );
    if (!Number.isSafeInteger(row.count) || row.count < 0)
      fail("SQLITE_OUTPUT_INVALID");
    return { name, count: row.count };
  });
}

export function databaseSnapshot(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const databaseStatBefore = safeFile(settings.database);
  const sidecars = readdirSync(path.dirname(settings.database))
    .filter((name) => SIDECARS.includes(name))
    .sort();
  if (sidecars.length !== 0) fail("SQLITE_SIDECAR_PRESENT");
  const pragma = parseSingleJson(
    runSqlite(
      settings.database,
      `PRAGMA query_only=ON;
    SELECT (SELECT query_only FROM pragma_query_only) AS queryOnly,
      (SELECT journal_mode FROM pragma_journal_mode) AS journalMode,
      (SELECT page_size FROM pragma_page_size) AS pageSize,
      (SELECT page_count FROM pragma_page_count) AS pageCount,
      (SELECT freelist_count FROM pragma_freelist_count) AS freelistCount,
      (SELECT schema_version FROM pragma_schema_version) AS schemaVersion,
      (SELECT user_version FROM pragma_user_version) AS userVersion,
      (SELECT application_id FROM pragma_application_id) AS applicationId,
      (SELECT auto_vacuum FROM pragma_auto_vacuum) AS autoVacuum,
      (SELECT encoding FROM pragma_encoding) AS encoding,
      (SELECT count(*) FROM pragma_foreign_key_check) AS foreignKeyViolations,
      (SELECT group_concat(integrity_check, char(10)) FROM pragma_integrity_check) AS integrity;`,
      settings.sqliteBinary,
      true,
    ),
  );
  if (pragma.queryOnly !== 1 || pragma.integrity !== "ok")
    fail("SQLITE_INTEGRITY_FAILED");
  const schemaRows = JSON.parse(
    runSqlite(
      settings.database,
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name, tbl_name",
      settings.sqliteBinary,
      true,
    ),
  );
  const dataOnlyDump = runSqlite(
    settings.database,
    ".dump --data-only",
    settings.sqliteBinary,
  );
  const fullDump = runSqlite(settings.database, ".dump", settings.sqliteBinary);
  const fileBytes = readFileSync(settings.database);
  const header = databaseHeader(settings.database);
  const databaseStatAfter = safeFile(settings.database);
  const sidecarsAfter = readdirSync(path.dirname(settings.database))
    .filter((name) => SIDECARS.includes(name))
    .sort();
  if (
    !sameFileState(databaseStatBefore, databaseStatAfter) ||
    !canonicalBytes(sidecars).equals(canonicalBytes(sidecarsAfter))
  )
    fail("DATABASE_CHANGED_DURING_READ");
  return {
    contract: CONTRACT,
    version: VERSION,
    database: {
      size: Number(databaseStatAfter.size),
      sha256: sha256(fileBytes),
    },
    header,
    pragma,
    schema: {
      objectCount: schemaRows.length,
      sha256: sha256(canonicalBytes(schemaRows)),
    },
    logicalRows: {
      tableCounts: tableCounts(settings.database, settings.sqliteBinary),
      sha256: sha256(dataOnlyDump),
    },
    logicalDumpSha256: sha256(fullDump),
    sidecars,
  };
}
function exactSnapshot(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}
export function captureCompatibilityManifest(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  if (existsSync(settings.postManifest) || existsSync(settings.receipt))
    fail("EVIDENCE_EXISTS");
  const snapshot = databaseSnapshot(settings);
  createPrivateFile(settings.preManifest, {
    state: "pre-v749",
    capturedAt: new Date().toISOString(),
    snapshot,
  });
  return snapshot;
}
export function compareCompatibilityManifest(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  if (existsSync(settings.postManifest) || existsSync(settings.receipt))
    fail("EVIDENCE_EXISTS");
  const pre = readPrivateFile(settings.preManifest);
  if (
    pre?.state !== "pre-v749" ||
    pre?.snapshot?.contract !== CONTRACT ||
    pre?.snapshot?.version !== VERSION
  )
    fail("INVALID_EVIDENCE");
  const snapshot = databaseSnapshot(settings);
  createPrivateFile(settings.postManifest, {
    state: "post-v749",
    capturedAt: new Date().toISOString(),
    snapshot,
  });
  if (!exactSnapshot(pre.snapshot, snapshot)) fail("DATABASE_MUTATED");
  createPrivateFile(settings.receipt, {
    state: "consumed",
    contract: CONTRACT,
    version: VERSION,
    consumedAt: new Date().toISOString(),
    preManifestSha256: sha256(readFileSync(settings.preManifest)),
    postManifestSha256: sha256(readFileSync(settings.postManifest)),
    databaseSha256: snapshot.database.sha256,
  });
  return snapshot;
}
function formatSuccess(mode, snapshot) {
  return (
    "v749-compatibility " +
    mode +
    " ok database=" +
    snapshot.database.sha256.slice(0, 12) +
    " rows=" +
    snapshot.logicalRows.sha256.slice(0, 12) +
    " schema=" +
    snapshot.schema.sha256.slice(0, 12) +
    " header=" +
    snapshot.header.sha256.slice(0, 12)
  );
}
const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    if (
      process.argv.length !== 3 ||
      !["capture", "compare"].includes(process.argv[2])
    )
      fail("INVALID_ARGUMENTS");
    const mode = process.argv[2];
    const snapshot =
      mode === "capture"
        ? captureCompatibilityManifest()
        : compareCompatibilityManifest();
    console.log(formatSuccess(mode, snapshot));
  } catch (error) {
    const code =
      error instanceof CompatibilityProofError ? error.code : "INTERNAL_ERROR";
    console.error("v749-compatibility failed (" + code + ")");
    process.exitCode = 1;
  }
}
