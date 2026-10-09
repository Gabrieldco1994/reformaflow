// The jest setup also loads this guard, but requiring it here documents and
// enforces the disposable-DB boundary if this spec is ever run standalone.
require("../../../../scripts/test-db-env.cjs");

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaService } from "./prisma.service";

describe("Maria CSV additive schema baseline", () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists the documented installment schedule on expenses", async () => {
    const expenseColumns = (await prisma.$queryRawUnsafe(
      "PRAGMA table_info('expenses')",
    )) as Array<{ name: string }>;
    const documentedScheduleColumns = expenseColumns
      .map(({ name }) => name)
      .filter((name) =>
        /documented.*(schedule|installment)|(schedule|installment).*documented/i.test(
          name,
        ),
      );

    expect(documentedScheduleColumns).not.toHaveLength(0);
  });

  it("has the import-session coordination tables", async () => {
    const tables = (await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )) as Array<{ name: string }>;
    const importCoordinationTables = tables
      .map(({ name }) => name)
      .filter((name) => /import.*session|session.*import/i.test(name));

    expect(importCoordinationTables.length).toBeGreaterThanOrEqual(2);
  });

  it("adds only the two ordered Maria migrations after the 68-migration main baseline", async () => {
    const migrations = await readdir(
      resolve(__dirname, "../../../../prisma/migrations"),
      { withFileTypes: true },
    );
    const migrationNames = migrations
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const scheduleMigration = "20260923210000_documented_expense_schedule";
    const sessionMigration = "20260929010000_import_session_bootstrap";

    expect(migrationNames).toHaveLength(70);
    expect(migrationNames).toEqual(
      expect.arrayContaining([scheduleMigration, sessionMigration]),
    );
    expect(migrationNames.indexOf(scheduleMigration)).toBeLessThan(
      migrationNames.indexOf(sessionMigration),
    );
  });

  it("preserves the contents of every pre-existing main migration", async () => {
    const migrationsRoot = resolve(__dirname, "../../../../prisma/migrations");
    const mariaMigrations = new Set([
      "20260923210000_documented_expense_schedule",
      "20260929010000_import_session_bootstrap",
    ]);
    const directories = await readdir(migrationsRoot, { withFileTypes: true });
    const priorMigrations = directories
      .filter(
        (entry) => entry.isDirectory() && !mariaMigrations.has(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    const checksum = createHash("sha256");

    for (const migration of priorMigrations) {
      const migrationPath = resolve(migrationsRoot, migration);
      const files = (await readdir(migrationPath)).sort();
      for (const file of files) {
        checksum.update(`${migration}/${file}\0`);
        checksum.update(await readFile(resolve(migrationPath, file)));
        checksum.update("\0");
      }
    }

    expect(priorMigrations).toHaveLength(68);
    expect(checksum.digest("hex")).toBe(
      "539aea0a4476b5b9467ade5564d2f67989bed07c7eabdd31ddcbbc4fdc054f9a",
    );
  });

  it("keeps the upgraded disposable schema free of foreign-key violations", async () => {
    const violations = (await prisma.$queryRawUnsafe(
      "PRAGMA foreign_key_check",
    )) as unknown[];

    expect(violations).toHaveLength(0);
  });
});
