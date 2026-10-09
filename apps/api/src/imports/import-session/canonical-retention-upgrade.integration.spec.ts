import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { ProjectType } from "@reformaflow/domain";

type TestDbGuard = {
  REPO_ROOT: string;
  forbiddenReason(url: string): string | null;
  resolveSqlitePath(url: string): string | null;
  resolveRealSqlitePath(url: string): string | null;
};

// Jest's setup has already rejected dev.db; this suite builds its own guarded fixture.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbGuard =
  require("../../../../../scripts/test-db-env.cjs") as TestDbGuard;
const REPO_ROOT = path.resolve(__dirname, "../../../../../");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "prisma", "migrations");
const TARGET_MIGRATION = "20261009193000_canonical_import_linkage_retention";

describe("canonical retention migration upgrade", () => {
  let workDir: string | null = null;
  let dbFile: string | null = null;
  let ownsWorkDir = false;
  let legacy: PrismaClient | null = null;
  let upgraded: PrismaClient | null = null;

  function checkedUrl(file: string): string {
    const url = `file:${file}`;
    expect(dbGuard.forbiddenReason(url)).toBeNull();
    expect(dbGuard.resolveSqlitePath(url)).toBe(file);
    const realPath = dbGuard.resolveRealSqlitePath(url);
    expect(realPath).not.toBeNull();
    expect(path.basename(realPath!).toLowerCase()).not.toBe("dev.db");
    expect(path.relative(REPO_ROOT, realPath!)).not.toMatch(
      /^(?:\.\.(?:\/|$)|\/)/,
    );
    return url;
  }

  function deploy(url: string, schema: string): void {
    execFileSync(
      process.execPath,
      [
        require.resolve("prisma/build/index.js"),
        "migrate",
        "deploy",
        "--schema",
        schema,
      ],
      {
        cwd: path.join(REPO_ROOT, "apps", "api"),
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
      },
    );
  }

  beforeAll(async () => {
    expect(dbGuard.REPO_ROOT).toBe(REPO_ROOT);
    const migrations = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((entry) =>
        fs.statSync(path.join(MIGRATIONS_DIR, entry)).isDirectory(),
      )
      .sort();
    const targetIndex = migrations.indexOf(TARGET_MIGRATION);
    expect(targetIndex).toBeGreaterThan(0);

    workDir = fs.mkdtempSync(
      path.join(REPO_ROOT, "prisma", ".tmp-canonical-retention-upgrade-"),
    );
    ownsWorkDir = true;
    const fixtureMigrations = path.join(workDir, "migrations");
    fs.mkdirSync(fixtureMigrations);
    fs.copyFileSync(
      path.join(MIGRATIONS_DIR, "migration_lock.toml"),
      path.join(fixtureMigrations, "migration_lock.toml"),
    );
    const schema = path.join(workDir, "schema.prisma");
    fs.copyFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), schema);
    for (const name of migrations.slice(0, targetIndex)) {
      fs.cpSync(
        path.join(MIGRATIONS_DIR, name),
        path.join(fixtureMigrations, name),
        { recursive: true },
      );
    }

    dbFile = path.join(workDir, "retention-upgrade.test.db");
    const url = checkedUrl(dbFile);
    deploy(url, schema);

    legacy = new PrismaClient({ datasources: { db: { url } } });
    await legacy.$connect();
    const tenant = await legacy.tenant.create({
      data: { name: "retention migration fixture" },
    });
    const project = await legacy.project.create({
      data: {
        tenantId: tenant.id,
        name: "retention migration fixture",
        type: ProjectType.PESSOAL,
      },
    });
    const expense = await legacy.expense.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: 100,
        quantidade: 1,
        valorTotal: 100,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
      },
    });
    const artifact = await legacy.importArtifact.create({
      data: {
        tenantId: tenant.id,
        ownerProjectId: project.id,
        documentSha256: randomUUID().replaceAll("-", "").padEnd(64, "e"),
        verifiedBytes: 1,
        detectedFormat: "CSV",
        state: "EXTRACTED",
      },
    });
    await legacy.importObservation.create({
      data: {
        tenantId: tenant.id,
        ownerProjectId: project.id,
        artifactId: artifact.id,
        reference: "legacy-dead-claim",
        evidenceJson: "{}",
        canonicalProjectId: project.id,
        canonicalExpenseId: expense.id,
        claimReceiptJson: "{}",
        claimedAt: new Date(),
      },
    });
    await legacy.expense.update({
      where: { id: expense.id },
      data: { deletedAt: new Date() },
    });
    await legacy.$disconnect();
    legacy = null;

    fs.cpSync(
      path.join(MIGRATIONS_DIR, TARGET_MIGRATION),
      path.join(fixtureMigrations, TARGET_MIGRATION),
      { recursive: true },
    );
    deploy(url, schema);

    upgraded = new PrismaClient({ datasources: { db: { url } } });
    await upgraded.$connect();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(
      [legacy?.$disconnect(), upgraded?.$disconnect()].filter(
        (item): item is Promise<void> => item !== undefined,
      ),
    );
    if (ownsWorkDir && workDir) fs.rmSync(workDir, { recursive: true });
  });

  it("repairs dead claims and their hash identity without altering finance", async () => {
    expect(upgraded).not.toBeNull();
    expect(await upgraded!.importObservation.count()).toBe(0);
    expect(await upgraded!.importArtifact.count()).toBe(0);
    const tombstones = await upgraded!.expense.findMany({
      where: { deletedAt: { not: null } },
      select: { deletedAt: true },
    });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].deletedAt).not.toBeNull();
    expect(await upgraded!.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });
});
