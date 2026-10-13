import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AUDITOR =
  process.env.VAULT_AUDITOR_UNDER_TEST ??
  join(ROOT, "scripts", "audit-vault-fk-baseline.mjs");
const RELEASE_SHA = "a".repeat(40);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const RELEASE_ID = "fly-release-vault-722";
const AUTHORIZATION_ID = "issue-722-po-approved";
const WINDOW_ID = "vault-activation-2026-10-13-a";
const EXPECTED_ROOMS = 28;
const EXPECTED_CASH_FLOW = 4;
const EXPECTED_TOTAL = EXPECTED_ROOMS + EXPECTED_CASH_FLOW;
const PRIVATE_MARKERS = [
  "private-room-01",
  "private-project-01",
  "private-cash-01",
  "private-expense-01",
];
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "rf-722-vault-baseline-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function sqlite(database, sql) {
  const result = spawnSync("sqlite3", [database], {
    encoding: "utf8",
    input: sql,
  });
  assert.equal(
    result.status,
    0,
    `fixture sqlite failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result.stdout;
}

function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createFixture(directory = temporaryDirectory()) {
  const database = join(directory, "fixture.db");
  const manifest = join(directory, "baseline.private.json");
  const authorization = join(directory, "authorization.private.json");
  const rooms = Array.from({ length: EXPECTED_ROOMS }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const project = `private-project-${ordinal}`;
    const note =
      index === 0
        ? "CAST(X'636166c3a90078' AS TEXT)"
        : sqlText(`room-note-${ordinal}`);
    const payload = index === 0 ? "X'00ff10'" : `X'${ordinal}aa'`;
    const amount = index === 0 ? "9223372036854775807" : String(1000 + index);
    const ratio = sqlText(`ratio-${ordinal}`);
    return `(
      ${sqlText(`private-room-${ordinal}`)},
      ${sqlText(project)},
      ${sqlText(`Private room ${ordinal}`)},
      ${amount},
      ${ratio},
      ${payload},
      ${note},
      NULL
    )`;
  }).join(",\n");
  const cashFlow = Array.from({ length: EXPECTED_CASH_FLOW }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    return `(
      ${sqlText(`private-cash-${ordinal}`)},
      ${sqlText(`private-expense-${ordinal}`)},
      ${10001 + index},
      ${sqlText(index % 2 === 0 ? "PAGO" : "PLANEJADO")},
      X'${ordinal}bb',
      '2026-10-12T00:00:00.000Z'
    )`;
  }).join(",\n");

  sqlite(
    database,
    `
      PRAGMA foreign_keys = OFF;
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE expenses (id TEXT PRIMARY KEY);
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        amount,
        ratio,
        payload,
        note,
        deleted_at TEXT
      );
      CREATE TABLE cash_flow_entries (
        id TEXT PRIMARY KEY,
        expense_id TEXT REFERENCES expenses(id),
        valor INTEGER,
        status TEXT,
        payload BLOB,
        deleted_at TEXT
      );
      INSERT INTO rooms
        (id, project_id, name, amount, ratio, payload, note, deleted_at)
      VALUES ${rooms};
      INSERT INTO cash_flow_entries
        (id, expense_id, valor, status, payload, deleted_at)
      VALUES ${cashFlow};
    `,
  );
  assert.equal(
    Number(
      sqlite(database, "PRAGMA foreign_key_check;").trim().split("\n").length,
    ),
    EXPECTED_TOTAL,
  );
  return { authorization, database, directory, manifest };
}

function activeWindow() {
  const now = Date.now();
  return {
    start: new Date(now - 60_000).toISOString(),
    end: new Date(now + 3_600_000).toISOString(),
  };
}

function auditorArgs(mode, fixture, overrides = {}) {
  const window = activeWindow();
  const auditorSha256 = createHash("sha256")
    .update(readFileSync(AUDITOR))
    .digest("hex");
  const values = {
    database: fixture.database,
    mountRoot: fixture.directory,
    manifest: fixture.manifest,
    authorization: fixture.authorization,
    releaseSha: RELEASE_SHA,
    releaseId: RELEASE_ID,
    imageDigest: IMAGE_DIGEST,
    auditorSha256,
    authorizationId: AUTHORIZATION_ID,
    windowId: WINDOW_ID,
    windowStart: window.start,
    windowEnd: window.end,
    ...overrides,
  };
  if (!existsSync(values.authorization)) {
    const authorization = {
      version: 1,
      purpose: "vault-fk-baseline-32-activation",
      authorizationId: values.authorizationId,
      releaseSha: values.releaseSha,
      releaseId: values.releaseId,
      imageDigest: values.imageDigest,
      auditorSha256: values.auditorSha256,
      window: {
        id: values.windowId,
        startsAt: values.windowStart,
        expiresAt: values.windowEnd,
      },
      nonce: "e".repeat(64),
    };
    writeFileSync(values.authorization, canonicalBytes(authorization), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const authorizationSha256 =
    values.authorizationSha256 ??
    createHash("sha256")
      .update(readFileSync(values.authorization))
      .digest("hex");
  return [
    AUDITOR,
    mode,
    "--database",
    values.database,
    "--mount-root",
    values.mountRoot,
    "--manifest",
    values.manifest,
    "--authorization",
    values.authorization,
    "--authorization-sha256",
    authorizationSha256,
    "--release-sha",
    values.releaseSha,
    "--release-id",
    values.releaseId,
    "--image-digest",
    values.imageDigest,
    "--auditor-sha256",
    values.auditorSha256,
    "--window-id",
    values.windowId,
    "--window-start",
    values.windowStart,
    "--window-end",
    values.windowEnd,
  ];
}

function runAuditor(mode, fixture, overrides = {}) {
  return spawnSync(process.execPath, auditorArgs(mode, fixture, overrides), {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function requireSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

function requirePublicOutput(result, mode) {
  const allOutput = output(result);
  assert.match(
    result.stdout,
    new RegExp(
      `^vault-fk-baseline ${mode} ok rooms=28 cash_flow_entries=4 total=32 hash=[0-9a-f]{12}\\n$`,
    ),
  );
  assert.equal(result.stderr, "");
  for (const privateValue of PRIVATE_MARKERS) {
    assert.doesNotMatch(allOutput, new RegExp(privateValue));
  }
  assert.doesNotMatch(allOutput, /\/(?:private|var|tmp|data)\//);
  assert.doesNotMatch(allOutput, /[0-9a-f]{40,}/);
  assert.doesNotMatch(allOutput, /sha256:/);
  assert.doesNotMatch(allOutput, new RegExp(RELEASE_SHA));
  assert.doesNotMatch(allOutput, new RegExp(IMAGE_DIGEST));
  assert.doesNotMatch(allOutput, new RegExp(AUTHORIZATION_ID));
}

function capture(fixture) {
  const window = activeWindow();
  const metadata = {
    windowStart: window.start,
    windowEnd: window.end,
  };
  const result = runAuditor("capture", fixture, metadata);
  requireSuccess(result, "capture");
  requirePublicOutput(result, "capture");
  return metadata;
}

function compare(fixture, metadata) {
  const result = runAuditor("compare", fixture, metadata);
  requireSuccess(result, "compare");
  requirePublicOutput(result, "compare");
  return result;
}

function privateManifest(fixture) {
  return JSON.parse(readFileSync(fixture.manifest, "utf8"));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function rewriteManifest(fixture, mutate, { recomputeIntegrity = false } = {}) {
  const manifest = privateManifest(fixture);
  mutate(manifest);
  if (recomputeIntegrity) {
    const { integrity: _ignored, ...payload } = manifest;
    manifest.integrity.digest = createHash("sha256")
      .update(canonicalBytes(payload))
      .digest("hex");
  }
  writeFileSync(fixture.manifest, canonicalBytes(manifest), { mode: 0o600 });
}

function cloneFixture(source) {
  const directory = temporaryDirectory();
  const fixture = {
    authorization: join(directory, "authorization.private.json"),
    database: join(directory, "fixture.db"),
    directory,
    manifest: join(directory, "baseline.private.json"),
  };
  copyFileSync(source.database, fixture.database);
  copyFileSync(source.manifest, fixture.manifest);
  copyFileSync(source.authorization, fixture.authorization);
  chmodSync(fixture.manifest, 0o600);
  chmodSync(fixture.authorization, 0o600);
  return fixture;
}

function requireRejected(result, label) {
  assert.notEqual(
    result.status,
    0,
    `${label} unexpectedly passed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  const allOutput = output(result);
  assert.equal(result.stdout, "", `${label} wrote unexpected stdout`);
  assert.match(result.stderr, /^vault-fk-baseline failed \([A-Z0-9_]+\)\n$/);
  for (const privateValue of PRIVATE_MARKERS) {
    assert.doesNotMatch(allOutput, new RegExp(privateValue));
  }
  assert.doesNotMatch(allOutput, /\/(?:private|var|tmp|data)\//);
  assert.doesNotMatch(allOutput, /[0-9a-f]{40,}/);
}

