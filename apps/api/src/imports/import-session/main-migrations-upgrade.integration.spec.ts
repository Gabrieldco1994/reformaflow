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
