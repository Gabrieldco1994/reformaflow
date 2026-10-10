import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { PrismaService } from "./prisma.service";

/**
 * QA complement to migrations-import-session-bootstrap-upgrade.spec.ts. That spec proves
 * the 69 -> 70 upgrade leaves legacy rows and structure untouched. This one proves the
 * UPGRADED legacy database actually enforces the new relations over the pre-existing
 * rows (parent unique indexes are usable on legacy data, RESTRICT is the new FK's doing,
 * cross-tenant/anchor references are rejected) with the real PrismaService and
 * foreign_keys ON. Only synthetic rows; disposable SQLite inside the worktree.
 */

const root = resolve(__dirname, "../../../..");
const migration = "20260929010000_import_session_bootstrap";
const instant = new Date("2026-09-01T12:00:00.000Z");
const emptyDraft =
  '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}';
const legacyTables = [
  "tenants",
  "users",
  "projects",
  "credit_cards",
  "expenses",
  "receipts",
  "cash_flow_entries",
];

it("enforces the new relations, RESTRICT and parent indexes over an upgraded legacy database", async () => {
  const guard = require("../../../../scripts/test-db-env.cjs");
  const directory = join(
    root,
    "prisma",
    `test-import-session-upgrade-behavior-${randomUUID()}`,
  );
  const previousUrl = process.env.DATABASE_URL;
  let db: PrismaService | undefined;
  mkdirSync(directory);
  try {
    const url = `file:${join(directory, "test-upgrade.db")}`;
    expect(guard.forbiddenReason(url)).toBeNull();
    const migrations = join(directory, "migrations");
    mkdirSync(migrations);
    cpSync(
      join(root, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    const legacyNames = readdirSync(join(root, "prisma/migrations")).filter(
      (name) => /^\d/.test(name) && name < migration,
    );
    expect(legacyNames).toHaveLength(69);
    for (const name of legacyNames)
      cpSync(join(root, "prisma/migrations", name), join(migrations, name), {
        recursive: true,
      });
    const schema = join(directory, "schema.prisma");
    writeFileSync(schema, readFileSync(join(root, "prisma/schema.prisma")));
    const deploy = (): void => {
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url };
      delete env.NODE_OPTIONS;
      delete env.JEST_WORKER_ID;
      execFileSync(
        process.execPath,
        [
          require.resolve("prisma/build/index.js"),
          "migrate",
          "deploy",
          "--schema",
          schema,
        ],
        { cwd: root, env, stdio: "pipe" },
      );
    };
    deploy();
    process.env.DATABASE_URL = url;
    db = new PrismaService();
    await db.$connect();
    const connection = db;

    // --- legacy fixture (pre-upgrade state, written through the real middleware) ---
    await connection.tenant.create({
      data: { id: "lg-tenant", name: "Legacy" },
    });
    await connection.tenant.create({ data: { id: "lg-other", name: "Other" } });
    for (const id of ["lg-user", "lg-user-free"])
      await connection.user.create({
        data: { id, tenantId: "lg-tenant", username: id, name: id },
      });
    await connection.user.create({
      data: {
        id: "lg-other-user",
        tenantId: "lg-other",
        username: "o",
        name: "o",
      },
    });
    for (const id of ["lg-project", "lg-sibling"])
      await connection.project.create({
        data: { id, tenantId: "lg-tenant", name: id, type: "PESSOAL" },
      });
    await connection.project.create({
      data: {
        id: "lg-other-project",
        tenantId: "lg-other",
        name: "o",
        type: "PESSOAL",
      },
    });
    for (const [id, projectId] of [
      ["lg-card", "lg-project"],
      ["lg-card-free", "lg-project"],
      ["lg-sibling-card", "lg-sibling"],
    ])
      await connection.creditCard.create({
        data: {
          id,
          tenantId: "lg-tenant",
          projectId,
          institution: "OUTROS",
          nickname: id,
          last4: "1234",
        },
      });
    // Raw SQL on purpose: this DB holds the 69 legacy migrations and the current
    // Prisma client also writes columns added by later migrations.
    await connection.$executeRaw`INSERT INTO expenses
      (id, tenant_id, project_id, tipo_despesa, valor, valor_total, forma_pagamento, status, updated_at)
      VALUES ('lg-expense', 'lg-tenant', 'lg-project', 'OUTROS', 69840, 69840, 'A_VISTA', 'PAGO', 1)`;
    await connection.receipt.create({
      data: {
        id: "lg-receipt",
        tenantId: "lg-tenant",
        projectId: "lg-project",
        valor: 100000,
        data: instant,
        tipo: "PAGAMENTO",
      },
    });
    // Deleted history in the same tenant: FKs must not care about deletedAt.
    await connection.project.create({
      data: {
        id: "lg-deleted-project",
        tenantId: "lg-tenant",
        name: "deleted",
        type: "PESSOAL",
        deletedAt: instant,
      },
    });

    const raw = async (): Promise<Record<string, unknown[]>> => {
      const out: Record<string, unknown[]> = {};
      for (const table of legacyTables)
        out[table] = await connection.$queryRawUnsafe(
          `SELECT * FROM "${table}" ORDER BY "id"`,
        );
      return out;
    };
    const before = await raw();
    expect(before.expenses).toHaveLength(1);
    expect(before.projects).toHaveLength(4);
    expect(await connection.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    await connection.$disconnect();

    // --- upgrade 69 -> 70 ---
    cpSync(
      join(root, "prisma/migrations", migration),
      join(migrations, migration),
      { recursive: true },
    );
    deploy();
    await connection.$connect();

    expect(await raw()).toEqual(before); // every legacy column, incl. soft-deleted rows
    expect(await connection.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    expect(await connection.$queryRaw`PRAGMA integrity_check`).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(await connection.$queryRaw`PRAGMA foreign_keys`).toEqual([
      { foreign_keys: 1n },
    ]);
    expect(
      await connection.$queryRaw`SELECT COUNT(*) AS total FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    ).toEqual([{ total: 70n }]);

    const session = (over: Record<string, unknown> = {}) => ({
      tenantId: "lg-tenant",
      ownerUserId: "lg-user",
      ownerProjectId: "lg-project",
      cardId: "lg-card",
      kind: "CREATE_CARD_PURCHASES",
      state: "DRAFT",
      revision: 1,
      createRequestId: randomUUID(),
      createPayloadHash: "a".repeat(64),
      consentPolicyVersion: 1,
      consentedAt: instant,
      lastUserEditAt: instant,
      expiresAt: new Date("2026-09-08T12:00:00.000Z"),
      draftJson: emptyDraft,
      ...over,
    });

    // The new parent unique indexes are usable over legacy data: legacy parents bind.
    const created = await connection.importSession.create({ data: session() });
    expect(created.ownerProjectId).toBe("lg-project");
    // Pin: the FK ignores deletedAt (retention is a SERVICE concern). A future service must
    // recheck deletedAt of anchor/card/user itself; the schema will not do it for it.
    await connection.creditCard.create({
      data: {
        id: "lg-deleted-anchor-card",
        tenantId: "lg-tenant",
        projectId: "lg-deleted-project",
        institution: "OUTROS",
        nickname: "c",
        last4: "1234",
      },
    });
    const onDeletedAnchor = await connection.importSession.create({
      data: session({
        ownerProjectId: "lg-deleted-project",
        cardId: "lg-deleted-anchor-card",
      }),
    });
    expect(onDeletedAnchor.ownerProjectId).toBe("lg-deleted-project");

    // Cross-tenant and wrong-anchor parents are rejected against LEGACY rows.
    for (const bad of [
      { ownerUserId: "lg-other-user" },
      { ownerProjectId: "lg-other-project" },
      { tenantId: "lg-other" },
      { cardId: "lg-sibling-card" },
      { ownerProjectId: "lg-sibling" },
    ])
      await expect(
        connection.importSession.create({ data: session(bad) }),
      ).rejects.toMatchObject({ code: "P2003" });

    const artifact = await connection.importArtifact.create({
      data: {
        tenantId: "lg-tenant",
        ownerProjectId: "lg-project",
        documentSha256: "b".repeat(64),
        verifiedBytes: 1,
        detectedFormat: "OFX",
        state: "EXTRACTED",
      },
    });
    // Claims on the LEGACY expense and receipt bind through the new parent indexes.
    const claim = (reference: string, entity: Record<string, string>) =>
      connection.importObservation.create({
        data: {
          tenantId: "lg-tenant",
          ownerProjectId: "lg-project",
          artifactId: artifact.id,
          reference,
          evidenceJson: '{"version":1}',
          canonicalProjectId: "lg-project",
          claimReceiptJson:
            '{"kind":"LEGACY_IMPORT","engine":"CARD","importId":null,"externalId":"x"}',
          claimedAt: instant,
          ...entity,
        },
      });
    const expenseClaim = await claim("expense", {
      canonicalExpenseId: "lg-expense",
    });
    const receiptClaim = await claim("receipt", {
      canonicalReceiptId: "lg-receipt",
    });
    // A legacy expense of ANOTHER project (right tenant, wrong project) is not claimable.
    await expect(
      connection.importObservation.create({
        data: {
          tenantId: "lg-tenant",
          ownerProjectId: "lg-project",
          artifactId: artifact.id,
          reference: "wrong-project",
          evidenceJson: '{"version":1}',
          canonicalProjectId: "lg-sibling",
          canonicalExpenseId: "lg-expense",
          claimReceiptJson: '{"kind":"SESSION"}',
          claimedAt: instant,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    // RESTRICT (never CASCADE/SET NULL) on every legacy parent that now has a dependent.
    const restricted = async (sql: string): Promise<void> => {
      await expect(connection.$executeRawUnsafe(sql)).rejects.toThrow(
        /FOREIGN KEY constraint failed/i,
      );
    };
    await restricted(`DELETE FROM "expenses" WHERE "id" = 'lg-expense'`);
    await restricted(`DELETE FROM "receipts" WHERE "id" = 'lg-receipt'`);
    await restricted(`DELETE FROM "projects" WHERE "id" = 'lg-project'`);
    await restricted(`DELETE FROM "users" WHERE "id" = 'lg-user'`);
    await restricted(`DELETE FROM "credit_cards" WHERE "id" = 'lg-card'`);
    await restricted(
      `UPDATE "expenses" SET "id" = 'lg-renamed' WHERE "id" = 'lg-expense'`,
    );
    await restricted(
      `UPDATE "users" SET "id" = 'lg-renamed' WHERE "id" = 'lg-user'`,
    );
    // The 69 -> 70 upgrade and every raw constraint proof are done. The ORM
    // proofs below use the current Prisma client, which also reads the columns
    // of the migrations that follow the bootstrap.
    await connection.$disconnect();
    for (const name of readdirSync(join(root, "prisma/migrations")).sort()) {
      if (/^\d/.test(name) && name > migration)
        cpSync(join(root, "prisma/migrations", name), join(migrations, name), {
          recursive: true,
        });
    }
    deploy();
    await connection.$connect();
    expect(
      await connection.expense.findUnique({ where: { id: "lg-expense" } }),
    ).not.toBeNull();
    // The middleware still soft-deletes financial parents: retention, not cascade.
    await connection.expense.delete({ where: { id: "lg-expense" } });
    expect(
      (
        await connection.expense.findUniqueOrThrow({
          where: { id: "lg-expense" },
        })
      ).deletedAt,
    ).not.toBeNull();
    expect(
      (
        await connection.importObservation.findUniqueOrThrow({
          where: { id: expenseClaim.id },
        })
      ).canonicalExpenseId,
    ).toBe("lg-expense");

    // Prove the block is the NEW dependency: a legacy user/card nothing else references
    // becomes deletable the moment its session is gone, and not before.
    const free = await connection.importSession.create({
      data: session({ ownerUserId: "lg-user-free", cardId: "lg-card-free" }),
    });
    await restricted(`DELETE FROM "users" WHERE "id" = 'lg-user-free'`);
    await restricted(`DELETE FROM "credit_cards" WHERE "id" = 'lg-card-free'`);
    await connection.importSession.delete({ where: { id: free.id } }); // real DELETE, no soft-delete
    expect(
      await connection.importSession.count({ where: { id: free.id } }),
    ).toBe(0);
    expect(
      await connection.$executeRawUnsafe(
        `DELETE FROM "credit_cards" WHERE "id" = 'lg-card-free'`,
      ),
    ).toBe(1);
    expect(
      await connection.$executeRawUnsafe(
        `DELETE FROM "users" WHERE "id" = 'lg-user-free'`,
      ),
    ).toBe(1);

    expect(receiptClaim.canonicalReceiptId).toBe("lg-receipt");
    await connection.importSession.delete({ where: { id: created.id } });
    expect(await connection.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  } finally {
    await db?.$disconnect();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    rmSync(directory, { recursive: true, force: true });
  }
}, 90000);