test("capture records one exact canonical typed snapshot and compare preserves all 32 violations", () => {
  const fixture = createFixture();
  const metadata = capture(fixture);
  assert.equal(lstatSync(fixture.manifest).mode & 0o777, 0o600);
  assert.equal(lstatSync(fixture.manifest).isFile(), true);
  assert.equal(lstatSync(fixture.manifest).nlink, 1);

  const manifestBytes = readFileSync(fixture.manifest);
  assert.equal(manifestBytes.at(-1), 0x0a);
  const manifest = JSON.parse(manifestBytes);
  assert.deepEqual(manifest.counts, {
    activeRoomsToProjects: EXPECTED_ROOMS,
    softDeletedCashFlowEntriesToExpenses: EXPECTED_CASH_FLOW,
    total: EXPECTED_TOTAL,
  });
  assert.equal(manifest.violations.length, EXPECTED_TOTAL);
  assert.equal(manifest.releaseSha, RELEASE_SHA);
  assert.equal(manifest.releaseId, RELEASE_ID);
  assert.equal(manifest.imageDigest, IMAGE_DIGEST);
  assert.match(manifest.authorizationSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.state, "captured");
  assert.equal(manifest.window.id, WINDOW_ID);
  assert.equal(manifest.window.startsAt, metadata.windowStart);
  assert.equal(manifest.window.expiresAt, metadata.windowEnd);
  assert.deepEqual(manifest.tables, [
    {
      name: "cash_flow_entries",
      columns: [
        {
          cid: 0,
          name: "id",
          declaredType: "TEXT",
          notNull: 0,
          defaultValue: null,
          primaryKey: 1,
        },
        {
          cid: 1,
          name: "expense_id",
          declaredType: "TEXT",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 2,
          name: "valor",
          declaredType: "INTEGER",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 3,
          name: "status",
          declaredType: "TEXT",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 4,
          name: "payload",
          declaredType: "BLOB",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 5,
          name: "deleted_at",
          declaredType: "TEXT",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          childColumn: "expense_id",
          parentTable: "expenses",
          parentColumn: "id",
          onUpdate: "NO ACTION",
          onDelete: "NO ACTION",
          match: "NONE",
        },
      ],
    },
    {
      name: "rooms",
      columns: [
        {
          cid: 0,
          name: "id",
          declaredType: "TEXT",
          notNull: 0,
          defaultValue: null,
          primaryKey: 1,
        },
        {
          cid: 1,
          name: "project_id",
          declaredType: "TEXT",
          notNull: 1,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 2,
          name: "name",
          declaredType: "TEXT",
          notNull: 1,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 3,
          name: "amount",
          declaredType: "",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 4,
          name: "ratio",
          declaredType: "",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 5,
          name: "payload",
          declaredType: "",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 6,
          name: "note",
          declaredType: "",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
        {
          cid: 7,
          name: "deleted_at",
          declaredType: "TEXT",
          notNull: 0,
          defaultValue: null,
          primaryKey: 0,
        },
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          childColumn: "project_id",
          parentTable: "projects",
          parentColumn: "id",
          onUpdate: "NO ACTION",
          onDelete: "NO ACTION",
          match: "NONE",
        },
      ],
    },
  ]);

  const room = manifest.violations.find(
    (violation) =>
      violation.childTable === "rooms" &&
      violation.row.columns.some(
        (column) =>
          column.name === "id" &&
          Buffer.from(column.bytesHex, "hex").toString("utf8") ===
            "private-room-01",
      ),
  );
  const cashFlow = manifest.violations.find(
    (violation) =>
      violation.childTable === "cash_flow_entries" &&
      violation.row.columns.some(
        (column) =>
          column.name === "id" &&
          Buffer.from(column.bytesHex, "hex").toString("utf8") ===
            "private-cash-01",
      ),
  );
  const roomForeignKey = manifest.tables
    .find((table) => table.name === "rooms")
    .foreignKeys.find((foreignKey) => foreignKey.id === room.foreignKeyId);
  const cashFlowForeignKey = manifest.tables
    .find((table) => table.name === "cash_flow_entries")
    .foreignKeys.find((foreignKey) => foreignKey.id === cashFlow.foreignKeyId);
  assert.deepEqual(roomForeignKey, {
    id: 0,
    sequence: 0,
    childColumn: "project_id",
    parentTable: "projects",
    parentColumn: "id",
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
    match: "NONE",
  });
  assert.deepEqual(cashFlowForeignKey, {
    id: 0,
    sequence: 0,
    childColumn: "expense_id",
    parentTable: "expenses",
    parentColumn: "id",
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
    match: "NONE",
  });
  assert.deepEqual(room.row.columns, [
    {
      name: "id",
      storageType: "text",
      bytesHex: Buffer.from("private-room-01").toString("hex").toUpperCase(),
    },
    {
      name: "project_id",
      storageType: "text",
      bytesHex: Buffer.from("private-project-01").toString("hex").toUpperCase(),
    },
    {
      name: "name",
      storageType: "text",
      bytesHex: Buffer.from("Private room 01").toString("hex").toUpperCase(),
    },
    {
      name: "amount",
      storageType: "integer",
      bytesHex: Buffer.from("9223372036854775807")
        .toString("hex")
        .toUpperCase(),
    },
    {
      name: "ratio",
      storageType: "text",
      bytesHex: Buffer.from("ratio-01").toString("hex").toUpperCase(),
    },
    {
      name: "payload",
      storageType: "blob",
      bytesHex: "00FF10",
    },
    {
      name: "note",
      storageType: "text",
      bytesHex: "636166C3A90078",
    },
    {
      name: "deleted_at",
      storageType: "null",
      bytesHex: null,
    },
  ]);
  assert.deepEqual(cashFlow.row.columns, [
    {
      name: "id",
      storageType: "text",
      bytesHex: Buffer.from("private-cash-01").toString("hex").toUpperCase(),
    },
    {
      name: "expense_id",
      storageType: "text",
      bytesHex: Buffer.from("private-expense-01").toString("hex").toUpperCase(),
    },
    {
      name: "valor",
      storageType: "integer",
      bytesHex: Buffer.from("10001").toString("hex").toUpperCase(),
    },
    {
      name: "status",
      storageType: "text",
      bytesHex: Buffer.from("PAGO").toString("hex").toUpperCase(),
    },
    {
      name: "payload",
      storageType: "blob",
      bytesHex: "01BB",
    },
    {
      name: "deleted_at",
      storageType: "text",
      bytesHex: Buffer.from("2026-10-12T00:00:00.000Z")
        .toString("hex")
        .toUpperCase(),
    },
  ]);

  for (const violation of manifest.violations) {
    const schema = manifest.tables.find(
      (table) => table.name === violation.childTable,
    );
    assert.ok(schema, "affected table schema must be present");
    assert.deepEqual(
      violation.row.columns.map(({ name }) => name),
      schema.columns.map(({ name }) => name),
    );
    for (const column of violation.row.columns) {
      assert.match(column.storageType, /^(null|integer|real|text|blob)$/);
      if (column.storageType === "null") {
        assert.equal(column.bytesHex, null);
      } else {
        assert.match(column.bytesHex, /^(?:[0-9A-F]{2})*$/);
      }
    }
  }
  assert.ok(
    room.row.columns.some(
      (column) =>
        column.name === "payload" &&
        column.storageType === "blob" &&
        column.bytesHex === "00FF10",
    ),
  );
  assert.ok(
    room.row.columns.some(
      (column) =>
        column.name === "amount" &&
        column.storageType === "integer" &&
        Buffer.from(column.bytesHex, "hex").toString("utf8") ===
          "9223372036854775807",
    ),
  );
  assert.ok(
    room.row.columns.some(
      (column) => column.name === "ratio" && column.storageType === "text",
    ),
  );
  assert.ok(
    room.row.columns.some(
      (column) =>
        column.name === "deleted_at" &&
        column.storageType === "null" &&
        column.bytesHex === null,
    ),
  );

  compare(fixture, metadata);
  assert.equal(
    sqlite(fixture.database, "PRAGMA foreign_key_check;").trim().split("\n")
      .length,
    EXPECTED_TOTAL,
  );
});

