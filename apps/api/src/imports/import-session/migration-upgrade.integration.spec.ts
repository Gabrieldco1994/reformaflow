import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ExpenseType, PaymentForm, ProjectType } from "@reformaflow/domain";

const LEGACY_MIGRATION_COUNT = 68;
const BASE_REVISION = "3d83771c9b60333d3534dc62119f34cc98f62148";

describe("CSV schema upgrade from the committed legacy structure", () => {
  it("upgrades 68 to 70 migrations without changing legacy financial rows or foreign keys", async () => {
    const root = resolve(__dirname, "../../../../..");
    const fixture = mkdtempSync(join(tmpdir(), "maria-csv-upgrade-"));
    const database = join(fixture, "test-upgrade.db");
    expect(database).not.toContain("dev.db");
    const schema = join(fixture, "schema.prisma");
    const migrationRoot = join(fixture, "migrations");
    mkdirSync(migrationRoot);
    writeFileSync(
      schema,
      execFileSync("git", ["show", `${BASE_REVISION}:prisma/schema.prisma`], {
        cwd: root,
      }),
    );
    const committed = join(root, "prisma/migrations");
    const migrations = readdirSync(committed)
      .filter((name) => /^\d/.test(name))
      .sort();
    expect(migrations).toHaveLength(70);
    cpSync(
      join(committed, "migration_lock.toml"),
      join(migrationRoot, "migration_lock.toml"),
    );
    for (const name of migrations.slice(0, LEGACY_MIGRATION_COUNT))
      cpSync(join(committed, name), join(migrationRoot, name), {
        recursive: true,
      });
    const deploy = (): void => {
      execFileSync(
        process.execPath,
        [
          require.resolve("prisma/build/index.js"),
          "migrate",
          "deploy",
          `--schema=${schema}`,
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: `file:${database}` },
          stdio: "pipe",
        },
      );
    };
    deploy();
    const prisma = new PrismaClient({
      datasources: { db: { url: `file:${database}` } },
    });
    try {
      const tenant = await prisma.tenant.create({
        data: { name: "Legacy structural fixture" },
      });
      const project = await prisma.project.create({
        data: {
          tenantId: tenant.id,
          name: "Legacy fixture",
          type: ProjectType.PESSOAL,
        },
      });
      const expenseId = "legacy-csv-upgrade-expense";
      const instant = new Date("2026-09-23T20:00:00.000Z");
      await prisma.$executeRaw`
        INSERT INTO expenses (id, tenant_id, project_id, tipo_despesa, valor, quantidade, valor_total,
          forma_pagamento, titulo, paid_parcelas, installment_date_overrides, created_at, updated_at)
        VALUES (${expenseId}, ${tenant.id}, ${project.id}, ${ExpenseType.OUTROS}, ${101}, ${1}, ${101},
          ${PaymentForm.A_VISTA}, ${"Legacy retained purchase"}, ${"[0]"}, ${'{"0":"2026-09-24"}'}, ${instant}, ${instant})`;
      const before = await prisma.$queryRaw<
        Record<string, unknown>[]
      >`SELECT * FROM expenses WHERE id = ${expenseId}`;
      const appliedBefore = await prisma.$queryRaw<
        unknown[]
      >`SELECT migration_name FROM _prisma_migrations`;
      expect(appliedBefore).toHaveLength(LEGACY_MIGRATION_COUNT);
      await prisma.$disconnect();
      cpSync(join(root, "prisma/schema.prisma"), schema);
      for (const name of migrations.slice(LEGACY_MIGRATION_COUNT))
        cpSync(join(committed, name), join(migrationRoot, name), {
          recursive: true,
        });
      deploy();
      const after = await prisma.$queryRaw<
        Record<string, unknown>[]
      >`SELECT * FROM expenses WHERE id = ${expenseId}`;
      expect(
        after.map(({ documented_schedule, ...legacy }) => {
          expect(documented_schedule).toBeNull();
          return legacy;
        }),
      ).toEqual(before);
      expect(
        await prisma.$queryRaw<unknown[]>`PRAGMA foreign_key_check`,
      ).toEqual([]);
      const applied = await prisma.$queryRaw<unknown[]>`
        SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      expect(applied).toHaveLength(70);
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);
});
