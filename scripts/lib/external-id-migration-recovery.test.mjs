import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
require("../test-db-env.cjs");

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MIGRATION = join(
  ROOT,
  "prisma",
  "migrations",
  "20260826150000_external_id_unique_scope_tenant_project",
  "migration.sql",
);
const MIGRATION_NAME = "20260826150000_external_id_unique_scope_tenant_project";
const PRISMA = join(ROOT, "node_modules", ".bin", "prisma");
const NORMALIZER = join(
  ROOT,
  "scripts",
  "normalize-external-id-duplicates.mjs",
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

function commandOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function runPrisma(database, schema, args) {
  return spawnSync(PRISMA, [...args, "--schema", schema], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: `file:${database}`,
      NO_COLOR: "1",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    },
  });
}

function runNormalizer(database, args) {
  return spawnSync(process.execPath, [NORMALIZER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: `file:${database}`,
    },
  });
}

function requireCommandSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

function duplicateGroupCount(database, table) {
  const result = sqlite(
    database,
    `
      SELECT COUNT(*)
      FROM (
        SELECT tenant_id, project_id, external_id
        FROM "${table}"
        WHERE external_id IS NOT NULL
        GROUP BY tenant_id, project_id, external_id
        HAVING COUNT(*) > 1
      );
    `,
  );
  requireSqliteSuccess(result);
  return Number(result.stdout.trim());
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

test("Prisma deploy recovers the legacy expense duplicate after P3009 without touching unique receipts", () => {
  const directory = mkdtempSync(
    join(ROOT, "prisma", ".rf-629-upgrade-integration-"),
  );
  temporaryDirectories.push(directory);
  const database = join(directory, "upgrade.db");
  const schema = join(directory, "schema.prisma");
  const migrations = join(directory, "migrations");
  const baselineDirectory = join(migrations, "20260826000000_legacy_fixture");
  const historicalDirectory = join(migrations, MIGRATION_NAME);
  const historicalBytes = readFileSync(MIGRATION);
  const historicalCopy = join(historicalDirectory, "migration.sql");
  const manifest = join(directory, "manifest.json");

  mkdirSync(baselineDirectory, { recursive: true });
  mkdirSync(historicalDirectory, { recursive: true });
  writeFileSync(
    schema,
    `
      datasource db {
        provider = "sqlite"
        url      = env("DATABASE_URL")
      }

      model Expense {
        id         String   @id
        tenantId   String   @map("tenant_id")
        projectId  String   @map("project_id")
        externalId String?  @map("external_id")
        createdAt  DateTime @map("created_at")
        deletedAt  DateTime? @map("deleted_at")

        @@map("expenses")
      }

      model Receipt {
        id         String   @id
        tenantId   String   @map("tenant_id")
        projectId  String   @map("project_id")
        externalId String?  @map("external_id")
        createdAt  DateTime @map("created_at")
        deletedAt  DateTime? @map("deleted_at")

        @@map("receipts")
      }
    `,
  );
  writeFileSync(
    join(migrations, "migration_lock.toml"),
    'provider = "sqlite"\n',
  );
  writeFileSync(
    join(baselineDirectory, "migration.sql"),
    `
      CREATE TABLE "expenses" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tenant_id" TEXT NOT NULL,
        "project_id" TEXT NOT NULL,
        "external_id" TEXT,
        "created_at" DATETIME NOT NULL,
        "deleted_at" DATETIME
      );
      CREATE TABLE "receipts" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tenant_id" TEXT NOT NULL,
        "project_id" TEXT NOT NULL,
        "external_id" TEXT,
        "created_at" DATETIME NOT NULL,
        "deleted_at" DATETIME
      );

      INSERT INTO "expenses" VALUES
        ('expense-active', 'tenant-a', 'project-a', 'expense-duplicate',
         '2026-01-01T12:00:00.000Z', NULL),
        ('expense-deleted', 'tenant-a', 'project-a', 'expense-duplicate',
         '2026-01-02T12:00:00.000Z', '2026-02-01T12:00:00.000Z');
      INSERT INTO "receipts" VALUES
        ('receipt-a', 'tenant-a', 'project-a', 'receipt-a',
         '2026-01-01T12:00:00.000Z', NULL),
        ('receipt-b', 'tenant-a', 'project-a', 'receipt-b',
         '2026-01-02T12:00:00.000Z', NULL);
    `,
  );
  writeFileSync(historicalCopy, historicalBytes);
  assert.deepEqual(readFileSync(historicalCopy), historicalBytes);

  const firstDeploy = runPrisma(database, schema, ["migrate", "deploy"]);
  assert.notEqual(
    firstDeploy.status,
    0,
    "duplicate preimage unexpectedly migrated",
  );
  assert.match(commandOutput(firstDeploy), /P3018/);
  assert.equal(duplicateGroupCount(database, "expenses"), 1);
  assert.equal(duplicateGroupCount(database, "receipts"), 0);

  const failedLedger = sqlite(
    database,
    `
      SELECT migration_name,
             finished_at IS NULL,
             rolled_back_at IS NULL,
             logs IS NOT NULL
      FROM "_prisma_migrations"
      WHERE migration_name = '${MIGRATION_NAME}';
    `,
  );
  requireSqliteSuccess(failedLedger);
  assert.equal(failedLedger.stdout.trim(), `${MIGRATION_NAME}|1|1|1`);

  const blockedDeploy = runPrisma(database, schema, ["migrate", "deploy"]);
  assert.notEqual(
    blockedDeploy.status,
    0,
    "failed migration did not block deploy",
  );
  assert.match(commandOutput(blockedDeploy), /P3009/);

  const dryRun = runNormalizer(database, ["--dry-run", "--manifest", manifest]);
  requireCommandSuccess(dryRun, "normalizer dry-run");
  const dryRunSummary = JSON.parse(dryRun.stdout);
  assert.equal(dryRunSummary.expectedGroups, 1);
  assert.equal(dryRunSummary.expectedUpdates, 1);

  const apply = runNormalizer(database, [
    "--apply",
    "--manifest",
    manifest,
    "--hash",
    dryRunSummary.sha256,
    "--expected-groups",
    "1",
    "--expected-updates",
    "1",
  ]);
  requireCommandSuccess(apply, "normalizer apply");
  assert.deepEqual(JSON.parse(apply.stdout), {
    expectedGroups: 1,
    expectedUpdates: 1,
    updated: 1,
    sha256: dryRunSummary.sha256,
  });
  assert.equal(duplicateGroupCount(database, "expenses"), 0);
  assert.equal(duplicateGroupCount(database, "receipts"), 0);

  const resolve = runPrisma(database, schema, [
    "migrate",
    "resolve",
    "--rolled-back",
    MIGRATION_NAME,
  ]);
  requireCommandSuccess(resolve, "migrate resolve");

  const recoveredDeploy = runPrisma(database, schema, ["migrate", "deploy"]);
  requireCommandSuccess(recoveredDeploy, "recovered migrate deploy");
  assert.ok(
    commandOutput(recoveredDeploy).includes(
      `Applying migration \`${MIGRATION_NAME}\``,
    ),
  );

  const secondDeploy = runPrisma(database, schema, ["migrate", "deploy"]);
  requireCommandSuccess(secondDeploy, "idempotent migrate deploy");
  assert.match(commandOutput(secondDeploy), /No pending migrations to apply/);

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
  assert.equal(duplicateGroupCount(database, "expenses"), 0);
  assert.equal(duplicateGroupCount(database, "receipts"), 0);
});