test("compare checks every affected row column, storage type, and encoded bytes", () => {
  const source = createFixture();
  const metadata = capture(source);
  const mutations = [
    ["id", "'private-room-mutated'"],
    ["project_id", "'private-project-mutated'"],
    ["name", "'mutated name'"],
    ["amount", "'9223372036854775807'"],
    ["ratio", "0.2"],
    ["payload", "X'00ff11'"],
    ["note", "'mutated note'"],
  ];
  for (const [column, value] of mutations) {
    const fixture = cloneFixture(source);
    sqlite(
      fixture.database,
      `UPDATE rooms SET "${column}" = ${value} WHERE rowid = 1;`,
    );
    requireRejected(
      runAuditor("compare", fixture, metadata),
      `row drift in ${column}`,
    );
  }

  const deletedAt = cloneFixture(source);
  sqlite(
    deletedAt.database,
    "UPDATE rooms SET deleted_at = '2026-10-13' WHERE rowid = 1;",
  );
  requireRejected(
    runAuditor("compare", deletedAt, metadata),
    "room lifecycle drift",
  );

  const cashValue = cloneFixture(source);
  sqlite(
    cashValue.database,
    "UPDATE cash_flow_entries SET valor = valor + 1 WHERE rowid = 1;",
  );
  requireRejected(
    runAuditor("compare", cashValue, metadata),
    "cash flow row drift",
  );
});

