import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { REPO_ROOT } = require("../test-db-env.cjs");
const { PrismaClient } = require("@prisma/client");
const execFileAsync = promisify(execFile);

const {
  buildRepairManifest,
  canonicalManifestBytes,
  manifestCounts,
  runRepair,
  sha256,
} = await import("./repair-external-id-duplicates.mjs");
const { main } = await import("../repair-external-id-duplicates.mjs");

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-02T00:00:00.000Z";
const DELETED_AT = "2026-01-03T00:00:00.000Z";
const MIGRATION_PATH = path.join(
  REPO_ROOT,
  "prisma/migrations/20260826150000_external_id_unique_scope_tenant_project/migration.sql",
);

function row({
  id,
  table = "expenses",
  tenantId = "tenant-a",
  projectId = "project-a",
  externalId = "external-a",
  createdAt = CREATED_AT,
  updatedAt = UPDATED_AT,
  deletedAt = DELETED_AT,
}) {
  return {
    id,
    table,
    tenantId,
    projectId,
    externalId,
    createdAt,
    updatedAt,
    deletedAt,
  };
}

test("plan groups only by table + tenant + project + non-null external id and chooses the contract keeper", () => {
  const manifest = buildRepairManifest(
    [
      row({ id: "expense-deleted-old", createdAt: "2025-01-01T00:00:00.000Z" }),
      row({
        id: "expense-active",
        deletedAt: null,
        createdAt: "2026-02-01T00:00:00.000Z",
      }),
      row({ id: "expense-other-project", projectId: "project-b" }),
      row({ id: "expense-other-tenant", tenantId: "tenant-b" }),
      row({ id: "receipt-same-key", table: "receipts" }),
      row({ id: "null-1", externalId: null }),
      row({ id: "null-2", externalId: null }),
      row({ id: "deleted-tie-b", externalId: "external-b" }),
      row({ id: "deleted-tie-a", externalId: "external-b" }),
    ],
    "2026-08-28T12:00:00.000Z",
  );

  assert.deepEqual(manifestCounts(manifest), {
    expenses: { groups: 2, rows: 4, nonkeepers: 2 },
    receipts: { groups: 0, rows: 0, nonkeepers: 0 },
  });
  assert.equal(manifest.groups[0].keeperId, "expense-active");
  assert.equal(manifest.groups[1].keeperId, "deleted-tie-a");
  assert.equal(
    manifest.groups.every((group) => group.table === "expenses"),
    true,
  );
});

test("plan aborts when a duplicate group has more than one active row", () => {
  assert.throws(
    () =>
      buildRepairManifest([
        row({ id: "active-a", deletedAt: null }),
        row({ id: "active-b", deletedAt: null }),
      ]),
    /more than one active row/,
  );
});

async function createFixture() {
  const directory = await mkdtemp(
    path.join(REPO_ROOT, "prisma", "repair-test-"),
  );
  const dbPath = path.join(directory, "incident.sqlite");
  const databaseUrl = `file:${dbPath}`;
  const manifestPath = path.join(directory, "manifest.json");
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  for (const table of ["expenses", "receipts"]) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${table}" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tenant_id" TEXT NOT NULL,
        "project_id" TEXT NOT NULL,
        "external_id" TEXT,
        "created_at" DATETIME NOT NULL,
        "updated_at" DATETIME NOT NULL,
        "deleted_at" DATETIME
      )
    `);
  }

  const insert = async (value) => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${value.table}" (
        id, tenant_id, project_id, external_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      value.id,
      value.tenantId,
      value.projectId,
      value.externalId,
      value.createdAt,
      value.updatedAt,
      value.deletedAt,
    );
  };

  await insert(row({ id: "expense-active", deletedAt: null }));
  await insert(
    row({ id: "expense-deleted", createdAt: "2025-01-01T00:00:00.000Z" }),
  );
  await insert(row({ id: "expense-unrelated", externalId: null }));
  await insert(
    row({ id: "receipt-keeper", table: "receipts", externalId: "receipt-a" }),
  );
  await insert(
    row({
      id: "receipt-nonkeeper",
      table: "receipts",
      externalId: "receipt-a",
      createdAt: "2026-02-01T00:00:00.000Z",
    }),
  );

  return {
    databaseUrl,
    manifestPath,
    prisma,
    async cleanup() {
      await prisma.$disconnect();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function rows(prisma, table) {
  return prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, project_id, external_id, created_at, updated_at, deleted_at
       FROM "${table}" ORDER BY id`,
  );
}

test("dry-run writes a 0600 canonical manifest without changing the database", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const before = await rows(fixture.prisma, "expenses");

  const result = await runRepair({
    databaseUrl: fixture.databaseUrl,
    manifestPath: fixture.manifestPath,
  });

  assert.equal(result.mode, "dry-run");
  assert.deepEqual(await rows(fixture.prisma, "expenses"), before);
  assert.equal((await stat(fixture.manifestPath)).mode & 0o777, 0o600);
  const bytes = await readFile(fixture.manifestPath);
  assert.deepEqual(bytes, canonicalManifestBytes(result.manifest));
  assert.equal(result.manifestSha256, sha256(bytes));
});

