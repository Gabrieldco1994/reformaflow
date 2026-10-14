import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = resolve(__dirname, "../../../../../..");
const OCR_COLUMN_MIGRATION = "20261013180000_import_pdf_ocr_runtime";
const OCR_LEDGER_MIGRATION = "20261013183000_import_ocr_usage_budget";
const OCR_LEDGER_FK_MIGRATION = "20261013233000_import_ocr_usage_foreign_keys";
const OCR_PROVENANCE_MIGRATION = "20261014004500_import_ocr_usage_provenance";

function deploy(schema: string, database: string): void {
  execFileSync(
    process.execPath,
    [
      require.resolve("prisma/build/index.js"),
      "migrate",
      "deploy",
      `--schema=${schema}`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: `file:${database}` },
      stdio: "pipe",
    },
  );
}

describe("PDF OCR migration fresh and populated upgrade", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0))
      rmSync(fixture, { recursive: true, force: true });
  });

  it("keeps the previously committed OCR migration byte-identical", () => {
    const historical = execFileSync("git", [
      "show",
      `c9791f5c7:prisma/migrations/${OCR_COLUMN_MIGRATION}/migration.sql`,
    ]);
    expect(
      readFileSync(
        join(ROOT, "prisma/migrations", OCR_COLUMN_MIGRATION, "migration.sql"),
      ),
    ).toEqual(historical);
  });

  function setup(includeLedger: boolean) {
    const fixture = mkdtempSync(join(ROOT, "prisma", ".tmp-ocr-upgrade-"));
    fixtures.push(fixture);
    const migrations = join(fixture, "migrations");
    mkdirSync(migrations);
    cpSync(
      join(ROOT, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    const committed = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((name) => /^\d/.test(name))
      .sort();
    expect(committed.at(-1)).toBe(OCR_PROVENANCE_MIGRATION);
    for (const migration of committed) {
      if (
        !includeLedger &&
        (migration === OCR_LEDGER_MIGRATION ||
          migration === OCR_LEDGER_FK_MIGRATION ||
          migration === OCR_PROVENANCE_MIGRATION)
      )
        continue;
      cpSync(
        join(ROOT, "prisma/migrations", migration),
        join(migrations, migration),
        { recursive: true },
      );
    }
    const schema = join(fixture, "schema.prisma");
    cpSync(join(ROOT, "prisma/schema.prisma"), schema);
    const database = join(fixture, "test-ocr-upgrade.db");
    expect(database).not.toContain("dev.db");
    return { fixture, migrations, schema, database };
  }

  it("deploys fresh with exactly the nullable import-session OCR column and clean foreign keys", async () => {
    const target = setup(true);
    deploy(target.schema, target.database);
    const db = new PrismaClient({
      datasources: { db: { url: `file:${target.database}` } },
    });
    try {
      expect(
        await db.$queryRaw<Array<{ name: string; notnull: number }>>`
          SELECT name, "notnull"
          FROM pragma_table_info('import_sessions')
          WHERE name = 'ocr_json'`,
      ).toEqual([{ name: "ocr_json", notnull: 0n }]);
      expect(
        await db.$queryRaw<Array<{ name: string }>>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'import_ocr_%'`,
      ).toEqual([{ name: "import_ocr_usage" }]);
      expect(
        await db.$queryRaw<Array<{ name: string; notnull: number }>>`
          SELECT name, "notnull"
          FROM pragma_table_info('import_ocr_usage')
          WHERE name IN (
            'response_id',
            'content_purged_at',
            'region',
            'model_version',
            'auth_trace'
          )
          ORDER BY name`,
      ).toEqual([
        { name: "auth_trace", notnull: 0n },
        { name: "content_purged_at", notnull: 0n },
        { name: "model_version", notnull: 0n },
        { name: "region", notnull: 0n },
        { name: "response_id", notnull: 0n },
      ]);
      const checksum = createHash("sha256")
        .update(
          readFileSync(
            join(
              ROOT,
              "prisma/migrations",
              OCR_LEDGER_MIGRATION,
              "migration.sql",
            ),
          ),
        )
        .digest("hex");
      expect(
        await db.$queryRaw<
          Array<{ checksum: string; finished_at: Date | null }>
        >`SELECT checksum, finished_at FROM _prisma_migrations WHERE migration_name = ${OCR_LEDGER_MIGRATION}`,
      ).toEqual([{ checksum, finished_at: expect.any(Date) }]);
      expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it("upgrades a populated legacy-equivalent import database without changing rows", async () => {
    const target = setup(false);
    deploy(target.schema, target.database);
    const db = new PrismaClient({
      datasources: { db: { url: `file:${target.database}` } },
    });
    const now = new Date("2026-10-13T18:00:00.000Z");
    try {
      expect(
        await db.$queryRaw<
          Array<{ checksum: string }>
        >`SELECT checksum FROM _prisma_migrations WHERE migration_name = ${OCR_COLUMN_MIGRATION}`,
      ).toEqual([
        {
          checksum: createHash("sha256")
            .update(
              readFileSync(
                join(
                  ROOT,
                  "prisma/migrations",
                  OCR_COLUMN_MIGRATION,
                  "migration.sql",
                ),
              ),
            )
            .digest("hex"),
        },
      ]);
      const tenantId = (
        await db.tenant.create({ data: { name: "OCR legacy fixture" } })
      ).id;
      const userId = (
        await db.user.create({
          data: {
            tenantId,
            username: randomUUID(),
            name: "OCR legacy fixture",
            role: "ADMIN",
          },
        })
      ).id;
      const projectId = (
        await db.project.create({
          data: { tenantId, name: "OCR legacy fixture", type: "PESSOAL" },
        })
      ).id;
      const cardId = (
        await db.creditCard.create({
          data: {
            tenantId,
            projectId,
            nickname: "OCR",
            institution: "fixture",
            last4: "0719",
          },
        })
      ).id;
      const sessionId = randomUUID();
      await db.$executeRaw`
        INSERT INTO import_sessions (
          id, tenant_id, owner_user_id, owner_project_id, card_id,
          protocol_version, kind, state, revision, create_request_id,
          create_payload_hash, consent_policy_version, consented_at,
          created_at, updated_at, last_user_edit_at, expires_at, draft_json,
          prepare_generation
        ) VALUES (
          ${sessionId}, ${tenantId}, ${userId}, ${projectId}, ${cardId},
          1, 'CREATE_CARD_PURCHASES', 'DRAFT', 1, ${randomUUID()},
          ${"a".repeat(64)}, 1, ${now}, ${now}, ${now}, ${now},
          ${new Date("2026-10-14T18:00:00.000Z")},
          '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
          0
        )`;
      const before = {
        tenant:
          await db.$queryRaw`SELECT * FROM tenants WHERE id = ${tenantId}`,
        user: await db.$queryRaw`SELECT * FROM users WHERE id = ${userId}`,
        project:
          await db.$queryRaw`SELECT * FROM projects WHERE id = ${projectId}`,
        session: await db.$queryRaw`
            SELECT id, tenant_id, owner_project_id, revision, draft_json
            FROM import_sessions WHERE id = ${sessionId}`,
      };
      await db.$disconnect();
      cpSync(
        join(ROOT, "prisma/migrations", OCR_LEDGER_MIGRATION),
        join(target.migrations, OCR_LEDGER_MIGRATION),
        { recursive: true },
      );
      deploy(target.schema, target.database);
      await db.$connect();
      expect({
        tenant:
          await db.$queryRaw`SELECT * FROM tenants WHERE id = ${tenantId}`,
        user: await db.$queryRaw`SELECT * FROM users WHERE id = ${userId}`,
        project:
          await db.$queryRaw`SELECT * FROM projects WHERE id = ${projectId}`,
        session: await db.$queryRaw`
            SELECT id, tenant_id, owner_project_id, revision, draft_json
            FROM import_sessions WHERE id = ${sessionId}`,
      }).toEqual(before);
      expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      expect(
        await db.$queryRaw<Array<{ name: string; notnull: number }>>`
          SELECT name, "notnull"
          FROM pragma_table_info('import_sessions')
          WHERE name = 'ocr_json'`,
      ).toEqual([{ name: "ocr_json", notnull: 0n }]);
      expect(
        await db.$queryRaw<
          Array<{ id: string; ocr_json: string | null }>
        >`SELECT id, ocr_json FROM import_sessions WHERE id = ${sessionId}`,
      ).toEqual([{ id: sessionId, ocr_json: null }]);
      expect(
        await db.$queryRaw`
          SELECT checksum FROM _prisma_migrations
          WHERE migration_name = ${OCR_LEDGER_MIGRATION}`,
      ).toEqual([
        {
          checksum: createHash("sha256")
            .update(
              readFileSync(
                join(
                  ROOT,
                  "prisma/migrations",
                  OCR_LEDGER_MIGRATION,
                  "migration.sql",
                ),
              ),
            )
            .digest("hex"),
        },
      ]);
    } finally {
      await db.$disconnect();
    }
  });
});