test("capture and compare reject count/type mismatch plus added or removed violations", () => {
  const wrongRoomCount = createFixture();
  sqlite(wrongRoomCount.database, "DELETE FROM rooms WHERE rowid = 1;");
  requireRejected(runAuditor("capture", wrongRoomCount), "27 rooms");

  const wrongLifecycle = createFixture();
  sqlite(
    wrongLifecycle.database,
    "UPDATE cash_flow_entries SET deleted_at = NULL WHERE rowid = 1;",
  );
  requireRejected(runAuditor("capture", wrongLifecycle), "active cash flow");

  const otherViolation = createFixture();
  sqlite(
    otherViolation.database,
    `
      CREATE TABLE unexpected_child (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id)
      );
      INSERT INTO unexpected_child VALUES ('private-other', 'missing');
    `,
  );
  requireRejected(runAuditor("capture", otherViolation), "other violation");

  const source = createFixture();
  const metadata = capture(source);

  const removed = cloneFixture(source);
  sqlite(
    removed.database,
    "INSERT INTO projects VALUES ('private-project-01');",
  );
  requireRejected(
    runAuditor("compare", removed, metadata),
    "removed violation",
  );

  const added = cloneFixture(source);
  sqlite(
    added.database,
    `INSERT INTO rooms VALUES (
      'private-room-29', 'private-project-29', 'extra', 29, 29.5,
      X'29', 'extra', NULL
    );`,
  );
  requireRejected(runAuditor("compare", added, metadata), "added violation");

  const replaced = cloneFixture(source);
  sqlite(
    replaced.database,
    `
      INSERT INTO projects VALUES ('private-project-01');
      INSERT INTO rooms VALUES (
        'private-room-29', 'private-project-29', 'replacement', 29, 29.5,
        X'29', 'replacement', NULL
      );
    `,
  );
  requireRejected(
    runAuditor("compare", replaced, metadata),
    "replaced violation preserving 32-count multiplicity",
  );

  const changedRowId = cloneFixture(source);
  sqlite(
    changedRowId.database,
    `
      CREATE TEMP TABLE saved_room AS SELECT * FROM rooms WHERE rowid = 1;
      DELETE FROM rooms WHERE rowid = 1;
      INSERT INTO rooms SELECT * FROM saved_room;
    `,
  );
  requireRejected(
    runAuditor("compare", changedRowId, metadata),
    "rowid identity drift",
  );
});

