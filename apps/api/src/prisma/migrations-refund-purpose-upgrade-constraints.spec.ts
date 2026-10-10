require("../../../../scripts/test-db-env.cjs");
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * #704 migration 71 over a database that really went through 1..70 (bootstrap
 * included), seeded with legacy rows and a bootstrap claim on a legacy expense.
 * Proves what the byte-level upgrade spec does not: the schema delta is exactly
 * the two columns + one partial index, prior migration history is untouched, the
 * bootstrap RESTRICT still guards the claimed expense, and the new CHECK and
 * partial UNIQUE index actually reject bad rows on the upgraded database.
 * Structural equivalent of a legacy database, disposable SQLite, no dev.db.
 */
const root = resolve(__dirname, "../../../..");
const migration = "20260929020000_refund_purpose";
const bootstrap = "20260929010000_import_session_bootstrap";
const tenant = "legacy-constraints-tenant";

it("#704 migration 71 applies over 70 with an exact schema delta, intact history and enforcing constraints", async () => {
  const guard = require("../../../../scripts/test-db-env.cjs");
  const directory = join(
    root,
    "prisma",
    `test-refund-constraints-${randomUUID()}`,
  );
  let db: PrismaClient | undefined;
  mkdirSync(directory);
  try {
    const url = `file:${join(directory, "test-refund-constraints.db")}`;
    expect(guard.forbiddenReason(url)).toBeNull();
    const migrations = join(directory, "migrations");
    mkdirSync(migrations);
    cpSync(
      join(root, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    const names = readdirSync(join(root, "prisma/migrations"))
      .filter((name) => /^\d/.test(name))
      .sort();
    // Historical #704 fixture: it is scoped to the folders up to its own
    // migration (71), so later migrations may exist on disk without changing it.
    const throughMigration = names.filter((name) => name <= migration);
    expect(throughMigration.slice(-2)).toEqual([bootstrap, migration]);
    expect(throughMigration).toHaveLength(71);
    for (const name of names.filter((n) => n < migration))
      cpSync(join(root, "prisma/migrations", name), join(migrations, name), {
        recursive: true,
      });
    const schema = join(directory, "schema.prisma");
    cpSync(join(root, "prisma/schema.prisma"), schema);
    const deploy = () =>
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
          cwd: root,
          env: { ...process.env, DATABASE_URL: url },
          stdio: "pipe",
        },
      );
    deploy();
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");

    // ── legacy data at migration 70, plus a bootstrap claim on a legacy expense
    await db.tenant.create({ data: { id: tenant, name: "Synthetic legacy" } });
    for (const [id, type] of [
      ["lc-personal", "PESSOAL"],
      ["lc-renovation", "REFORMA"],
    ])
      await db.project.create({
        data: { id, type, tenantId: tenant, name: id },
      });
    for (const [id, project, amount] of [
      ["lc-claimed", "lc-personal", -12345],
      ["lc-other", "lc-personal", -700],
      ["lc-t1", "lc-renovation", -12345],
      ["lc-t2", "lc-renovation", -700],
      ["lc-t3", "lc-renovation", 500],
      ["lc-t4", "lc-renovation", 500],
      ["lc-t5", "lc-renovation", -2],
      ["lc-t6", "lc-renovation", -3],
      ["lc-t7", "lc-renovation", -4],
      ["lc-t8", "lc-renovation", -5],
    ] as const)
      await db.$executeRaw`INSERT INTO expenses
        (id, tenant_id, project_id, tipo_despesa, valor, quantidade, valor_total, forma_pagamento,
         status, updated_at, data_pagamento)
        VALUES (${id}, ${tenant}, ${project}, 'MATERIAL_CONSTRUCAO', ${amount}, 1, ${amount},
          'A_VISTA', 'PAGO', 1, 1788998400000)`;
    const artifact = await db.importArtifact.create({
      data: {
        tenantId: tenant,
        ownerProjectId: "lc-personal",
        documentSha256: "c".repeat(64),
        verifiedBytes: 1,
        detectedFormat: "OFX",
        state: "EXTRACTED",
      },
    });
    const claim = await db.importObservation.create({
      data: {
        tenantId: tenant,
        ownerProjectId: "lc-personal",
        artifactId: artifact.id,
        reference: "claimed",
        evidenceJson: '{"version":1}',
        canonicalProjectId: "lc-personal",
        canonicalExpenseId: "lc-claimed",
        claimReceiptJson:
          '{"kind":"LEGACY_IMPORT","engine":"CARD","importId":null,"externalId":"x"}',
        claimedAt: new Date("2026-09-01T12:00:00.000Z"),
      },
    });
    // a legacy, unmarked, negative edge (pre-71 rows have no notion of refund credit)
    await db.$executeRaw`INSERT INTO rateio_allocations
      (id, tenant_id, source_expense_id, target_expense_id, allocation, planned_status)
      VALUES ('lc-legacy-edge', ${tenant}, 'lc-other', 'lc-t2', -700, 'PAGO')`;

    const schemaObjects = () =>
      db!.$queryRawUnsafe<
        Array<{ type: string; name: string; sql: string | null }>
      >(
        `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      );
    const foreignKeys = () =>
      db!.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT m.name AS tbl, f."table" AS ref, f."from" AS col, f."to" AS refcol,
                f.on_delete, f.on_update
           FROM sqlite_master m, pragma_foreign_key_list(m.name) f
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
          ORDER BY m.name, f.id, f.seq`,
      );
    const history = () =>
      db!.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
                rolled_back_at IS NOT NULL AS rolled_back
           FROM _prisma_migrations ORDER BY migration_name`,
      );
    const rowsOf = (table: string) =>
      db!.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "${table}" ORDER BY id`,
      );
    const guardedTables = [
      "tenants",
      "projects",
      "cash_flow_entries",
      "import_sessions",
      "import_artifacts",
      "import_session_artifacts",
      "import_observations",
    ];

    const before = {
      objects: await schemaObjects(),
      fks: await foreignKeys(),
      history: await history(),
      expenses: await rowsOf("expenses"),
      edges: await rowsOf("rateio_allocations"),
      others: Object.fromEntries(
        await Promise.all(
          guardedTables.map(async (t) => [t, await rowsOf(t)] as const),
        ),
      ),
    };
    expect(before.history).toHaveLength(70);
    expect(
      before.history.every((r) => r.finished === 1n && r.rolled_back === 0n),
    ).toBe(true);
    expect(before.objects.map((o) => o.name)).not.toContain(
      "rateio_allocations_refund_source_key",
    );
    // the bootstrap claim FK to the legacy expense exists and is RESTRICT
    const claimFks = before.fks.filter(
      (fk) => fk.tbl === "import_observations" && fk.ref === "expenses",
    );
    expect(claimFks.length).toBeGreaterThan(0);
    expect(claimFks.every((fk) => fk.on_delete === "RESTRICT")).toBe(true);

    // ── apply migration 71 ──────────────────────────────────────────────────
    await db.$disconnect();
    cpSync(
      join(root, "prisma/migrations", migration),
      join(migrations, migration),
      { recursive: true },
    );
    deploy();
    await db.$connect();
    await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");

    // history: 70 untouched (name+checksum), exactly one new finished row
    const historyAfter = await history();
    expect(historyAfter).toHaveLength(71);
    expect(historyAfter.slice(0, 70)).toEqual(before.history);
    expect(historyAfter[70]).toMatchObject({
      migration_name: migration,
      finished: 1n,
      rolled_back: 0n,
    });
    // schema delta: only expenses, rateio_allocations and the one partial index
    const objectsAfter = await schemaObjects();
    const key = (o: { type: string; name: string }) => `${o.type}:${o.name}`;
    const beforeByKey = new Map(before.objects.map((o) => [key(o), o.sql]));
    const changed = objectsAfter
      .filter((o) => beforeByKey.get(key(o)) !== o.sql)
      .map(key)
      .sort();
    expect(changed).toEqual([
      "index:rateio_allocations_refund_source_key",
      "table:expenses",
      "table:rateio_allocations",
    ]);
    expect(objectsAfter).toHaveLength(before.objects.length + 1);
    // every foreign key (bootstrap RESTRICT included) is unchanged
    expect(await foreignKeys()).toEqual(before.fks);
    // rows: only the two new defaulted columns appeared; everything else identical
    expect(await rowsOf("expenses")).toEqual(
      before.expenses.map((r) => ({ ...r, refund_purpose_revision: 0 })),
    );
    expect(await rowsOf("rateio_allocations")).toEqual(
      before.edges.map((r) => ({ ...r, is_refund_credit: false })),
    );
    for (const table of guardedTables)
      expect(await rowsOf(table)).toEqual(before.others[table]);
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    expect(await db.$queryRaw`PRAGMA integrity_check`).toEqual([
      { integrity_check: "ok" },
    ]);

    // bootstrap RESTRICT still holds for the claimed legacy expense
    await expect(
      db.$executeRawUnsafe(`DELETE FROM "expenses" WHERE id = 'lc-claimed'`),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    expect(
      await db.importObservation.findUniqueOrThrow({ where: { id: claim.id } }),
    ).toMatchObject({ canonicalExpenseId: "lc-claimed" });

    // ── constraints enforce on the upgraded database ────────────────────────
    const edge = (
      id: string,
      source: string,
      target: string,
      allocation: number,
      refund: boolean,
    ) =>
      db!.$executeRawUnsafe(
        `INSERT INTO rateio_allocations
           (id, tenant_id, source_expense_id, target_expense_id, allocation, planned_status, is_refund_credit)
         VALUES ('${id}', '${tenant}', '${source}', '${target}', ${allocation}, 'PAGO', ${refund ? 1 : 0})`,
      );
    // CHECK: a refund credit must be strictly negative (0 and 1 rejected, -1 accepted)
    await expect(
      edge("chk-zero", "lc-claimed", "lc-t1", 0, true),
    ).rejects.toThrow(/CHECK constraint failed/i);
    await expect(
      edge("chk-one", "lc-claimed", "lc-t1", 1, true),
    ).rejects.toThrow(/CHECK constraint failed/i);
    expect(await edge("chk-minus-one", "lc-claimed", "lc-t1", -1, true)).toBe(
      1,
    );
    // the CHECK is scoped to marked rows: an unmarked edge may be zero or positive
    expect(await edge("plain-zero", "lc-other", "lc-t3", 0, false)).toBe(1);
    expect(await edge("plain-positive", "lc-other", "lc-t4", 5, false)).toBe(1);
    // partial UNIQUE: a source has at most one refund credit (its own index, not the target key)
    await expect(
      edge("dup-refund", "lc-claimed", "lc-t5", -2, true),
    ).rejects.toThrow(
      /UNIQUE constraint failed: rateio_allocations\.source_expense_id/i,
    );
    // ... but unmarked edges of that same source are not restricted by the index
    expect(
      await edge("plain-same-source", "lc-claimed", "lc-t6", -3, false),
    ).toBe(1);
    // and another source may carry its own single refund credit
    expect(await edge("other-refund", "lc-other", "lc-t7", -4, true)).toBe(1);
    await expect(
      edge("other-dup", "lc-other", "lc-t8", -5, true),
    ).rejects.toThrow(
      /UNIQUE constraint failed: rateio_allocations\.source_expense_id/i,
    );

    const stored = await db.$queryRawUnsafe<
      Array<{ id: string; is_refund_credit: bigint }>
    >(`SELECT id, is_refund_credit FROM rateio_allocations ORDER BY id`);
    expect(stored.map((r) => [r.id, Number(r.is_refund_credit)])).toEqual([
      ["chk-minus-one", 1],
      ["lc-legacy-edge", 0],
      ["other-refund", 1],
      ["plain-positive", 0],
      ["plain-same-source", 0],
      ["plain-zero", 0],
    ]);
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  } finally {
    await db?.$disconnect();
    if (realpathSync(directory) === directory)
      rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
