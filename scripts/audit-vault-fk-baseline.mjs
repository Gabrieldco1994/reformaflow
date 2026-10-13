#!/usr/bin/env node
/**
 * Offline, read-only evidence for the deliberately retained #722 FK baseline.
 *
 * The SQLite CLI is started once with `-readonly`; all reads happen in one
 * transaction on that connection. Operators cannot provide statements,
 * predicates, table names, tenant selectors, API targets, or a write mode.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const MANIFEST_VERSION = 1;
const AUTHORIZATION_VERSION = 1;
const RECEIPT_VERSION = 1;
const CONTRACT = "vault-fk-baseline-32-one-window";
const AUTHORIZATION_PURPOSE = "vault-fk-baseline-32-activation";
const EXPECTED_COUNTS = Object.freeze({
  activeRoomsToProjects: 28,
  softDeletedCashFlowEntriesToExpenses: 4,
  total: 32,
});
const TARGETS = Object.freeze({
  rooms: Object.freeze({
    parentTable: "projects",
    childColumn: "project_id",
    parentColumn: "id",
    lifecycle: "active",
  }),
  cash_flow_entries: Object.freeze({
    parentTable: "expenses",
    childColumn: "expense_id",
    parentColumn: "id",
    lifecycle: "soft-deleted",
  }),
});
const OPTIONS = Object.freeze([
  "database",
  "mount-root",
  "manifest",
  "authorization",
  "authorization-sha256",
  "release-sha",
  "release-id",
  "image-digest",
  "auditor-sha256",
  "window-id",
  "window-start",
  "window-end",
]);
const MAX_WINDOW_MILLISECONDS = 4 * 60 * 60 * 1000;
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;
const PUBLIC_HASH_LENGTH = 12;
const SQLITE_DEADLINE_MILLISECONDS = 30_000;
const SQLITE_BINARY =
  process.platform === "linux" ? "/usr/bin/sqlite3" : "sqlite3";
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

class AuditError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new AuditError(code);
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function parseArguments(argv) {
  if (
    argv.length !== 1 + OPTIONS.length * 2 ||
    !["capture", "compare"].includes(argv[0])
  ) {
    fail("INVALID_ARGUMENTS");
  }
  const parsed = { mode: argv[0] };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (
      typeof token !== "string" ||
      !token.startsWith("--") ||
      !OPTIONS.includes(token.slice(2)) ||
      seen.has(token) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      fail("INVALID_ARGUMENTS");
    }
    seen.add(token);
    parsed[token.slice(2)] = value;
  }
  if (seen.size !== OPTIONS.length) fail("INVALID_ARGUMENTS");
  return parsed;
}

function parseTimestamp(value) {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail("INVALID_WINDOW");
  }
  return milliseconds;
}

function metadataFromOptions(options, now = Date.now()) {
  if (!RELEASE_SHA.test(options["release-sha"])) fail("INVALID_RELEASE");
  if (!IMAGE_DIGEST.test(options["image-digest"])) fail("INVALID_IMAGE");
  if (
    !SHA256.test(options["auditor-sha256"]) ||
    !SHA256.test(options["authorization-sha256"])
  ) {
    fail("INVALID_ARTIFACT_HASH");
  }
  if (
    !SAFE_REFERENCE.test(options["release-id"]) ||
    !SAFE_REFERENCE.test(options["window-id"])
  ) {
    fail("INVALID_AUTHORIZATION");
  }
  const startsAt = parseTimestamp(options["window-start"]);
  const expiresAt = parseTimestamp(options["window-end"]);
  if (
    expiresAt <= startsAt ||
    expiresAt - startsAt > MAX_WINDOW_MILLISECONDS ||
    now < startsAt ||
    now >= expiresAt
  ) {
    fail("WINDOW_NOT_ACTIVE");
  }
  return {
    releaseSha: options["release-sha"],
    releaseId: options["release-id"],
    imageDigest: options["image-digest"],
    auditorSha256: options["auditor-sha256"],
    authorizationSha256: options["authorization-sha256"],
    window: {
      id: options["window-id"],
      startsAt: options["window-start"],
      expiresAt: options["window-end"],
    },
  };
}

function assertAbsoluteNormalized(target) {
  if (
    typeof target !== "string" ||
    !path.isAbsolute(target) ||
    path.normalize(target) !== target
  ) {
    fail("UNSAFE_PATH");
  }
}

function assertNoSymlinkComponents(target, includeLeaf) {
  assertAbsoluteNormalized(target);
  const parsed = path.parse(target);
  const components = target
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  const limit = includeLeaf ? components.length : components.length - 1;
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch {
      fail("UNSAFE_PATH");
    }
    if (stat.isSymbolicLink()) fail("UNSAFE_PATH");
    if (index < limit - 1 && !stat.isDirectory()) fail("UNSAFE_PATH");
  }
}

function secureRegularStat(target, requiredMode = null) {
  assertNoSymlinkComponents(target, true);
  let stat;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch {
    fail("UNSAFE_PATH");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (requiredMode !== null && Number(stat.mode & 0o777n) !== requiredMode)
  ) {
    fail("UNSAFE_PATH");
  }
  return stat;
}

function secureDirectoryStat(target) {
  assertNoSymlinkComponents(target, true);
  let stat;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch {
    fail("UNSAFE_MOUNT");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_MOUNT");
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

function assertAbsent(target) {
  assertNoSymlinkComponents(target, false);
  try {
    lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("UNSAFE_PATH");
  }
  fail("WINDOW_REUSED");
}

function integer(value, code = "UNEXPECTED_SCHEMA") {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value)) fail(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(code);
  return parsed;
}

function quoteIdentifier(identifier) {
  if (!SAFE_IDENTIFIER.test(identifier)) fail("UNEXPECTED_SCHEMA");
  return `"${identifier}"`;
}

class ReadonlySqlite {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.sequence = 0;
    this.pending = null;
    this.stdout = "";
    this.stderrBytes = 0;
    this.closed = false;
  }

  async start() {
    this.child = spawn(
      SQLITE_BINARY,
      ["-batch", "-readonly", this.databasePath],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.deadline = setTimeout(() => {
      this.child.kill("SIGKILL");
    }, SQLITE_DEADLINE_MILLISECONDS);
    this.child.once("error", () => {
      if (this.pending) {
        this.pending.reject(new AuditError("DATABASE_OPEN_FAILED"));
        this.pending = null;
      }
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 64 * 1024) this.child.kill("SIGKILL");
    });
    this.exit = new Promise((resolve) => {
      this.child.once("close", (code) => {
        clearTimeout(this.deadline);
        this.closed = true;
        if (this.pending) {
          this.pending.reject(new AuditError("DATABASE_READ_FAILED"));
          this.pending = null;
        }
        resolve(code);
      });
    });
    this.child.stdin.write(".bail on\n.timeout 0\n.headers on\n.mode json\n");
    await this.request("PRAGMA query_only = ON");
    const queryOnly = await this.request(
      "SELECT CAST(query_only AS TEXT) AS value FROM pragma_query_only",
    );
    if (
      queryOnly.length !== 1 ||
      !hasExactKeys(queryOnly[0], ["value"]) ||
      queryOnly[0].value !== "1"
    ) {
      fail("QUERY_ONLY_NOT_ENFORCED");
    }
    const databaseList = await this.request(
      "SELECT file FROM pragma_database_list WHERE name = 'main'",
    );
    if (
      databaseList.length !== 1 ||
      !hasExactKeys(databaseList[0], ["file"]) ||
      databaseList[0].file !== this.databasePath
    ) {
      fail("DATABASE_PATH_MISMATCH");
    }
  }

  onStdout(chunk) {
    this.stdout += chunk;
    if (!this.pending) return;
    const marker = `${this.pending.marker}\n`;
    const markerIndex = this.stdout.indexOf(marker);
    if (markerIndex < 0) return;
    const response = this.stdout.slice(0, markerIndex).trim();
    this.stdout = this.stdout.slice(markerIndex + marker.length);
    const { resolve, reject } = this.pending;
    this.pending = null;
    if (this.stderrBytes > 0) {
      reject(new AuditError("DATABASE_READ_FAILED"));
      return;
    }
    if (response.length === 0) {
      resolve([]);
      return;
    }
    try {
      const rows = JSON.parse(response);
      if (!Array.isArray(rows)) fail("DATABASE_READ_FAILED");
      resolve(rows);
    } catch {
      reject(new AuditError("DATABASE_READ_FAILED"));
    }
  }

  request(statement) {
    if (this.pending || this.closed || !this.child?.stdin.writable) {
      return Promise.reject(new AuditError("DATABASE_READ_FAILED"));
    }
    const marker = `__RF_AUDIT_${process.pid}_${this.sequence}_${randomBytes(8).toString("hex")}__`;
    this.sequence += 1;
    return new Promise((resolve, reject) => {
      this.pending = { marker, resolve, reject };
      this.child.stdin.write(`${statement};\n.print ${marker}\n`, (error) => {
        if (error && this.pending?.marker === marker) {
          this.pending = null;
          reject(new AuditError("DATABASE_READ_FAILED"));
        }
      });
    });
  }

  async close() {
    if (!this.closed && this.child?.stdin.writable) {
      this.child.stdin.end(".exit\n");
    }
    await this.exit;
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
        if (stat.dev === expected.dev && stat.ino === expected.ino)
          matches += 1;
      } catch {
        // Descriptor churn is checked by requiring exactly one stable match.
      }
    }
  } catch {
    fail("DESCRIPTOR_PROOF_FAILED");
  }
  if (matches !== 1) fail("DESCRIPTOR_PROOF_FAILED");
}

async function tableContract(database, table) {
  const columns = await database.request(
    `SELECT CAST(cid AS TEXT) AS cid,
            name,
            type,
            CAST("notnull" AS TEXT) AS not_null,
            dflt_value AS default_value,
            CAST(pk AS TEXT) AS primary_key
       FROM pragma_table_info('${table}')
      ORDER BY cid`,
  );
  if (columns.length === 0) fail("UNEXPECTED_SCHEMA");
  const names = new Set();
  const normalizedColumns = columns.map((column) => {
    if (
      !hasExactKeys(column, [
        "cid",
        "name",
        "type",
        "not_null",
        "default_value",
        "primary_key",
      ]) ||
      !SAFE_IDENTIFIER.test(column.name) ||
      names.has(column.name) ||
      typeof column.type !== "string" ||
      (column.default_value !== null &&
        typeof column.default_value !== "string")
    ) {
      fail("UNEXPECTED_SCHEMA");
    }
    names.add(column.name);
    return {
      cid: integer(column.cid),
      name: column.name,
      declaredType: column.type,
      notNull: integer(column.not_null),
      defaultValue: column.default_value,
      primaryKey: integer(column.primary_key),
    };
  });
  const required =
    table === "rooms"
      ? ["id", "project_id", "deleted_at"]
      : ["id", "expense_id", "deleted_at"];
  if (required.some((name) => !names.has(name))) fail("UNEXPECTED_SCHEMA");

  const foreignKeys = await database.request(
    `SELECT CAST(id AS TEXT) AS id,
            CAST(seq AS TEXT) AS sequence,
            "table" AS parent_table,
            "from" AS child_column,
            "to" AS parent_column,
            on_update,
            on_delete,
            match
       FROM pragma_foreign_key_list('${table}')
      ORDER BY id, seq`,
  );
  const normalizedForeignKeys = foreignKeys.map((foreignKey) => {
    if (
      !hasExactKeys(foreignKey, [
        "id",
        "sequence",
        "parent_table",
        "child_column",
        "parent_column",
        "on_update",
        "on_delete",
        "match",
      ]) ||
      !SAFE_IDENTIFIER.test(foreignKey.parent_table) ||
      !SAFE_IDENTIFIER.test(foreignKey.child_column) ||
      !SAFE_IDENTIFIER.test(foreignKey.parent_column) ||
      !["on_update", "on_delete", "match"].every(
        (field) => typeof foreignKey[field] === "string",
      )
    ) {
      fail("UNEXPECTED_SCHEMA");
    }
    return {
      id: integer(foreignKey.id),
      sequence: integer(foreignKey.sequence),
      parentTable: foreignKey.parent_table,
      childColumn: foreignKey.child_column,
      parentColumn: foreignKey.parent_column,
      onUpdate: foreignKey.on_update,
      onDelete: foreignKey.on_delete,
      match: foreignKey.match,
    };
  });
  return {
    name: table,
    columns: normalizedColumns,
    foreignKeys: normalizedForeignKeys,
  };
}

function typedScalar(type, bytesHex) {
  if (
    !["null", "integer", "real", "text", "blob"].includes(type) ||
    (type === "null" && bytesHex !== null) ||
    (type !== "null" &&
      (typeof bytesHex !== "string" || !/^(?:[0-9A-F]{2})*$/.test(bytesHex)))
  ) {
    fail("INVALID_STORAGE_VALUE");
  }
  return { storageType: type, bytesHex };
}

async function typedRow(database, table, tableSchema, rowId) {
  if (!/^[1-9][0-9]*$/.test(rowId)) fail("UNEXPECTED_ROW_ID");
  const expressions = tableSchema.columns.flatMap((column, index) => {
    const name = quoteIdentifier(column.name);
    return [
      `typeof(${name}) AS "type_${index}"`,
      `CASE typeof(${name})
         WHEN 'null' THEN NULL
         WHEN 'real' THEN hex(CAST(printf('%!.26g', ${name}) AS BLOB))
         ELSE hex(CAST(${name} AS BLOB))
       END AS "bytes_${index}"`,
    ];
  });
  const rows = await database.request(
    `SELECT ${expressions.join(", ")}
       FROM ${quoteIdentifier(table)}
      WHERE rowid = CAST('${rowId}' AS INTEGER)`,
  );
  if (rows.length !== 1) fail("VIOLATION_ROW_MISSING");
  return {
    columns: tableSchema.columns.map((column, index) => ({
      name: column.name,
      ...typedScalar(rows[0][`type_${index}`], rows[0][`bytes_${index}`]),
    })),
  };
}

function columnValue(row, name) {
  const column = row.columns.find((candidate) => candidate.name === name);
  if (!column) fail("UNEXPECTED_SCHEMA");
  return column;
}

function compareViolations(left, right) {
  return (
    left.childTable.localeCompare(right.childTable) ||
    left.rowId.bytesHex.localeCompare(right.rowId.bytesHex) ||
    left.foreignKeyId - right.foreignKeyId
  );
}

async function snapshot(database) {
  const violationRows = await database.request(
    `SELECT "table" AS child_table,
            CAST(rowid AS TEXT) AS row_id,
            parent AS parent_table,
            CAST(fkid AS TEXT) AS foreign_key_id
       FROM pragma_foreign_key_check`,
  );
  if (violationRows.length !== EXPECTED_COUNTS.total) {
    fail("UNEXPECTED_VIOLATION_COUNT");
  }

  const tables = [];
  const tableByName = new Map();
  for (const table of Object.keys(TARGETS).sort()) {
    const contract = await tableContract(database, table);
    tables.push(contract);
    tableByName.set(table, contract);
  }

  const violations = [];
  let activeRoomsToProjects = 0;
  let softDeletedCashFlowEntriesToExpenses = 0;
  for (const violation of violationRows) {
    if (
      !hasExactKeys(violation, [
        "child_table",
        "row_id",
        "parent_table",
        "foreign_key_id",
      ])
    ) {
      fail("UNEXPECTED_VIOLATION_TYPE");
    }
    const target = TARGETS[violation.child_table];
    if (
      !target ||
      violation.parent_table !== target.parentTable ||
      typeof violation.row_id !== "string"
    ) {
      fail("UNEXPECTED_VIOLATION_TYPE");
    }
    const foreignKeyId = integer(
      violation.foreign_key_id,
      "UNEXPECTED_VIOLATION_TYPE",
    );
    const table = tableByName.get(violation.child_table);
    const matchingKeys = table.foreignKeys.filter(
      (foreignKey) =>
        foreignKey.id === foreignKeyId &&
        foreignKey.sequence === 0 &&
        foreignKey.childColumn === target.childColumn &&
        foreignKey.parentTable === target.parentTable &&
        foreignKey.parentColumn === target.parentColumn,
    );
    if (matchingKeys.length !== 1) fail("UNEXPECTED_FOREIGN_KEY");
    const row = await typedRow(
      database,
      violation.child_table,
      table,
      violation.row_id,
    );
    const deletedAt = columnValue(row, "deleted_at");
    if (
      (target.lifecycle === "active" && deletedAt.storageType !== "null") ||
      (target.lifecycle === "soft-deleted" && deletedAt.storageType === "null")
    ) {
      fail("UNEXPECTED_LIFECYCLE");
    }
    if (violation.child_table === "rooms") activeRoomsToProjects += 1;
    else softDeletedCashFlowEntriesToExpenses += 1;
    violations.push({
      childTable: violation.child_table,
      rowId: {
        storageType: "integer",
        bytesHex: Buffer.from(violation.row_id, "utf8")
          .toString("hex")
          .toUpperCase(),
      },
      parentTable: violation.parent_table,
      foreignKeyId,
      row,
    });
  }
  violations.sort(compareViolations);
  const counts = {
    activeRoomsToProjects,
    softDeletedCashFlowEntriesToExpenses,
    total: violations.length,
  };
  if (!sameBytes(canonicalBytes(counts), canonicalBytes(EXPECTED_COUNTS))) {
    fail("UNEXPECTED_VIOLATION_COUNT");
  }
  return { counts, tables, violations };
}

async function readDatabaseSnapshot(databasePath, mountRoot) {
  if (path.dirname(databasePath) !== mountRoot) fail("UNSAFE_MOUNT");
  const mount = secureDirectoryStat(mountRoot);
  const before = secureRegularStat(databasePath);
  if (before.dev !== mount.dev) fail("UNSAFE_MOUNT");

  const database = new ReadonlySqlite(databasePath);
  let inTransaction = false;
  try {
    await database.start();
    const versionBefore = await database.request(
      "SELECT CAST(data_version AS TEXT) AS value FROM pragma_data_version",
    );
    await database.request("BEGIN");
    inTransaction = true;
    assertLinuxDescriptorIdentity(database.child.pid, before);
    const result = await snapshot(database);
    assertLinuxDescriptorIdentity(database.child.pid, before);
    await database.request("ROLLBACK");
    inTransaction = false;
    const versionAfter = await database.request(
      "SELECT CAST(data_version AS TEXT) AS value FROM pragma_data_version",
    );
    const changes = await database.request(
      "SELECT CAST(total_changes() AS TEXT) AS value",
    );
    if (
      versionBefore.length !== 1 ||
      versionAfter.length !== 1 ||
      !hasExactKeys(versionBefore[0], ["value"]) ||
      !hasExactKeys(versionAfter[0], ["value"]) ||
      versionBefore[0].value !== versionAfter[0].value ||
      changes.length !== 1 ||
      !hasExactKeys(changes[0], ["value"]) ||
      changes[0].value !== "0"
    ) {
      fail("DATABASE_CHANGED_DURING_READ");
    }
    await database.close();
    const after = secureRegularStat(databasePath);
    if (!sameIdentity(before, after)) fail("DATABASE_REPLACED");
    return result;
  } finally {
    if (inTransaction && !database.closed) {
      try {
        await database.request("ROLLBACK");
      } catch {
        // Fail closed using the original bounded diagnostic.
      }
    }
    if (!database.closed) {
      try {
        await database.close();
      } catch {
        // Fail closed using the original bounded diagnostic.
      }
    }
  }
}

async function openPrivateFile(filePath) {
  assertNoSymlinkComponents(filePath, true);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("PRIVATE_FILE_OPEN_FAILED");
  }
  const stat = await handle.stat({ bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    Number(stat.mode & 0o777n) !== 0o600 ||
    stat.size > BigInt(MAX_PRIVATE_FILE_BYTES)
  ) {
    await handle.close();
    fail("UNSAFE_PRIVATE_FILE");
  }
  const pathStat = secureRegularStat(filePath, 0o600);
  if (!sameIdentity(stat, pathStat)) {
    await handle.close();
    fail("PRIVATE_FILE_REPLACED");
  }
  const bytes = await handle.readFile();
  return { bytes, handle, stat };
}

async function verifyPrivateFile(filePath, opened) {
  const after = await opened.handle.stat({ bigint: true });
  const pathStat = secureRegularStat(filePath, 0o600);
  if (!sameIdentity(opened.stat, after) || !sameIdentity(after, pathStat)) {
    fail("PRIVATE_FILE_REPLACED");
  }
  const verification = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const bytes = await verification.readFile();
    if (!sameBytes(bytes, opened.bytes)) fail("PRIVATE_FILE_REPLACED");
  } finally {
    await verification.close();
  }
}

async function createPrivateFile(filePath, value) {
  assertNoSymlinkComponents(filePath, false);
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    fail("PRIVATE_FILE_EXCLUSIVE_CREATE_FAILED");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      Number(opened.mode & 0o777n) !== 0o600
    ) {
      fail("UNSAFE_PRIVATE_FILE");
    }
    const bytes = canonicalBytes(value);
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const pathStat = secureRegularStat(filePath, 0o600);
    if (!sameIdentity(after, pathStat)) fail("PRIVATE_FILE_REPLACED");
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseCanonicalJson(bytes, code) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code);
  }
  if (!sameBytes(bytes, canonicalBytes(value))) fail(code);
  return value;
}

function validateAuthorization(authorization, metadata, bytes) {
  if (
    !hasExactKeys(authorization, [
      "version",
      "purpose",
      "authorizationId",
      "releaseSha",
      "releaseId",
      "imageDigest",
      "auditorSha256",
      "window",
      "nonce",
    ]) ||
    authorization.version !== AUTHORIZATION_VERSION ||
    authorization.purpose !== AUTHORIZATION_PURPOSE ||
    !SAFE_REFERENCE.test(authorization.authorizationId) ||
    !/^[0-9a-f]{64}$/.test(authorization.nonce) ||
    !hasExactKeys(authorization.window, ["id", "startsAt", "expiresAt"]) ||
    sha256(bytes) !== metadata.authorizationSha256 ||
    authorization.releaseSha !== metadata.releaseSha ||
    authorization.releaseId !== metadata.releaseId ||
    authorization.imageDigest !== metadata.imageDigest ||
    authorization.auditorSha256 !== metadata.auditorSha256 ||
    !sameBytes(
      canonicalBytes(authorization.window),
      canonicalBytes(metadata.window),
    )
  ) {
    fail("AUTHORIZATION_MISMATCH");
  }
}

function assertAuditorArtifact(expectedHash) {
  const auditorPath = fileURLToPath(import.meta.url);
  secureRegularStat(auditorPath);
  if (sha256(readFileSync(auditorPath)) !== expectedHash) {
    fail("AUDITOR_ARTIFACT_MISMATCH");
  }
}

function manifestPayload(metadata, capturedAt, databaseSnapshot) {
  return {
    version: MANIFEST_VERSION,
    contract: CONTRACT,
    state: "captured",
    releaseSha: metadata.releaseSha,
    releaseId: metadata.releaseId,
    imageDigest: metadata.imageDigest,
    auditorSha256: metadata.auditorSha256,
    authorizationSha256: metadata.authorizationSha256,
    window: metadata.window,
    capturedAt,
    ...databaseSnapshot,
  };
}

function validateManifest(manifest, metadata) {
  if (
    !hasExactKeys(manifest, [
      "version",
      "contract",
      "state",
      "releaseSha",
      "releaseId",
      "imageDigest",
      "auditorSha256",
      "authorizationSha256",
      "window",
      "capturedAt",
      "counts",
      "tables",
      "violations",
      "integrity",
    ]) ||
    manifest.version !== MANIFEST_VERSION ||
    manifest.contract !== CONTRACT ||
    manifest.state !== "captured" ||
    !hasExactKeys(manifest.integrity, ["algorithm", "digest"]) ||
    manifest.integrity.algorithm !== "sha256" ||
    !SHA256.test(manifest.integrity.digest) ||
    !Array.isArray(manifest.tables) ||
    !Array.isArray(manifest.violations)
  ) {
    fail("INVALID_MANIFEST");
  }
  const { integrity, ...payload } = manifest;
  if (sha256(canonicalBytes(payload)) !== integrity.digest) {
    fail("MANIFEST_TAMPERED");
  }
  const capturedAt = parseTimestamp(manifest.capturedAt);
  if (
    capturedAt < parseTimestamp(metadata.window.startsAt) ||
    capturedAt >= parseTimestamp(metadata.window.expiresAt) ||
    Date.now() < capturedAt
  ) {
    fail("CLOCK_ROLLBACK");
  }
  if (
    manifest.releaseSha !== metadata.releaseSha ||
    manifest.releaseId !== metadata.releaseId ||
    manifest.imageDigest !== metadata.imageDigest ||
    manifest.auditorSha256 !== metadata.auditorSha256 ||
    manifest.authorizationSha256 !== metadata.authorizationSha256 ||
    !sameBytes(canonicalBytes(manifest.window), canonicalBytes(metadata.window))
  ) {
    fail("METADATA_MISMATCH");
  }
  const sorted = [...manifest.violations].sort(compareViolations);
  if (
    manifest.violations.some((violation, index) => violation !== sorted[index])
  ) {
    fail("INVALID_MANIFEST_ORDER");
  }
}

function exactSnapshot(manifest, databaseSnapshot) {
  return sameBytes(
    canonicalBytes({
      counts: manifest.counts,
      tables: manifest.tables,
      violations: manifest.violations,
    }),
    canonicalBytes(databaseSnapshot),
  );
}

function consumedReceipt(manifestBytes, metadata, databaseSnapshot) {
  return {
    version: RECEIPT_VERSION,
    contract: CONTRACT,
    state: "consumed",
    manifestSha256: sha256(manifestBytes),
    authorizationSha256: metadata.authorizationSha256,
    comparisonSha256: sha256(canonicalBytes(databaseSnapshot)),
    consumedAt: new Date().toISOString(),
  };
}

async function withAuthorization(options, metadata, operation) {
  const opened = await openPrivateFile(options.authorization);
  try {
    const authorization = parseCanonicalJson(
      opened.bytes,
      "INVALID_AUTHORIZATION_FILE",
    );
    validateAuthorization(authorization, metadata, opened.bytes);
    const result = await operation();
    await verifyPrivateFile(options.authorization, opened);
    return result;
  } finally {
    await opened.handle.close();
  }
}

async function capture(options, metadata, receiptPath) {
  assertAbsent(options.manifest);
  assertAbsent(receiptPath);
  return withAuthorization(options, metadata, async () => {
    const databaseSnapshot = await readDatabaseSnapshot(
      options.database,
      options["mount-root"],
    );
    const payload = manifestPayload(
      metadata,
      new Date().toISOString(),
      databaseSnapshot,
    );
    const manifest = {
      ...payload,
      integrity: {
        algorithm: "sha256",
        digest: sha256(canonicalBytes(payload)),
      },
    };
    const bytes = await createPrivateFile(options.manifest, manifest);
    return sha256(bytes);
  });
}

async function compare(options, metadata, receiptPath) {
  assertAbsent(receiptPath);
  return withAuthorization(options, metadata, async () => {
    const opened = await openPrivateFile(options.manifest);
    try {
      const manifest = parseCanonicalJson(opened.bytes, "INVALID_MANIFEST");
      validateManifest(manifest, metadata);
      const databaseSnapshot = await readDatabaseSnapshot(
        options.database,
        options["mount-root"],
      );
      if (!exactSnapshot(manifest, databaseSnapshot)) fail("BASELINE_DRIFT");
      await verifyPrivateFile(options.manifest, opened);
      await createPrivateFile(
        receiptPath,
        consumedReceipt(opened.bytes, metadata, databaseSnapshot),
      );
      return sha256(opened.bytes);
    } finally {
      await opened.handle.close();
    }
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const receiptPath = `${options.manifest}.consumed`;
  if (
    new Set([
      options.database,
      options.manifest,
      options.authorization,
      receiptPath,
    ]).size !== 4
  ) {
    fail("UNSAFE_PATH");
  }
  const metadata = metadataFromOptions(options);
  assertAuditorArtifact(metadata.auditorSha256);
  const digest =
    options.mode === "capture"
      ? await capture(options, metadata, receiptPath)
      : await compare(options, metadata, receiptPath);
  console.log(
    `vault-fk-baseline ${options.mode} ok rooms=28 cash_flow_entries=4 total=32 hash=${digest.slice(0, PUBLIC_HASH_LENGTH)}`,
  );
}

main().catch((error) => {
  const code = error instanceof AuditError ? error.code : "INTERNAL_ERROR";
  console.error(`vault-fk-baseline failed (${code})`);
  process.exitCode = 1;
});