test("manifest ordering and integrity tamper are rejected even with recomputed digest", () => {
  const fixture = createFixture();
  const metadata = capture(fixture);

  rewriteManifest(fixture, (manifest) => {
    manifest.violations.reverse();
  });
  requireRejected(
    runAuditor("compare", fixture, metadata),
    "manifest byte tamper",
  );

  const reordered = createFixture();
  const reorderedMetadata = capture(reordered);
  rewriteManifest(
    reordered,
    (manifest) => {
      manifest.violations.reverse();
    },
    { recomputeIntegrity: true },
  );
  requireRejected(
    runAuditor("compare", reordered, reorderedMetadata),
    "reordered violations",
  );

  const trailing = createFixture();
  const trailingMetadata = capture(trailing);
  writeFileSync(
    trailing.manifest,
    Buffer.concat([readFileSync(trailing.manifest), Buffer.from("\n")]),
  );
  requireRejected(
    runAuditor("compare", trailing, trailingMetadata),
    "trailing manifest bytes",
  );

  const duplicate = createFixture();
  const duplicateMetadata = capture(duplicate);
  const duplicateBytes = readFileSync(duplicate.manifest, "utf8").replace(
    '"version": 1,',
    '"version": 1,\n  "version": 1,',
  );
  writeFileSync(duplicate.manifest, duplicateBytes, { mode: 0o600 });
  requireRejected(
    runAuditor("compare", duplicate, duplicateMetadata),
    "duplicate JSON key",
  );
});

test("compare binds exact release, image, authorization, and activation window", () => {
  const fixture = createFixture();
  const metadata = capture(fixture);
  const alternatives = [
    { releaseSha: "c".repeat(40) },
    { releaseId: "other-release-id" },
    { imageDigest: `sha256:${"d".repeat(64)}` },
    { auditorSha256: "d".repeat(64) },
    { authorizationSha256: "f".repeat(64) },
    { windowId: "vault-activation-2026-10-13-b" },
    { windowStart: new Date(Date.now() - 120_000).toISOString() },
    { windowEnd: new Date(Date.now() + 7_200_000).toISOString() },
  ];
  for (const override of alternatives) {
    requireRejected(
      runAuditor("compare", fixture, { ...metadata, ...override }),
      `metadata mismatch ${Object.keys(override)[0]}`,
    );
  }
});

