require("../../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const MAIN_LAST_MIGRATION = "20260923210000_documented_expense_schedule";
const IMPORT_MIGRATIONS = [
  "20260929010000_import_session_bootstrap",
  "20261009193000_canonical_import_linkage_retention",
  "20261010100000_retire_unlinked_import_artifacts",
] as const;
const ROOT = resolve(__dirname, "../../../../..");

/** Upgrade the same populated #714 database, not a fresh-schema substitute. */
it("main → import migrations preserves IDs, documentary schedules, invoice trails and centavos with clean FKs", async () => {
  const directory = join(
    ROOT,
    "prisma",
    `test-main-import-upgrade-${randomUUID()}`,
  );
  mkdirSync(directory);
  let db: PrismaClient | undefined;
  try {
    const file = join(directory, "test-main-import-upgrade.db");
    const url = `file:${file}`;
    const guard = require("../../../../../scripts/test-db-env.cjs");
    expect(guard.forbiddenReason(url)).toBeNull();
    const migrations = join(directory, "migrations");
    mkdirSync(migrations);
    cpSync(
      join(ROOT, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    for (const name of readdirSync(join(ROOT, "prisma/migrations")).sort()) {
      if (/^\d/.test(name) && name <= MAIN_LAST_MIGRATION) {
        cpSync(join(ROOT, "prisma/migrations", name), join(migrations, name), {
          recursive: true,
        });
      }
    }
    const schema = join(directory, "schema.prisma");
    writeFileSync(schema, readFileSync(join(ROOT, "prisma/schema.prisma")));
    const deploy = (): void => {
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
          cwd: ROOT,
          env: { ...process.env, DATABASE_URL: url },
          stdio: "pipe",
        },
      );
    };
    deploy();
    db = new PrismaClient({ datasources: { db: { url } } });
    const tenantId = (
      await db.tenant.create({ data: { name: "Main upgrade fixture" } })
    ).id;
    const projectId = (
      await db.project.create({
        data: { tenantId, name: "Main PESSOAL fixture", type: "PESSOAL" },
      })
    ).id;
    const cardId = (
      await db.creditCard.create({
        data: {
          tenantId,
          projectId,
          nickname: "Fixture",
          institution: "Fixture",
          last4: "0714",
        },
      })
    ).id;
    const accountId = (
      await db.bankAccount.create({
        data: {
          tenantId,
          projectId,
          nickname: "Fixture",
          institution: "Fixture",
          last4: "0714",
        },
      })
    ).id;
    const importId = (
      await db.bankStatementImport.create({
        data: {
          tenantId,
          accountId,
          source: "OFX",
          periodLabel: "2026-10",
          inserted: 1,
          totalAmountCents: 101,
        },
      })
    ).id;
    const purchaseId = randomUUID();
    const schedule = JSON.stringify({
      version: 1,
      kind: "source",
      tenantId,
      sourceExpenseId: purchaseId,
      sourceProjectId: projectId,
      cardId,
      importId: null,
      externalId: "main-upgrade",
      recordedByUserId: null,
      recordedAt: "2026-10-10T12:00:00.000Z",
      occurrences: [
        {
          index: 0,
          parcela: "1/2",
          valor: 101,
          data: "2026-10-20",
          invoiceDueMonth: "2026-11",
          amountEvidence: null,
          cycleEvidence: null,
        },
        {
          index: 1,
          parcela: "2/2",
          valor: 207,
          data: "2026-12-03",
          invoiceDueMonth: "2027-01",
          amountEvidence: null,
          cycleEvidence: null,
        },
      ],
      projections: [],
      lastOperation: null,
    });
    await db.expense.create({
      data: {
        id: purchaseId,
        tenantId,
        projectId,
        titulo: "Main documentary fixture",
        tipoDespesa: "OUTROS",
        valor: 308,
        quantidade: 1,
        valorTotal: 308,
        formaPagamento: "PARCELADO",
        status: "PLANEJADO",
        quantidadeParcela: 2,
        cardLast4: "0714",
        documentedSchedule: schedule,
      },
    });
    const paymentId = (
      await db.expense.create({
        data: {
          tenantId,
          projectId,
          tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
          valor: 101,
          valorTotal: 101,
          formaPagamento: "A_VISTA",
          status: "PAGO",
          bankLast4: "0714",
          accountId,
          importId,
        },
      })
    ).id;
    const entryId = (
      await db.cashFlowEntry.create({
        data: {
          tenantId,
          projectId,
          expenseId: purchaseId,
          tipo: "DESPESA",
          categoria: "OUTROS",
          valor: 101,
          data: new Date("2026-10-20"),
          parcela: "1/2",
          invoiceDueMonth: "2026-11",
          status: "PAGO",
          formaPagamento: "PARCELADO",
        },
      })
    ).id;
    await db.importedInvoiceLiquidation.create({
      data: {
        tenantId,
        paymentExpenseId: paymentId,
        importId,
        purchaseExpenseId: purchaseId,
        cashFlowEntryId: entryId,
        cardId,
        prevStatus: "PLANEJADO",
        entryValorCents: 101,
        parcela: "1/2",
        dueMonth: "2026-11",
      },
    });
    const before = {
      expenses: await db.$queryRaw`SELECT * FROM expenses ORDER BY id`,
      cash: await db.$queryRaw`SELECT * FROM cash_flow_entries ORDER BY id`,
      trails:
        await db.$queryRaw`SELECT * FROM imported_invoice_liquidations ORDER BY id`,
      imports:
        await db.$queryRaw`SELECT * FROM bank_statement_imports ORDER BY id`,
    };
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    await db.$disconnect();
    const backup = join(directory, "main-backup.db");
    execFileSync("sqlite3", [file, `.backup '${backup}'`], { stdio: "pipe" });
    for (const migration of IMPORT_MIGRATIONS) {
      cpSync(
        join(ROOT, "prisma/migrations", migration),
        join(migrations, migration),
        { recursive: true },
      );
    }
    deploy();
    await db.$connect();
    expect({
      expenses: await db.$queryRaw`SELECT * FROM expenses ORDER BY id`,
      cash: await db.$queryRaw`SELECT * FROM cash_flow_entries ORDER BY id`,
      trails:
        await db.$queryRaw`SELECT * FROM imported_invoice_liquidations ORDER BY id`,
      imports:
        await db.$queryRaw`SELECT * FROM bank_statement_imports ORDER BY id`,
    }).toEqual(before);
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    expect(await db.importSession.count()).toBe(0);
    expect(await db.importObservation.count()).toBe(0);
    expect(
      (await db.expense.findUniqueOrThrow({ where: { id: purchaseId } }))
        .documentedSchedule,
    ).toBe(schedule);
    expect(
      execFileSync("sqlite3", [backup, "PRAGMA integrity_check"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("ok");
    expect(
      execFileSync(
        "sqlite3",
        [backup, "SELECT count(*) FROM _prisma_migrations"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("69");
  } finally {
    await db?.$disconnect();
    if (realpathSync(directory) === directory)
      rmSync(directory, { recursive: true });
  }
}, 30000);

/**
 * Synthetic legacy pattern from the SRE read-only report: 28 active rooms
 * pointing at two absent projects (14 each, no expenses) plus 4 soft-deleted
 * cash-flow entries pointing at four distinct absent expenses. The orphans are
 * seeded FK OFF into a disposable fixture, committed, FK ON restored, and then
 * the real Prisma 69→72 upgrade must leave all of them (and the valid control
 * rows) byte-identical. Nothing here repairs or deletes orphans.
 */
it("main → import migrations preserves the legacy 32 FK orphans without new violations or financial changes", async () => {
  const directory = join(
    ROOT,
    "prisma",
    `test-main-import-legacy-orphans-${randomUUID()}`,
  );
  mkdirSync(directory);
  let db: PrismaClient | undefined;
  try {
    const file = join(directory, "test-main-import-legacy-orphans.db");
    const url = `file:${file}`;
    const guard = require("../../../../../scripts/test-db-env.cjs");
    expect(guard.forbiddenReason(url)).toBeNull();
    const migrations = join(directory, "migrations");
    mkdirSync(migrations);
    cpSync(
      join(ROOT, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    for (const name of readdirSync(join(ROOT, "prisma/migrations")).sort()) {
      if (/^\d/.test(name) && name <= MAIN_LAST_MIGRATION) {
        cpSync(join(ROOT, "prisma/migrations", name), join(migrations, name), {
          recursive: true,
        });
      }
    }
    const schema = join(directory, "schema.prisma");
    writeFileSync(schema, readFileSync(join(ROOT, "prisma/schema.prisma")));
    const deploy = (): void => {
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
          cwd: ROOT,
          env: { ...process.env, DATABASE_URL: url },
          stdio: "pipe",
        },
      );
    };
    const sqlite = (sql: string): string =>
      execFileSync("sqlite3", [file], { input: sql, encoding: "utf8" }).trim();
    deploy();
    expect(sqlite("SELECT count(*) FROM _prisma_migrations")).toBe("69");
    // Production reality: the four import tables are ABSENT at 69.
    expect(
      sqlite(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('import_sessions','import_artifacts','import_session_artifacts','import_observations')",
      ),
    ).toBe("0");

    db = new PrismaClient({ datasources: { db: { url } } });
    const tenantId = (
      await db.tenant.create({ data: { name: "Legacy orphan fixture" } })
    ).id;
    const projectId = (
      await db.project.create({
        data: { tenantId, name: "Legacy PESSOAL fixture", type: "PESSOAL" },
      })
    ).id;
    // Valid financial control rows (must be preserved exactly).
    const roomId = (
      await db.room.create({ data: { projectId, name: "Control room" } })
    ).id;
    const expenseId = (
      await db.expense.create({
        data: {
          tenantId,
          projectId,
          roomId,
          titulo: "Legacy control expense",
          tipoDespesa: "OUTROS",
          valor: 20696,
          quantidade: 1,
          valorTotal: 20696,
          formaPagamento: "A_VISTA",
          status: "PLANEJADO",
        },
      })
    ).id;
    await db.cashFlowEntry.create({
      data: {
        tenantId,
        projectId,
        expenseId,
        tipo: "DESPESA",
        categoria: "OUTROS",
        valor: 20696,
        data: new Date("2026-10-20T12:00:00"),
        status: "PLANEJADO",
        formaPagamento: "A_VISTA",
      },
    });
    await db.$disconnect();
    db = undefined;

    // Disposable fixture only: FK OFF (cannot toggle inside a transaction),
    // seed + COMMIT the orphans, then FK ON before the upgrade.
    const ABSENT_PROJECTS = ["absent-project-a", "absent-project-b"];
    const ABSENT_EXPENSES = [1, 2, 3, 4].map((n) => `absent-expense-${n}`);
    const T0 = Date.UTC(2026, 0, 5, 15);
    const roomInserts = ABSENT_PROJECTS.flatMap((p, i) =>
      Array.from(
        { length: 14 },
        (_, n) =>
          `INSERT INTO rooms (id, project_id, name, "order", created_at) VALUES ('legacy-room-${i}-${n}', '${p}', 'Orphan room ${n}', ${n}, ${T0});`,
      ),
    );
    const cashInserts = ABSENT_EXPENSES.map(
      (e, n) =>
        `INSERT INTO cash_flow_entries (id, project_id, tenant_id, receipt_id, expense_id, budget_allocation_id, valor, tipo, data, categoria, forma_pagamento, status, invoice_due_month, created_at, updated_at, deleted_at) VALUES ('legacy-cash-${n}', '${projectId}', '${tenantId}', NULL, '${e}', NULL, ${10000 + n * 101}, 'DESPESA', ${Date.UTC(2026, 1, 3 + n, 15)}, 'OUTROS', 'A_VISTA', 'PLANEJADO', NULL, ${T0}, ${T0}, ${T0 + 1000});`,
    );
    sqlite(
      [
        "PRAGMA foreign_keys=OFF;",
        "BEGIN;",
        ...roomInserts,
        ...cashInserts,
        "COMMIT;",
        "PRAGMA foreign_keys=ON;",
      ].join("\n"),
    );

    const fkTuples = (): string[] =>
      sqlite("PRAGMA foreign_key_check").split("\n").filter(Boolean).sort();
    const tables = [
      "tenants",
      "projects",
      "rooms",
      "expenses",
      "cash_flow_entries",
      "imported_invoice_liquidations",
      "bank_statement_imports",
    ];
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(
        tables.map((t) => [
          t,
          sqlite(`.mode json\nSELECT * FROM ${t} ORDER BY id`),
        ]),
      );

    const legacyTuples = fkTuples();
    expect(legacyTuples).toHaveLength(32);
    expect(legacyTuples.filter((t) => t.startsWith("rooms|"))).toHaveLength(28);
    expect(
      legacyTuples.filter((t) => t.startsWith("cash_flow_entries|")),
    ).toHaveLength(4);
    expect(
      sqlite(
        "SELECT project_id, count(*), sum(deleted_at IS NULL) FROM rooms WHERE project_id LIKE 'absent-project-%' GROUP BY project_id ORDER BY project_id",
      ),
    ).toBe("absent-project-a|14|14\nabsent-project-b|14|14");
    expect(
      sqlite(
        `SELECT count(*) FROM expenses WHERE room_id LIKE 'legacy-room-%'`,
      ),
    ).toBe("0");
    expect(
      sqlite(
        "SELECT count(DISTINCT expense_id), count(*), sum(deleted_at IS NOT NULL), count(DISTINCT project_id), count(DISTINCT tenant_id), min(tipo), max(tipo), min(status), max(status), min(forma_pagamento), max(forma_pagamento), count(receipt_id), count(budget_allocation_id), count(invoice_due_month) FROM cash_flow_entries WHERE id LIKE 'legacy-cash-%'",
      ),
    ).toBe(
      "4|4|4|1|1|DESPESA|DESPESA|PLANEJADO|PLANEJADO|A_VISTA|A_VISTA|0|0|0",
    );
    expect(sqlite("PRAGMA integrity_check")).toBe("ok");
    const before = snapshot();
    expect(before.rooms).toContain("legacy-room-1-13");
    expect(before.expenses).toContain("20696");

    for (const migration of IMPORT_MIGRATIONS) {
      cpSync(
        join(ROOT, "prisma/migrations", migration),
        join(migrations, migration),
        { recursive: true },
      );
    }
    deploy();

    expect(sqlite("SELECT count(*) FROM _prisma_migrations")).toBe("72");
    expect(
      sqlite(
        "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL",
      ),
    ).toBe("0");
    // Zero NEW violations: exactly the legacy 32 tuples, nothing more/less.
    expect(fkTuples()).toEqual(legacyTuples);
    expect(snapshot()).toEqual(before);
    expect(sqlite("PRAGMA integrity_check")).toBe("ok");
    // Retention migrations find no legacy import data: tables exist, empty.
    for (const t of [
      "import_sessions",
      "import_artifacts",
      "import_session_artifacts",
      "import_observations",
    ]) {
      expect(sqlite(`SELECT count(*) FROM ${t}`)).toBe("0");
    }
  } finally {
    await db?.$disconnect();
    if (realpathSync(directory) === directory)
      rmSync(directory, { recursive: true });
  }
}, 60000);
