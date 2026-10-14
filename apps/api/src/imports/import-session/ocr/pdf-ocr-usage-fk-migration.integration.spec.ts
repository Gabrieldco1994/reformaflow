import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = resolve(__dirname, "../../../../../..");
const LEDGER_MIGRATION = "20261013183000_import_ocr_usage_budget";
const FK_MIGRATION = "20261013233000_import_ocr_usage_foreign_keys";
const PROVENANCE_MIGRATION = "20261014004500_import_ocr_usage_provenance";
const NOW = new Date("2026-10-13T23:30:00.000Z");

function deploy(schema: string, database: string): void {
  const { NODE_OPTIONS: _externalNodeOptions, ...environment } = process.env;
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
      env: { ...environment, DATABASE_URL: `file:${database}` },
      stdio: "pipe",
    },
  );
}

type LegacyTarget = Readonly<{
  root: string;
  migrations: string;
  schema: string;
  database: string;
}>;

function legacyTarget(fixtures: string[]): LegacyTarget {
  const root = mkdtempSync(join(ROOT, "prisma", ".tmp-ocr-fk-upgrade-"));
  fixtures.push(root);
  const migrations = join(root, "migrations");
  mkdirSync(migrations);
  cpSync(
    join(ROOT, "prisma/migrations/migration_lock.toml"),
    join(migrations, "migration_lock.toml"),
  );
  const committed = readdirSync(join(ROOT, "prisma/migrations"))
    .filter((name) => /^\d/.test(name))
    .sort();
  expect(committed.at(-1)).toBe(PROVENANCE_MIGRATION);
  for (const migration of committed) {
    if (migration >= FK_MIGRATION) continue;
    cpSync(
      join(ROOT, "prisma/migrations", migration),
      join(migrations, migration),
      { recursive: true },
    );
  }
  expect(committed.at(-2)).toBe(FK_MIGRATION);
  expect(committed.at(-3)).toBe(LEDGER_MIGRATION);
  const schema = join(root, "schema.prisma");
  cpSync(join(ROOT, "prisma/schema.prisma"), schema);
  const database = join(root, "ocr-fk-upgrade.db");
  expect(database).not.toContain("dev.db");
  deploy(schema, database);
  return { root, migrations, schema, database };
}

function installFkMigration(target: LegacyTarget): void {
  cpSync(
    join(ROOT, "prisma/migrations", FK_MIGRATION),
    join(target.migrations, FK_MIGRATION),
    { recursive: true },
  );
  deploy(target.schema, target.database);
}

function installProvenanceMigration(target: LegacyTarget): void {
  cpSync(
    join(ROOT, "prisma/migrations", PROVENANCE_MIGRATION),
    join(target.migrations, PROVENANCE_MIGRATION),
    { recursive: true },
  );
  deploy(target.schema, target.database);
}

async function parents(db: PrismaClient, label: string) {
  const tenantId = (
    await db.tenant.create({ data: { name: `OCR FK ${label}` } })
  ).id;
  const userId = (
    await db.user.create({
      data: {
        tenantId,
        username: randomUUID(),
        name: `OCR FK ${label}`,
        role: "ADMIN",
      },
    })
  ).id;
  const ownerProjectId = (
    await db.project.create({
      data: { tenantId, name: `OCR FK ${label}`, type: "PESSOAL" },
    })
  ).id;
  const cardId = (
    await db.creditCard.create({
      data: {
        tenantId,
        projectId: ownerProjectId,
        nickname: "OCR FK",
        institution: "fixture",
        last4: "0719",
      },
    })
  ).id;
  const sessionId = randomUUID();
  const attachmentId = randomUUID();
  const artifactId = randomUUID();
  await db.importSession.create({
    data: {
      id: sessionId,
      tenantId,
      ownerUserId: userId,
      ownerProjectId,
      cardId,
      kind: "CREATE_CARD_PURCHASES",
      state: "DRAFT",
      revision: 1,
      createRequestId: randomUUID(),
      createPayloadHash: "a".repeat(64),
      consentPolicyVersion: 1,
      consentedAt: NOW,
      lastUserEditAt: NOW,
      expiresAt: new Date("2026-10-14T23:30:00.000Z"),
      draftJson:
        '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
    },
  });
  await db.importArtifact.create({
    data: {
      id: artifactId,
      tenantId,
      ownerProjectId,
      documentSha256: "b".repeat(64),
      verifiedBytes: 128,
      detectedFormat: "PDF",
      state: "RAW_READY",
      storageKey: `fixture/${artifactId}`,
    },
  });
  await db.importSessionArtifact.create({
    data: {
      id: attachmentId,
      tenantId,
      ownerProjectId,
      sessionId,
      artifactId,
      position: 0,
      fileName: "fixture.pdf",
      declaredMime: "application/pdf",
      declaredBytes: 128,
      state: "ATTACHED",
      reservedBytes: 128,
      verifiedAt: NOW,
    },
  });
  return { tenantId, ownerProjectId, sessionId, attachmentId, artifactId };
}

