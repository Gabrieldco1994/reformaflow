import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, "scripts", "normalize-external-id-duplicates.mjs");
const temporaryDirectories = [];

const PII = [
  "tenant-secret",
  "project-secret",
  "expense-live-secret",
  "expense-old-secret",
  "receipt-live-secret",
  "receipt-old-secret",
  "external-secret",
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryPath(name) {
  const directory = mkdtempSync(join(tmpdir(), "rf-629-normalizer-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function sql(database, statement, options = []) {
  const result = spawnSync("sqlite3", [...options, database], {
    input: statement,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `sqlite fixture failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result.stdout;
}

function createCanonicalDatabase() {
  const database = temporaryPath("fixture.db");
  sql(
    database,
    `
      CREATE TABLE expenses (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        external_id TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        untouched TEXT NOT NULL
      );
      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        external_id TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        untouched TEXT NOT NULL
      );

      INSERT INTO expenses VALUES
        ('expense-live-secret', 'tenant-secret', 'project-secret', 'external-secret',
         '2026-01-02T12:00:00.000Z', NULL, 'keep-live'),
        ('expense-old-secret', 'tenant-secret', 'project-secret', 'external-secret',
         '2026-01-01T12:00:00.000Z', '2026-02-01T12:00:00.000Z', 'clear-old'),
        ('expense-b', 'tenant-secret', 'project-secret', 'external-no-active',
         '2026-01-03T12:00:00.000Z', '2026-02-03T12:00:00.000Z', 'clear-b'),
        ('expense-a', 'tenant-secret', 'project-secret', 'external-no-active',
         '2026-01-03T12:00:00.000Z', '2026-02-02T12:00:00.000Z', 'keep-a'),
        ('cross-project', 'tenant-secret', 'other-project', 'external-secret',
         '2026-01-01T12:00:00.000Z', NULL, 'isolated-project'),
        ('cross-tenant', 'other-tenant', 'project-secret', 'external-secret',
         '2026-01-01T12:00:00.000Z', NULL, 'isolated-tenant'),
        ('null-one', 'tenant-secret', 'project-secret', NULL,
         '2026-01-01T12:00:00.000Z', NULL, 'isolated-null-1'),
        ('null-two', 'tenant-secret', 'project-secret', NULL,
         '2026-01-01T12:00:00.000Z', NULL, 'isolated-null-2');

      INSERT INTO receipts VALUES
        ('receipt-live-secret', 'tenant-secret', 'project-secret', 'external-secret',
         '2026-01-05T12:00:00.000Z', NULL, 'keep-receipt'),
        ('receipt-old-secret', 'tenant-secret', 'project-secret', 'external-secret',
         '2026-01-04T12:00:00.000Z', '2026-02-04T12:00:00.000Z', 'clear-receipt');
    `,
  );
  return database;
}

function runNormalizer(database, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: `file:${database}`,
    },
  });
}

function assertNoPii(result) {
  const logs = `${result.stdout}\n${result.stderr}`;
  for (const value of PII) {
    assert.doesNotMatch(logs, new RegExp(value), `logs leaked ${value}`);
  }
}

function requireSuccess(result) {
  assertNoPii(result);
  assert.equal(
    result.status,
    0,
    `normalizer failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

function requireFailure(result) {
  assertNoPii(result);
  assert.doesNotMatch(
    result.stderr,
    /MODULE_NOT_FOUND|Cannot find module/,
    "normalizer artifact is missing",
  );
  assert.notEqual(result.status, 0, "unsafe normalizer invocation succeeded");
}

function manifestHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshot(database) {
  return sql(
    database,
    `
      SELECT 'expenses' AS source, * FROM expenses
      UNION ALL
      SELECT 'receipts' AS source, * FROM receipts
      ORDER BY source, id;
    `,
    ["-json"],
  );
}

function dryRun(database, manifest) {
  const result = runNormalizer(database, ["--dry-run", "--manifest", manifest]);
  requireSuccess(result);
  return manifestHash(manifest);
}

function applyArgs(manifest, hash, groups = 3, updates = 3) {
  return [
    "--apply",
    "--manifest",
    manifest,
    "--hash",
    hash,
    "--expected-groups",
    String(groups),
    "--expected-updates",
    String(updates),
  ];
}

test("dry-run selects keepers deterministically, isolates scopes, and never writes", () => {
  const database = createCanonicalDatabase();
  const manifestA = temporaryPath("manifest-a.json");
  const manifestB = temporaryPath("manifest-b.json");
  const before = snapshot(database);

  const hashA = dryRun(database, manifestA);
  const hashB = dryRun(database, manifestB);

  assert.equal(snapshot(database), before);
  assert.equal(
    readFileSync(manifestA, "utf8"),
    readFileSync(manifestB, "utf8"),
  );
  assert.equal(hashA, hashB);
  assert.match(hashA, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(manifestA, "utf8")), {
    version: 1,
    expectedGroups: 3,
    expectedUpdates: 3,
    groups: [
      {
        table: "expenses",
        tenantId: "tenant-secret",
        projectId: "project-secret",
        externalId: "external-no-active",
        keeperId: "expense-a",
        nonkeeperIds: ["expense-b"],
      },
      {
        table: "expenses",
        tenantId: "tenant-secret",
        projectId: "project-secret",
        externalId: "external-secret",
        keeperId: "expense-live-secret",
        nonkeeperIds: ["expense-old-secret"],
      },
      {
        table: "receipts",
        tenantId: "tenant-secret",
        projectId: "project-secret",
        externalId: "external-secret",
        keeperId: "receipt-live-secret",
        nonkeeperIds: ["receipt-old-secret"],
      },
    ],
  });
});

test("more than one active row aborts without a manifest or writes", () => {
  const database = createCanonicalDatabase();
  const manifest = temporaryPath("manifest.json");
  sql(
    database,
    `UPDATE expenses SET deleted_at = NULL WHERE id = 'expense-old-secret';`,
  );
  const before = snapshot(database);

  const result = runNormalizer(database, ["--dry-run", "--manifest", manifest]);

  requireFailure(result);
  assert.equal(snapshot(database), before);
  assert.throws(() => readFileSync(manifest));
});

test("apply requires hash and both expected counts", () => {
  for (const omittedFlag of [
    "--hash",
    "--expected-groups",
    "--expected-updates",
  ]) {
    const database = createCanonicalDatabase();
    const manifest = temporaryPath(`${omittedFlag.slice(2)}.json`);
    const hash = dryRun(database, manifest);
    const args = applyArgs(manifest, hash);
    const index = args.indexOf(omittedFlag);
    args.splice(index, 2);
    const before = snapshot(database);

    requireFailure(runNormalizer(database, args));
    assert.equal(snapshot(database), before);
  }
});

test("hash or expected-count mismatch aborts without writes", () => {
  for (const buildArgs of [
    (manifest) => applyArgs(manifest, "0".repeat(64)),
    (manifest, hash) => applyArgs(manifest, hash, 3, 999),
  ]) {
    const database = createCanonicalDatabase();
    const manifest = temporaryPath("manifest.json");
    const hash = dryRun(database, manifest);
    const before = snapshot(database);

    requireFailure(runNormalizer(database, buildArgs(manifest, hash)));
    assert.equal(snapshot(database), before);
  }
});

test("apply changes only nonkeeper external_id values and second apply is a no-op", () => {
  const database = createCanonicalDatabase();
  const manifest = temporaryPath("manifest.json");
  const hash = dryRun(database, manifest);
  const before = JSON.parse(snapshot(database));

  requireSuccess(runNormalizer(database, applyArgs(manifest, hash)));

  const after = JSON.parse(snapshot(database));
  const changedIds = new Set([
    "expense-b",
    "expense-old-secret",
    "receipt-old-secret",
  ]);
  assert.deepEqual(
    after.map((row) => ({
      ...row,
      external_id: changedIds.has(row.id)
        ? before.find((old) => old.id === row.id).external_id
        : row.external_id,
    })),
    before,
  );
  for (const row of after) {
    if (changedIds.has(row.id)) assert.equal(row.external_id, null);
  }

  const postimage = snapshot(database);
  sql(
    database,
    `
      CREATE TRIGGER reject_expense_second_apply
      BEFORE UPDATE OF external_id ON expenses
      BEGIN SELECT RAISE(ABORT, 'second apply attempted a write'); END;
      CREATE TRIGGER reject_receipt_second_apply
      BEFORE UPDATE OF external_id ON receipts
      BEGIN SELECT RAISE(ABORT, 'second apply attempted a write'); END;
    `,
  );
  requireSuccess(runNormalizer(database, applyArgs(manifest, hash)));
  assert.equal(snapshot(database), postimage);
});

test("apply is transactional when a later write fails", () => {
  const database = createCanonicalDatabase();
  const manifest = temporaryPath("manifest.json");
  const hash = dryRun(database, manifest);
  sql(
    database,
    `
      CREATE TRIGGER reject_receipt_update
      BEFORE UPDATE OF external_id ON receipts
      WHEN OLD.id = 'receipt-old-secret'
      BEGIN SELECT RAISE(ABORT, 'forced late write failure'); END;
    `,
  );
  const before = snapshot(database);

  requireFailure(runNormalizer(database, applyArgs(manifest, hash)));
  assert.equal(snapshot(database), before);
});

test("partial postimage and drift both abort atomically", () => {
  for (const driftSql of [
    `UPDATE expenses SET external_id = NULL WHERE id = 'expense-b';`,
    `UPDATE receipts SET external_id = 'drifted-value' WHERE id = 'receipt-old-secret';`,
  ]) {
    const database = createCanonicalDatabase();
    const manifest = temporaryPath("manifest.json");
    const hash = dryRun(database, manifest);
    sql(database, driftSql);
    const before = snapshot(database);

    requireFailure(runNormalizer(database, applyArgs(manifest, hash)));
    assert.equal(snapshot(database), before);
  }
});
