import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MIGRATION = join(
  ROOT,
  "prisma",
  "migrations",
  "20260826150000_external_id_unique_scope_tenant_project",
  "migration.sql",
);
const HISTORICAL_SHA256 =
  "633620a00aa5e58e1d8293f9ae46924e49a5296de45778c6c39236123abb3979";
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "rf-629-migration-"));
  temporaryDirectories.push(directory);
  return join(directory, "fixture.db");
}

function sqlite(database, statement) {
  return spawnSync("sqlite3", [database], {
    input: statement,
    encoding: "utf8",
  });
}

function requireSqliteSuccess(result) {
  assert.equal(
    result.status,
    0,
    `sqlite failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

function createFixture({ normalized }) {
  const database = databasePath();
  const duplicateExternalId = normalized ? "NULL" : "'duplicate-expense'";
  const duplicateReceiptExternalId = normalized
    ? "NULL"
    : "'duplicate-receipt'";
  requireSqliteSuccess(
    sqlite(
      database,
      `
        CREATE TABLE expenses (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          external_id TEXT,
          created_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE TABLE receipts (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          external_id TEXT,
          created_at TEXT NOT NULL,
          deleted_at TEXT
        );
        INSERT INTO expenses VALUES
          ('expense-keeper', 'tenant-a', 'project-a', 'duplicate-expense', '2026-01-01', NULL),
          ('expense-nonkeeper', 'tenant-a', 'project-a', ${duplicateExternalId}, '2026-01-02', '2026-02-01');
        INSERT INTO receipts VALUES
          ('receipt-keeper', 'tenant-a', 'project-a', 'duplicate-receipt', '2026-01-01', NULL),
          ('receipt-nonkeeper', 'tenant-a', 'project-a', ${duplicateReceiptExternalId}, '2026-01-02', '2026-02-01');
      `,
    ),
  );
  return database;
}

test("historical migration is unchanged and fails against the duplicate preimage", () => {
  const migration = readFileSync(MIGRATION);
  assert.equal(
    createHash("sha256").update(migration).digest("hex"),
    HISTORICAL_SHA256,
  );
  const result = sqlite(createFixture({ normalized: false }), migration);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNIQUE constraint failed/);
});

test("historical migration creates both unique indexes after normalization", () => {
  const database = createFixture({ normalized: true });
  requireSqliteSuccess(sqlite(database, readFileSync(MIGRATION)));

  const indexes = sqlite(
    database,
    `
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'expenses_tenant_id_project_id_external_id_key',
          'receipts_tenant_id_project_id_external_id_key'
        )
      ORDER BY name;
    `,
  );
  requireSqliteSuccess(indexes);
  assert.deepEqual(indexes.stdout.trim().split("\n"), [
    "expenses_tenant_id_project_id_external_id_key",
    "receipts_tenant_id_project_id_external_id_key",
  ]);
});

test("both indexes block same-project duplicates, including deleted rows", () => {
  const database = createFixture({ normalized: true });
  requireSqliteSuccess(sqlite(database, readFileSync(MIGRATION)));

  for (const [table, externalId] of [
    ["expenses", "duplicate-expense"],
    ["receipts", "duplicate-receipt"],
  ]) {
    const result = sqlite(
      database,
      `
        INSERT INTO ${table}
          (id, tenant_id, project_id, external_id, created_at, deleted_at)
        VALUES
          ('${table}-blocked', 'tenant-a', 'project-a', '${externalId}',
           '2026-03-01', '2026-03-02');
      `,
    );
    assert.notEqual(result.status, 0, `${table} accepted a duplicate`);
    assert.match(result.stderr, /UNIQUE constraint failed/);
  }
});

test("both indexes allow cross-project and NULL external IDs", () => {
  const database = createFixture({ normalized: true });
  requireSqliteSuccess(sqlite(database, readFileSync(MIGRATION)));

  for (const [table, externalId] of [
    ["expenses", "duplicate-expense"],
    ["receipts", "duplicate-receipt"],
  ]) {
    requireSqliteSuccess(
      sqlite(
        database,
        `
          INSERT INTO ${table} VALUES
            ('${table}-cross-project', 'tenant-a', 'project-b', '${externalId}', '2026-03-01', NULL),
            ('${table}-null-one', 'tenant-a', 'project-a', NULL, '2026-03-01', NULL),
            ('${table}-null-two', 'tenant-a', 'project-a', NULL, '2026-03-01', NULL);
        `,
      ),
    );
  }
});