test("external authorization is hash-bound, private, immutable, and not self-authorized", () => {
  const source = createFixture();
  const metadata = capture(source);

  const tampered = cloneFixture(source);
  writeFileSync(
    tampered.authorization,
    Buffer.concat([readFileSync(tampered.authorization), Buffer.from(" ")]),
  );
  requireRejected(
    runAuditor("compare", tampered, metadata),
    "authorization tamper",
  );

  const wrongMode = cloneFixture(source);
  chmodSync(wrongMode.authorization, 0o640);
  requireRejected(
    runAuditor("compare", wrongMode, metadata),
    "authorization mode",
  );

  const linked = cloneFixture(source);
  const linkedPath = join(linked.directory, "authorization-hardlink.json");
  linkSync(linked.authorization, linkedPath);
  requireRejected(
    runAuditor("compare", linked, metadata),
    "authorization hard link",
  );

  const sourceText = readFileSync(AUDITOR, "utf8");
  assert.match(sourceText, /authorizationSha256/);
  assert.match(sourceText, /AUDITOR_ARTIFACT_MISMATCH/);
  assert.doesNotMatch(sourceText, /tenantId|tenant_id|owner/i);
});

test("schema columns and complete FK definitions are exact baseline evidence", () => {
  const source = createFixture();
  const metadata = capture(source);

  const columnDrift = cloneFixture(source);
  sqlite(columnDrift.database, "ALTER TABLE rooms ADD COLUMN drift TEXT;");
  requireRejected(
    runAuditor("compare", columnDrift, metadata),
    "column contract drift",
  );

  const fkDrift = cloneFixture(source);
  sqlite(
    fkDrift.database,
    `
      PRAGMA foreign_keys = OFF;
      ALTER TABLE rooms RENAME TO rooms_before_fk_drift;
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        amount,
        ratio,
        payload,
        note,
        deleted_at TEXT
      );
      INSERT INTO rooms SELECT * FROM rooms_before_fk_drift;
      DROP TABLE rooms_before_fk_drift;
    `,
  );
  requireRejected(
    runAuditor("compare", fkDrift, metadata),
    "FK action contract drift",
  );
});

test("compare rejects every relevant child and parent schema object drift", () => {
  const source = createFixture();
  const metadata = capture(source);
  const mutations = [
    ["ordinary index", "CREATE INDEX schema_drift_probe ON rooms(project_id);"],
    ["unique index", "CREATE UNIQUE INDEX schema_unique_probe ON rooms(name);"],
    [
      "partial index",
      "CREATE INDEX schema_partial_probe ON rooms(name) WHERE deleted_at IS NULL;",
    ],
    [
      "trigger",
      `CREATE TRIGGER schema_trigger_probe
         AFTER INSERT ON rooms
         BEGIN
           SELECT 1;
         END;`,
    ],
    ["parent table", "ALTER TABLE projects ADD COLUMN parent_drift TEXT;"],
    [
      "generated column",
      "ALTER TABLE rooms ADD COLUMN generated_drift TEXT GENERATED ALWAYS AS (name || '!') VIRTUAL;",
    ],
    [
      "CHECK and collation",
      "ALTER TABLE projects ADD COLUMN constrained_drift TEXT COLLATE NOCASE CHECK (length(constrained_drift) < 5);",
    ],
    [
      "FK deferrability",
      `PRAGMA foreign_keys = OFF;
       ALTER TABLE rooms RENAME TO rooms_before_deferrability;
       CREATE TABLE rooms (
         id TEXT PRIMARY KEY,
         project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
         name TEXT NOT NULL,
         amount,
         ratio,
         payload,
         note,
         deleted_at TEXT
       );
       INSERT INTO rooms SELECT * FROM rooms_before_deferrability;
       DROP TABLE rooms_before_deferrability;`,
    ],
    [
      "STRICT parent",
      `DROP TABLE projects;
       CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT;`,
    ],
    [
      "WITHOUT ROWID parent",
      `DROP TABLE projects;
       CREATE TABLE projects (id TEXT PRIMARY KEY) WITHOUT ROWID;`,
    ],
  ];

  for (const [label, sql] of mutations) {
    const fixture = cloneFixture(source);
    sqlite(fixture.database, sql);
    requireRejected(runAuditor("compare", fixture, metadata), label);
  }
});