function usageData(
  parent: Awaited<ReturnType<typeof parents>>,
  overrides: Partial<{
    tenantId: string;
    ownerProjectId: string;
    sessionId: string;
    attachmentId: string;
    artifactId: string;
  }> = {},
) {
  return {
    id: randomUUID(),
    day: "2026-10-13",
    tenantId: parent.tenantId,
    ownerProjectId: parent.ownerProjectId,
    actorId: randomUUID(),
    sessionId: parent.sessionId,
    attachmentId: parent.attachmentId,
    artifactId: parent.artifactId,
    artifactSha256: "b".repeat(64),
    requestId: randomUUID(),
    provider: "vertex-ai",
    model: "gemini-2.5-flash",
    reservedCalls: 1,
    reservedPages: 1,
    reservedBytes: 128,
    reservedCostUnits: 32_768,
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    responseId: "response-719",
    outcome: "SUCCEEDED",
    contentPurgedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function insertLegacyUsage(
  db: PrismaClient,
  data: ReturnType<typeof usageData>,
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO import_ocr_usage (
      id, day, tenant_id, owner_project_id, actor_id, session_id,
      attachment_id, artifact_id, artifact_sha256, request_id, provider,
      model, reserved_calls, reserved_pages, reserved_bytes,
      reserved_cost_units, input_tokens, output_tokens, total_tokens,
      response_id, outcome, content_purged_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    data.id,
    data.day,
    data.tenantId,
    data.ownerProjectId,
    data.actorId,
    data.sessionId,
    data.attachmentId,
    data.artifactId,
    data.artifactSha256,
    data.requestId,
    data.provider,
    data.model,
    data.reservedCalls,
    data.reservedPages,
    data.reservedBytes,
    data.reservedCostUnits,
    data.inputTokens,
    data.outputTokens,
    data.totalTokens,
    data.responseId,
    data.outcome,
    data.contentPurgedAt,
    data.createdAt,
    data.updatedAt,
  );
}

async function rawUsageRows(db: PrismaClient) {
  return db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'SELECT * FROM "import_ocr_usage" ORDER BY "id"',
  );
}

describe("ImportOcrUsage additive foreign-key migration", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0))
      rmSync(fixture, { recursive: true, force: true });
  });

  it("declares the exact tenant-scoped Restrict foreign-key groups", async () => {
    const target = legacyTarget(fixtures);
    installFkMigration(target);
    const db = new PrismaClient({
      datasources: { db: { url: `file:${target.database}` } },
    });
    try {
      const rows = await db.$queryRawUnsafe<
        Array<{
          id: bigint;
          seq: bigint;
          table: string;
          from: string;
          to: string;
          on_update: string;
          on_delete: string;
        }>
      >("PRAGMA foreign_key_list('import_ocr_usage')");
      const groups = new Map<
        string,
        {
          table: string;
          columns: Array<{ from: string; to: string; seq: number }>;
          onUpdate: string;
          onDelete: string;
        }
      >();
      for (const row of rows) {
        const key = String(row.id);
        const group = groups.get(key) ?? {
          table: row.table,
          columns: [],
          onUpdate: row.on_update,
          onDelete: row.on_delete,
        };
        group.columns.push({
          from: row.from,
          to: row.to,
          seq: Number(row.seq),
        });
        groups.set(key, group);
      }
      expect(
        [...groups.values()]
          .map((group) => ({
            table: group.table,
            columns: group.columns
              .sort((left, right) => left.seq - right.seq)
              .map(({ from, to }) => [from, to]),
            onUpdate: group.onUpdate,
            onDelete: group.onDelete,
          }))
          .sort((left, right) => left.table.localeCompare(right.table)),
      ).toEqual(
        [
          {
            table: "tenants",
            columns: [["tenant_id", "id"]],
            onUpdate: "RESTRICT",
            onDelete: "RESTRICT",
          },
          {
            table: "import_sessions",
            columns: [
              ["tenant_id", "tenant_id"],
              ["owner_project_id", "owner_project_id"],
              ["session_id", "id"],
            ],
            onUpdate: "RESTRICT",
            onDelete: "RESTRICT",
          },
          {
            table: "import_session_artifacts",
            columns: [
              ["tenant_id", "tenant_id"],
              ["owner_project_id", "owner_project_id"],
              ["session_id", "session_id"],
              ["attachment_id", "id"],
            ],
            onUpdate: "RESTRICT",
            onDelete: "RESTRICT",
          },
          {
            table: "import_artifacts",
            columns: [
              ["tenant_id", "tenant_id"],
              ["owner_project_id", "owner_project_id"],
              ["artifact_id", "id"],
            ],
            onUpdate: "RESTRICT",
            onDelete: "RESTRICT",
          },
        ].sort((left, right) => left.table.localeCompare(right.table)),
      );
      expect(
        await db.$queryRawUnsafe<Array<{ name: string; unique: bigint }>>(
          "SELECT name, \"unique\" FROM pragma_index_list('import_ocr_usage') ORDER BY name",
        ),
      ).toEqual([
        { name: "import_ocr_usage_day_idx", unique: 0n },
        { name: "import_ocr_usage_day_tenant_id_actor_id_idx", unique: 0n },
        { name: "import_ocr_usage_day_tenant_id_idx", unique: 0n },
        {
          name: "import_ocr_usage_tenant_id_session_id_attachment_id_key",
          unique: 1n,
        },
        { name: "sqlite_autoindex_import_ocr_usage_1", unique: 1n },
      ]);
      expect(
        await db.$queryRawUnsafe<Array<{ unique: bigint }>>(
          `SELECT "unique" FROM pragma_index_list('import_session_artifacts')
           WHERE name = 'import_session_artifacts_tenant_id_owner_project_id_session_id_id_key'`,
        ),
      ).toEqual([{ unique: 1n }]);
    } finally {
      await db.$disconnect();
    }
  });

  it("upgrades a populated post-FK ledger with nullable provenance", async () => {
    const target = legacyTarget(fixtures);
    const db = new PrismaClient({
      datasources: { db: { url: `file:${target.database}` } },
    });
    try {
      const parent = await parents(db, "valid");
      await insertLegacyUsage(db, usageData(parent));
      const before = await rawUsageRows(db);
      await db.$disconnect();
      installFkMigration(target);
      await db.$connect();
      expect(await rawUsageRows(db)).toEqual(before);
      expect(await db.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
      await db.$disconnect();
      installProvenanceMigration(target);
      await db.$connect();
      expect(
        await db.$queryRawUnsafe<
          Array<{
            id: string;
            region: string | null;
            model_version: string | null;
            auth_trace: string | null;
          }>
        >("SELECT id, region, model_version, auth_trace FROM import_ocr_usage"),
      ).toEqual([
        {
          id: before[0]!.id,
          region: null,
          model_version: null,
          auth_trace: null,
        },
      ]);
      expect(await db.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
      const migrationSql = readFileSync(
        join(ROOT, "prisma/migrations", FK_MIGRATION, "migration.sql"),
        "utf8",
      );
      expect(migrationSql).not.toMatch(/foreign_keys\s*=\s*off/i);
    } finally {
      await db.$disconnect();
    }
  });

  it.each(["orphan", "cross-tenant"] as const)(
    "rejects a populated %s ledger without synthesizing or repairing parents",
    async (scenario) => {
      const target = legacyTarget(fixtures);
      const db = new PrismaClient({
        datasources: { db: { url: `file:${target.database}` } },
      });
      const parent = await parents(db, `${scenario}-owner`);
      const other = await parents(db, `${scenario}-other`);
      const invalid =
        scenario === "orphan"
          ? usageData(parent, { tenantId: randomUUID() })
          : usageData(parent, {
              sessionId: other.sessionId,
              attachmentId: other.attachmentId,
              artifactId: other.artifactId,
            });
      await insertLegacyUsage(db, invalid);
      const before = await rawUsageRows(db);
      await db.$disconnect();
      cpSync(
        join(ROOT, "prisma/migrations", FK_MIGRATION),
        join(target.migrations, FK_MIGRATION),
        { recursive: true },
      );

      expect(() => deploy(target.schema, target.database)).toThrow();
      await db.$connect();
      try {
        expect(await rawUsageRows(db)).toEqual(before);
        expect(await db.tenant.count()).toBe(2);
        expect(await db.importSession.count()).toBe(2);
        expect(await db.importSessionArtifact.count()).toBe(2);
        expect(await db.importArtifact.count()).toBe(2);
      } finally {
        await db.$disconnect();
      }
    },
  );

  it("restricts physical parent deletion and leaves foreign_key_check empty", async () => {
    const target = legacyTarget(fixtures);
    const db = new PrismaClient({
      datasources: { db: { url: `file:${target.database}` } },
    });
    const parent = await parents(db, "delete-restrict");
    await insertLegacyUsage(db, usageData(parent));
    await db.$disconnect();
    installFkMigration(target);
    await db.$connect();
    try {
      await expect(
        db.$executeRaw`DELETE FROM "tenants" WHERE "id" = ${parent.tenantId}`,
      ).rejects.toThrow();
      await expect(
        db.$executeRaw`DELETE FROM "import_sessions" WHERE "id" = ${parent.sessionId}`,
      ).rejects.toThrow();
      await expect(
        db.$executeRaw`DELETE FROM "import_session_artifacts" WHERE "id" = ${parent.attachmentId}`,
      ).rejects.toThrow();
      await expect(
        db.$executeRaw`DELETE FROM "import_artifacts" WHERE "id" = ${parent.artifactId}`,
      ).rejects.toThrow();
      expect(
        await db.importSessionArtifact.count({
          where: { id: parent.attachmentId },
        }),
      ).toBe(1);
      expect(await db.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });
});