test("apply changes only deleted nonkeepers, preserves keeper/timestamps, and makes the migration pass", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const migrationSql = await readFile(MIGRATION_PATH, "utf8");
  const statements = migrationSql
    .replaceAll(/^--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  await assert.rejects(
    fixture.prisma.$executeRawUnsafe(statements[0]),
    /unique constraint failed/i,
  );
  const dryRun = await runRepair({
    databaseUrl: fixture.databaseUrl,
    manifestPath: fixture.manifestPath,
  });
  const expectedCounts = manifestCounts(dryRun.manifest);
  const beforeExpenses = await rows(fixture.prisma, "expenses");

  const applied = await runRepair({
    databaseUrl: fixture.databaseUrl,
    manifestPath: fixture.manifestPath,
    apply: true,
    manifestSha256: dryRun.manifestSha256,
    expectedCounts,
  });

  assert.equal(applied.mode, "applied");
  assert.equal(applied.updated, 2);
  const afterExpenses = await rows(fixture.prisma, "expenses");
  assert.deepEqual(
    afterExpenses.map(
      ({ id, external_id, created_at, updated_at, deleted_at }) => ({
        id,
        external_id,
        created_at,
        updated_at,
        deleted_at,
      }),
    ),
    beforeExpenses.map(
      ({ id, external_id, created_at, updated_at, deleted_at }) => ({
        id,
        external_id: id === "expense-deleted" ? null : external_id,
        created_at,
        updated_at,
        deleted_at,
      }),
    ),
  );
  for (const statement of statements)
    await fixture.prisma.$executeRawUnsafe(statement);
});

test("apply rejects wrong hash/counts/CAS drift, is idempotent only for exact postimage, and rejects partial state", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const dryRun = await runRepair({
    databaseUrl: fixture.databaseUrl,
    manifestPath: fixture.manifestPath,
  });
  const expectedCounts = manifestCounts(dryRun.manifest);

  await assert.rejects(
    runRepair({
      databaseUrl: fixture.databaseUrl,
      manifestPath: fixture.manifestPath,
      apply: true,
      manifestSha256: "0".repeat(64),
      expectedCounts,
    }),
    /manifest SHA-256 mismatch/,
  );
  await assert.rejects(
    runRepair({
      databaseUrl: fixture.databaseUrl,
      manifestPath: fixture.manifestPath,
      apply: true,
      manifestSha256: dryRun.manifestSha256,
      expectedCounts: {
        ...expectedCounts,
        expenses: { groups: 99, rows: 99, nonkeepers: 99 },
      },
    }),
    /expected counts mismatch/,
  );

  await runRepair({
    databaseUrl: fixture.databaseUrl,
    manifestPath: fixture.manifestPath,
    apply: true,
    manifestSha256: dryRun.manifestSha256,
    expectedCounts,
  });
  const noOp = await runRepair({
    databaseUrl: fixture.databaseUrl,
    manifestPath: fixture.manifestPath,
    apply: true,
    manifestSha256: dryRun.manifestSha256,
    expectedCounts,
  });
  assert.equal(noOp.mode, "no-op");

  await fixture.prisma.$executeRawUnsafe(
    `UPDATE receipts SET external_id = ? WHERE id = ? AND deleted_at IS NOT NULL`,
    "receipt-a",
    "receipt-nonkeeper",
  );
  await assert.rejects(
    runRepair({
      databaseUrl: fixture.databaseUrl,
      manifestPath: fixture.manifestPath,
      apply: true,
      manifestSha256: dryRun.manifestSha256,
      expectedCounts,
    }),
    /partial or drifted state/,
  );

  await writeFile(fixture.manifestPath, "{}", { mode: 0o600 });
  await assert.rejects(
    runRepair({
      databaseUrl: fixture.databaseUrl,
      manifestPath: fixture.manifestPath,
      apply: true,
      manifestSha256: dryRun.manifestSha256,
      expectedCounts,
    }),
    /manifest SHA-256 mismatch/,
  );
});

test("operational CLI requires an explicit database URL and never defaults to DATABASE_URL", async () => {
  const source = await readFile(
    fileURLToPath(
      new URL("../repair-external-id-duplicates.mjs", import.meta.url),
    ),
    "utf8",
  );
  await assert.rejects(
    main([]),
    /explicit SQLite file: database URL is required/,
  );
  assert.match(source, /database-url/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
});

test("CLI defaults to dry-run and logs counts/hash without row identifiers or keys", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      path.join(REPO_ROOT, "scripts/repair-external-id-duplicates.mjs"),
      "--database-url",
      fixture.databaseUrl,
      "--manifest",
      fixture.manifestPath,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: "file:/must-not-be-used.sqlite" },
    },
  );

  const summary = JSON.parse(stdout);
  assert.equal(summary.mode, "dry-run");
  assert.match(summary.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(stderr, "");
  for (const sensitiveValue of [
    "expense-active",
    "expense-deleted",
    "tenant-a",
    "project-a",
    "external-a",
  ]) {
    assert.doesNotMatch(stdout, new RegExp(sensitiveValue));
  }
});

test("apply update is a parameterized CAS on identity, scope, old value, and soft-delete state", async () => {
  const source = await readFile(
    fileURLToPath(
      new URL("./repair-external-id-duplicates.mjs", import.meta.url),
    ),
    "utf8",
  );
  assert.match(
    source,
    /WHERE id = \?[\s\S]*tenant_id = \?[\s\S]*project_id = \?[\s\S]*external_id = \?[\s\S]*deleted_at IS NOT NULL/,
  );
  assert.match(source, /if \(count !== 1\)/);
  assert.match(source, /BEGIN IMMEDIATE/);
});