test("capture fails closed for negative-zero and special SQLite REAL storage", () => {
  for (const [label, value] of [
    ["negative zero", "CAST('-0.0' AS REAL)"],
    ["positive zero", "CAST('+0.0' AS REAL)"],
    ["positive infinity", "1e999"],
    ["negative infinity", "-1e999"],
  ]) {
    const fixture = createFixture();
    sqlite(
      fixture.database,
      `UPDATE rooms SET ratio = ${value} WHERE rowid = 1;`,
    );
    const result = runAuditor("capture", fixture);
    requireRejected(result, label);
    assert.match(result.stderr, /UNSUPPORTED_REAL_STORAGE/);
  }

  const source = readFileSync(AUDITOR, "utf8");
  assert.doesNotMatch(source, /printf\(['"]%!?\.?[0-9]*g/);
});

test("expired windows and reuse of the exclusive capture path fail closed", () => {
  const expiredFixture = createFixture();
  const expired = {
    windowStart: new Date(Date.now() - 3_600_000).toISOString(),
    windowEnd: new Date(Date.now() - 1_000).toISOString(),
  };
  requireRejected(
    runAuditor("capture", expiredFixture, expired),
    "expired capture",
  );

  const fixture = createFixture();
  const metadata = capture(fixture);
  requireRejected(
    runAuditor("capture", fixture, metadata),
    "reused capture path",
  );
  compare(fixture, metadata);
  const receiptPath = `${fixture.manifest}.consumed`;
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  assert.deepEqual(receiptBytes, canonicalBytes(receipt));
  assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(receiptPath).isFile(), true);
  assert.equal(lstatSync(receiptPath).nlink, 1);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "authorizationSha256",
    "comparisonSha256",
    "consumedAt",
    "contract",
    "manifestSha256",
    "state",
    "version",
  ]);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.contract, "vault-fk-baseline-32-one-window");
  assert.equal(receipt.state, "consumed");
  assert.equal(
    receipt.manifestSha256,
    createHash("sha256").update(readFileSync(fixture.manifest)).digest("hex"),
  );
  assert.equal(
    receipt.authorizationSha256,
    createHash("sha256")
      .update(readFileSync(fixture.authorization))
      .digest("hex"),
  );
  assert.match(receipt.comparisonSha256, /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(receipt.consumedAt) >= Date.parse(metadata.windowStart));
  assert.ok(Date.parse(receipt.consumedAt) < Date.parse(metadata.windowEnd));
  requireRejected(
    runAuditor("compare", fixture, metadata),
    "consumed window replay",
  );

  const expiredCompare = cloneFixture(fixture);
  requireRejected(
    runAuditor("compare", expiredCompare, {
      ...expired,
    }),
    "expired compare",
  );
});

test("database and private manifest reject relative, symlink, nonregular, link, and mode attacks", () => {
  const fixture = createFixture();
  const metadata = capture(fixture);

  requireRejected(
    runAuditor("compare", fixture, {
      ...metadata,
      database: "relative.db",
    }),
    "relative database",
  );
  requireRejected(
    runAuditor("compare", fixture, {
      ...metadata,
      manifest: "relative.json",
    }),
    "relative manifest",
  );

  const symlinkDatabase = join(fixture.directory, "database-link.db");
  symlinkSync(fixture.database, symlinkDatabase);
  requireRejected(
    runAuditor("compare", fixture, {
      ...metadata,
      database: symlinkDatabase,
    }),
    "database symlink",
  );

  const symlinkManifest = join(fixture.directory, "manifest-link.json");
  symlinkSync(fixture.manifest, symlinkManifest);
  requireRejected(
    runAuditor("compare", fixture, {
      ...metadata,
      manifest: symlinkManifest,
    }),
    "manifest symlink",
  );

  const linkedDirectory = join(fixture.directory, "real-directory");
  mkdirSync(linkedDirectory);
  const linkedComponent = join(fixture.directory, "linked-directory");
  symlinkSync(linkedDirectory, linkedComponent);
  const componentManifest = join(linkedComponent, "manifest.json");
  copyFileSync(fixture.manifest, join(linkedDirectory, "manifest.json"));
  chmodSync(join(linkedDirectory, "manifest.json"), 0o600);
  requireRejected(
    runAuditor("compare", fixture, {
      ...metadata,
      manifest: componentManifest,
    }),
    "symlink path component",
  );

  chmodSync(fixture.manifest, 0o640);
  requireRejected(runAuditor("compare", fixture, metadata), "manifest mode");
  chmodSync(fixture.manifest, 0o600);

  const hardlink = join(fixture.directory, "manifest-hardlink.json");
  linkSync(fixture.manifest, hardlink);
  requireRejected(
    runAuditor("compare", fixture, metadata),
    "manifest hard link",
  );
  rmSync(hardlink);

  const directoryAsManifest = join(fixture.directory, "manifest-directory");
  mkdirSync(directoryAsManifest);
  requireRejected(
    runAuditor("compare", fixture, {
      ...metadata,
      manifest: directoryAsManifest,
    }),
    "nonregular manifest",
  );
});

test("query_only is enabled and verified, and capture never changes the database image", () => {
  const fixture = createFixture();
  const before = readFileSync(fixture.database);
  const source = readFileSync(AUDITOR, "utf8");
  assert.match(
    source,
    /\[\s*"-batch",\s*"-readonly",\s*this\.databasePath\s*\]/,
  );
  assert.match(source, /PRAGMA query_only\s*=\s*ON/i);
  assert.match(source, /PRAGMA query_only\b/i);
  assert.match(source, /QUERY_ONLY_NOT_ENFORCED/);

  capture(fixture);
  assert.deepEqual(readFileSync(fixture.database), before);
});

