import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = resolve(__dirname, "../../../../../..");

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
          from: ["tenant_id", "owner_project_id", "attachment_id"],
          to: ["tenant_id", "owner_project_id", "id"],
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
          table: "projects",
          from: ["tenant_id", "owner_project_id"],
          to: ["tenant_id", "id"],
          onUpdate: "RESTRICT",
          onDelete: "RESTRICT",
        },
        {
          table: "users",
          from: ["tenant_id", "actor_id"],
          to: ["tenant_id", "id"],
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
