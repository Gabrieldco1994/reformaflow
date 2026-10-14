import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const FK_MIGRATION = "20261013233000_import_ocr_usage_foreign_keys";

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

type ForeignKeyRow = {
  id: bigint;
  seq: bigint;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
};

function normalizedForeignKeys(rows: ForeignKeyRow[]) {
  const grouped = new Map<
    string,
    {
      table: string;
      from: string[];
      to: string[];
      onUpdate: string;
      onDelete: string;
    }
  >();
  for (const row of rows) {
    const key = String(row.id);
    const current = grouped.get(key) ?? {
      table: row.table,
      from: [],
      to: [],
      onUpdate: row.on_update,
      onDelete: row.on_delete,
    };
    current.from[Number(row.seq)] = row.from;
    current.to[Number(row.seq)] = row.to;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    `${left.table}:${left.from.join(",")}`.localeCompare(
      `${right.table}:${right.from.join(",")}`,
    ),
  );
}

describe("final #719 OCR ledger migration barrier", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0))
      rmSync(fixture, { recursive: true, force: true });
  });

  function setup() {
    const fixture = mkdtempSync(join(ROOT, "prisma", ".tmp-ocr-final-fk-"));
    fixtures.push(fixture);
    const migrations = join(fixture, "migrations");
    mkdirSync(migrations);
    cpSync(
      join(ROOT, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    for (const migration of readdirSync(join(ROOT, "prisma/migrations"))
      .filter((name) => /^\d/.test(name))
      .sort())
      cpSync(
        join(ROOT, "prisma/migrations", migration),
        join(migrations, migration),
        { recursive: true },
      );
    const schema = join(fixture, "schema.prisma");
    cpSync(join(ROOT, "prisma/schema.prisma"), schema);
    const database = join(fixture, "ocr-final-fk.db");
    expect(database).not.toContain("dev.db");
    deploy(schema, database);
    return new PrismaClient({
      datasources: { db: { url: `file:${database}` } },
    });
  }

  function setupThrough(cutoff: string) {
    const fixture = mkdtempSync(join(ROOT, "prisma", ".tmp-ocr-provenance-"));
    fixtures.push(fixture);
    const migrations = join(fixture, "migrations");
    mkdirSync(migrations);
    cpSync(
      join(ROOT, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    for (const migration of readdirSync(join(ROOT, "prisma/migrations"))
      .filter((name) => /^\d/.test(name) && name <= cutoff)
      .sort())
      cpSync(
        join(ROOT, "prisma/migrations", migration),
        join(migrations, migration),
        { recursive: true },
      );
    const schema = join(fixture, "schema.prisma");
    cpSync(join(ROOT, "prisma/schema.prisma"), schema);
    const database = join(fixture, "ocr-provenance-upgrade.db");
    expect(database).not.toContain("dev.db");
    deploy(schema, database);
    return { migrations, schema, database };
  }

  it("pins one post-FK additive migration with only the three nullable provenance columns", () => {
    const migrationsRoot = join(ROOT, "prisma/migrations");
    const postFk = readdirSync(migrationsRoot)
      .filter(
        (name) =>
          /^\d/.test(name) &&
          name > "20261013233000_import_ocr_usage_foreign_keys",
      )
      .sort();
    expect(postFk).toHaveLength(1);
    const sql = readFileSync(
      join(migrationsRoot, postFk[0]!, "migration.sql"),
      "utf8",
    ).trim();
    expect(sql).toBe(
      [
        'ALTER TABLE "import_ocr_usage" ADD COLUMN "model_version" TEXT;',
        'ALTER TABLE "import_ocr_usage" ADD COLUMN "region" TEXT;',
        'ALTER TABLE "import_ocr_usage" ADD COLUMN "auth_trace" TEXT;',
      ].join("\n"),
    );
    expect(sql).not.toMatch(
      /DEFAULT|UPDATE|INSERT|DELETE|DROP|RENAME|CREATE TABLE|GOOGLE_VERTEX_AI|gemini|southamerica|LOCAL_ADC|SERVICE_ACCOUNT_FILE_ADC/i,
    );
  });

  it("deploys the provenance migration fresh as exactly three nullable additions without changing FKs", async () => {
    const db = setup();
    try {
      const columns = await db.$queryRawUnsafe<
        Array<{ name: string; notnull: bigint; dflt_value: string | null }>
      >(
        `SELECT name, "notnull", dflt_value
         FROM pragma_table_info('import_ocr_usage')
         WHERE name IN ('model_version', 'region', 'auth_trace')
         ORDER BY name`,
      );
      expect(columns).toEqual([
        { name: "auth_trace", notnull: 0n, dflt_value: null },
        { name: "model_version", notnull: 0n, dflt_value: null },
        { name: "region", notnull: 0n, dflt_value: null },
      ]);
      expect(
        normalizedForeignKeys(
          await db.$queryRawUnsafe<ForeignKeyRow[]>(`
            SELECT id, seq, "table", "from", "to", on_update, on_delete
            FROM pragma_foreign_key_list('import_ocr_usage')
            ORDER BY id, seq
          `),
        ),
      ).toEqual([
        {
          table: "import_artifacts",
          from: ["tenant_id", "owner_project_id", "artifact_id"],
          to: ["tenant_id", "owner_project_id", "id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
        {
          table: "import_session_artifacts",
          from: [
            "tenant_id",
            "owner_project_id",
            "session_id",
            "attachment_id",
          ],
          to: ["tenant_id", "owner_project_id", "session_id", "id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
        {
          table: "import_sessions",
          from: ["tenant_id", "owner_project_id", "session_id"],
          to: ["tenant_id", "owner_project_id", "id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
        {
          table: "tenants",
          from: ["tenant_id"],
          to: ["id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
      ]);
      expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it("upgrades a post-FK successful legacy row without synthesizing provenance or changing constraints", async () => {
    const target = setupThrough(FK_MIGRATION);
    const legacy = new PrismaClient({
      datasources: { db: { url: `file:${target.database}` } },
    });
    const ids = {
      tenant: randomUUID(),
      user: randomUUID(),
      project: randomUUID(),
      card: randomUUID(),
      session: randomUUID(),
      artifact: randomUUID(),
      attachment: randomUUID(),
      usage: randomUUID(),
      request: randomUUID(),
    };
    const now = new Date("2026-10-13T20:00:00.000Z");
    try {
      await legacy.tenant.create({
        data: { id: ids.tenant, name: "OCR provenance legacy tenant" },
      });
      await legacy.user.create({
        data: {
          id: ids.user,
          tenantId: ids.tenant,
          username: "ocr-provenance-legacy",
          name: "OCR provenance legacy",
          role: "ADMIN",
        },
      });
      await legacy.project.create({
        data: {
          id: ids.project,
          tenantId: ids.tenant,
          name: "OCR provenance legacy",
          type: "PESSOAL",
        },
      });
      await legacy.creditCard.create({
        data: {
          id: ids.card,
          tenantId: ids.tenant,
          projectId: ids.project,
          nickname: "OCR provenance legacy",
          institution: "fixture",
          last4: "0719",
        },
      });
      await legacy.importSession.create({
        data: {
          id: ids.session,
          tenantId: ids.tenant,
          ownerUserId: ids.user,
          ownerProjectId: ids.project,
          cardId: ids.card,
          kind: "CREATE_CARD_PURCHASES",
          state: "DRAFT",
          revision: 1,
          createRequestId: randomUUID(),
          createPayloadHash: "a".repeat(64),
          consentPolicyVersion: 1,
          consentedAt: now,
          lastUserEditAt: now,
          expiresAt: new Date("2026-10-20T20:00:00.000Z"),
          draftJson:
            '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
        },
      });
      await legacy.importArtifact.create({
        data: {
          id: ids.artifact,
          tenantId: ids.tenant,
          ownerProjectId: ids.project,
          documentSha256: "b".repeat(64),
          verifiedBytes: 128,
          detectedFormat: "PDF",
          state: "RAW_READY",
        },
      });
      await legacy.importSessionArtifact.create({
        data: {
          id: ids.attachment,
          tenantId: ids.tenant,
          ownerProjectId: ids.project,
          sessionId: ids.session,
          artifactId: ids.artifact,
          position: 0,
          fileName: "legacy.pdf",
          declaredMime: "application/pdf",
          declaredBytes: 128,
          state: "ATTACHED",
          reservedBytes: 128,
          verifiedAt: now,
        },
      });
      await legacy.$executeRawUnsafe(
        `INSERT INTO import_ocr_usage (
           id, day, tenant_id, owner_project_id, actor_id, session_id,
           attachment_id, artifact_id, artifact_sha256, request_id,
           provider, model, reserved_calls, reserved_pages, reserved_bytes,
           reserved_cost_units, input_tokens, output_tokens, total_tokens,
           response_id, outcome, content_purged_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ids.usage,
        "2026-10-13",
        ids.tenant,
        ids.project,
        ids.user,
        ids.session,
        ids.attachment,
        ids.artifact,
        "b".repeat(64),
        ids.request,
        "GOOGLE_VERTEX_AI",
        "gemini-2.5-flash",
        1,
        1,
        128,
        128,
        20,
        10,
        30,
        "legacy-response-719",
        "SUCCEEDED",
        null,
        now.toISOString(),
        now.toISOString(),
      );
    } finally {
      await legacy.$disconnect();
    }

    const postFk = readdirSync(join(ROOT, "prisma/migrations"))
      .filter((name) => /^\d/.test(name) && name > FK_MIGRATION)
      .sort();
    expect(postFk).toHaveLength(1);
    cpSync(
      join(ROOT, "prisma/migrations", postFk[0]!),
      join(target.migrations, postFk[0]!),
      { recursive: true },
    );
    deploy(target.schema, target.database);

    const upgraded = new PrismaClient({
      datasources: { db: { url: `file:${target.database}` } },
    });
    try {
      expect(
        await upgraded.$queryRawUnsafe(
          `SELECT id, outcome, request_id, response_id, input_tokens,
                  output_tokens, total_tokens, model_version, region, auth_trace
           FROM import_ocr_usage WHERE id = ?`,
          ids.usage,
        ),
      ).toEqual([
        {
          id: ids.usage,
          outcome: "SUCCEEDED",
          request_id: ids.request,
          response_id: "legacy-response-719",
          input_tokens: 20,
          output_tokens: 10,
          total_tokens: 30,
          model_version: null,
          region: null,
          auth_trace: null,
        },
      ]);
      expect(await upgraded.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    } finally {
      await upgraded.$disconnect();
    }
  });

  it("declares every tenant-composite ledger relationship as RESTRICT", async () => {
    const db = setup();
    try {
      const rows = await db.$queryRawUnsafe<ForeignKeyRow[]>(`
        SELECT id, seq, "table", "from", "to", on_update, on_delete
        FROM pragma_foreign_key_list('import_ocr_usage')
        ORDER BY id, seq
      `);
      expect(normalizedForeignKeys(rows)).toEqual([
        {
          table: "import_artifacts",
          from: ["tenant_id", "owner_project_id", "artifact_id"],
          to: ["tenant_id", "owner_project_id", "id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
        {
          table: "import_session_artifacts",
          from: [
            "tenant_id",
            "owner_project_id",
            "session_id",
            "attachment_id",
          ],
          to: ["tenant_id", "owner_project_id", "session_id", "id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
        {
          table: "import_sessions",
          from: ["tenant_id", "owner_project_id", "session_id"],
          to: ["tenant_id", "owner_project_id", "id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
        {
          table: "tenants",
          from: ["tenant_id"],
          to: ["id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
      ]);
      expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it("accepts a coherent ledger row but rejects orphan and cross-tenant rows", async () => {
    const db = setup();
    const now = new Date("2026-10-13T20:00:00.000Z");
    try {
      const tenantA = (
        await db.tenant.create({ data: { name: "OCR FK tenant A" } })
      ).id;
      const tenantB = (
        await db.tenant.create({ data: { name: "OCR FK tenant B" } })
      ).id;
      const actorA = (
        await db.user.create({
          data: {
            tenantId: tenantA,
            username: "ocr-fk-actor-a",
            name: "OCR FK actor A",
            role: "ADMIN",
          },
        })
      ).id;
      await db.user.create({
        data: {
          tenantId: tenantB,
          username: "ocr-fk-actor-b",
          name: "OCR FK actor B",
          role: "ADMIN",
        },
      });
      const projectA = (
        await db.project.create({
          data: {
            tenantId: tenantA,
            name: "OCR FK project A",
            type: "PESSOAL",
          },
        })
      ).id;
      await db.project.create({
        data: {
          tenantId: tenantB,
          name: "OCR FK project B",
          type: "PESSOAL",
        },
      });
      const cardA = (
        await db.creditCard.create({
          data: {
            tenantId: tenantA,
            projectId: projectA,
            nickname: "OCR FK",
            institution: "fixture",
            last4: "0719",
          },
        })
      ).id;
      const sessionA = randomUUID();
      await db.importSession.create({
        data: {
          id: sessionA,
          tenantId: tenantA,
          ownerUserId: actorA,
          ownerProjectId: projectA,
          cardId: cardA,
          kind: "CREATE_CARD_PURCHASES",
          state: "DRAFT",
          revision: 1,
          createRequestId: randomUUID(),
          createPayloadHash: "a".repeat(64),
          consentPolicyVersion: 1,
          consentedAt: now,
          lastUserEditAt: now,
          expiresAt: new Date("2026-10-20T20:00:00.000Z"),
          draftJson:
            '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
        },
      });
      const artifactA = (
        await db.importArtifact.create({
          data: {
            tenantId: tenantA,
            ownerProjectId: projectA,
            documentSha256: "b".repeat(64),
            verifiedBytes: 10,
            detectedFormat: "PDF",
            state: "RAW_READY",
          },
        })
      ).id;
      const attachmentA = (
        await db.importSessionArtifact.create({
          data: {
            tenantId: tenantA,
            ownerProjectId: projectA,
            sessionId: sessionA,
            artifactId: artifactA,
            position: 0,
            fileName: "scan.pdf",
            declaredMime: "application/pdf",
            declaredBytes: 10,
            state: "ATTACHED",
            reservedBytes: 10,
            verifiedAt: now,
          },
        })
      ).id;

      const insert = (
        id: string,
        tenantId: string,
        ownerProjectId: string,
        actorId: string,
        sessionId: string,
        attachmentId: string,
        artifactId: string,
      ) =>
        db.$executeRawUnsafe(
          `INSERT INTO import_ocr_usage (
            id, day, tenant_id, owner_project_id, actor_id, session_id,
            attachment_id, artifact_id, artifact_sha256, request_id,
            provider, model, reserved_calls, reserved_pages, reserved_bytes,
            reserved_cost_units, outcome, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          "2026-10-13",
          tenantId,
          ownerProjectId,
          actorId,
          sessionId,
          attachmentId,
          artifactId,
          "b".repeat(64),
          randomUUID(),
          "GOOGLE_VERTEX_AI",
          "gemini-2.5-flash",
          1,
          1,
          10,
          32_768,
          "ATTEMPTED",
          now,
          now,
        );

      await expect(
        insert(
          randomUUID(),
          tenantA,
          projectA,
          actorA,
          sessionA,
          attachmentA,
          artifactA,
        ),
      ).resolves.toBe(1);
      const rejectedScopes = await Promise.allSettled([
        insert(
          randomUUID(),
          tenantA,
          projectA,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ),
        insert(
          randomUUID(),
          tenantB,
          projectA,
          actorA,
          sessionA,
          attachmentA,
          artifactA,
        ),
      ]);
      expect(rejectedScopes.map(({ status }) => status)).toEqual([
        "rejected",
        "rejected",
      ]);
    } finally {
      await db.$disconnect();
    }
  });
});