test("concurrent database pathname replacement is detected", async () => {
  const fixture = createFixture();
  const metadata = capture(fixture);
  const replacement = join(fixture.directory, "replacement.db");
  const displaced = join(fixture.directory, "displaced.db");
  const marker = join(fixture.directory, "sqlite-opened");
  const resume = join(fixture.directory, "sqlite-resume");
  const binaryDirectory = join(fixture.directory, "bin");
  const sqliteWrapper = join(binaryDirectory, "sqlite3");
  const realSqlite = spawnSync("sh", ["-c", "command -v sqlite3"], {
    encoding: "utf8",
  }).stdout.trim();
  mkdirSync(binaryDirectory);
  writeFileSync(
    sqliteWrapper,
    `#!${process.execPath}
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const child = spawn(${JSON.stringify(realSqlite)}, process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let paused = false;
let queued = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (paused) { queued += chunk; return; }
  const boundary = chunk.indexOf("BEGIN;");
  if (boundary < 0) { child.stdin.write(chunk); return; }
  child.stdin.write(chunk.slice(0, boundary + 6));
  queued += chunk.slice(boundary + 6);
  paused = true;
  writeFileSync(process.env.RF_RACE_MARKER, "ready");
  const timer = setInterval(() => {
    if (!existsSync(process.env.RF_RACE_RESUME)) return;
    clearInterval(timer);
    paused = false;
    child.stdin.write(queued);
    queued = "";
  }, 2);
});
process.stdin.on("end", () => child.stdin.end());
child.on("close", (code) => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  copyFileSync(fixture.database, replacement);

  const compared = spawn(
    process.execPath,
    auditorArgs("compare", fixture, metadata),
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        RF_RACE_MARKER: marker,
        RF_RACE_RESUME: resume,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const chunks = [];
  compared.stdout.on("data", (chunk) => chunks.push(chunk));
  compared.stderr.on("data", (chunk) => chunks.push(chunk));
  for (let attempt = 0; attempt < 2500 && !existsSync(marker); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(existsSync(marker), true, "auditor did not open SQLite");
  renameSync(fixture.database, displaced);
  renameSync(replacement, fixture.database);
  writeFileSync(resume, "resume");

  const status = await new Promise((resolve) =>
    compared.on("close", (code) => resolve(code)),
  );
  assert.notEqual(status, 0, "replacement must not compare successfully");
  const allOutput = Buffer.concat(chunks).toString("utf8");
  assert.match(allOutput, /vault-fk-baseline failed \([A-Z0-9_]+\)/);
  assert.doesNotMatch(allOutput, /private-room|private-project|\/tmp\//);
});

test("busy database and a concurrent writer fail without waiting or consuming the window", async () => {
  const fixture = createFixture();
  const metadata = capture(fixture);
  const locker = spawn("sqlite3", [fixture.database], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => locker.once("close", resolve));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("sqlite lock setup timed out")),
      5_000,
    );
    locker.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("LOCKED")) return;
      clearTimeout(timeout);
      resolve();
    });
    locker.stdin.write("BEGIN EXCLUSIVE;\n.print LOCKED\n");
  });

  const startedAt = Date.now();
  requireRejected(
    runAuditor("compare", fixture, metadata),
    "busy concurrent writer",
  );
  assert.ok(Date.now() - startedAt < 5_000, "busy check must be bounded");
  assert.equal(existsSync(`${fixture.manifest}.consumed`), false);

  locker.stdin.end("COMMIT;\n");
  await closed;
});

test("CLI has only capture/compare and rejects operator SQL, mutation verbs, and unknown arguments", () => {
  const fixture = createFixture();
  for (const args of [
    [],
    ["apply"],
    ["repair"],
    ["migrate"],
    ["capture", "--sql", "SELECT 1"],
    ["compare", "--execute", "PRAGMA foreign_key_check"],
    ["capture", "--database", fixture.database],
    [...auditorArgs("capture", fixture).slice(1), "--unknown", "value"],
  ]) {
    const result = spawnSync(process.execPath, [AUDITOR, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    requireRejected(result, `argv ${args[0] ?? "empty"}`);
  }

  const source = readFileSync(AUDITOR, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    source,
    /\b(?:INSERT\s+INTO|UPDATE\s+["a-z]|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE|VACUUM\b|REINDEX\b|ATTACH\s+DATABASE|DETACH\s+DATABASE)\b/i,
  );
  assert.doesNotMatch(source, /\$executeRaw|exec\s*\(/);
});

test("repeat compare stress remains exact and emits only bounded public summaries", () => {
  const source = createFixture();
  const metadata = capture(source);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const fixture = cloneFixture(source);
    compare(fixture, metadata);
  }
});
