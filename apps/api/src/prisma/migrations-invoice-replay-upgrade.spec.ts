require("../../../../scripts/test-db-env.cjs");

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { INCLUDE_SOFT_DELETED, PrismaService } from "./prisma.service";

/**
 * #703 S0 — upgrade 71 -> 72 (additive data checkpoint).
 *
 * The 72nd migration is expected to add ONLY the three replay tables, their
 * explicit indexes and FKs. This spec never touches prisma/dev.db: it builds a
 * disposable legacy database from the 71 committed migrations, seeds it with
 * foreign keys ON, then applies the 72nd migration folder from the repository.
 *
 * No replay producer or financial service is activated by this checkpoint.
 */
const MIGRATION = "20260929030000_invoice_replay";
const LAST_LEGACY_MIGRATION = "20260929020000_refund_purpose";
const LEGACY_MIGRATION_COUNT = 71;
const NEW_TABLES = [
  "invoice_reconciliation_sources",
  "invoice_replay_operations",
  "invoice_funding_allocations",
] as const;
const SEEDED_TABLES = [
  "tenants",
  "users",
  "projects",
  "credit_cards",
  "bank_accounts",
  "bank_statement_imports",
  "credit_card_imports",
  "expenses",
  "cash_flow_entries",
  "rateio_allocations",
  "cross_project_settlements",
  "imported_invoice_liquidations",
];

type Row = Record<string, unknown>;
type Column = [
  name: string,
  type: string,
  notNull: number,
  defaultValue: string | null,
  pk: number,
];
type ForeignKey = {
  from: string;
  table: string;
  to: string;
  onUpdate: string;
  onDelete: string;
};

const fk = (from: string, table: string): ForeignKey => ({
  from,
  table,
  to: "id",
  onUpdate: "CASCADE",
  onDelete: "RESTRICT",
});

// Pinned from 01507a0b:prisma/migrations/20260923230000_invoice_replay.
const EXPECTED: Record<
  (typeof NEW_TABLES)[number],
  {
    columns: Column[];
    indexes: Array<{ name: string; unique: number; columns: string[] }>;
    foreignKeys: ForeignKey[];
  }
> = {
  invoice_reconciliation_sources: {
    columns: [
      ["id", "TEXT", 1, null, 1],
      ["tenant_id", "TEXT", 1, null, 0],
      ["owner_project_id", "TEXT", 1, null, 0],
      ["kind", "TEXT", 1, null, 0],
      ["source_expense_id", "TEXT", 1, null, 0],
      ["source_index", "INTEGER", 1, null, 0],
      ["source_cash_flow_entry_id", "TEXT", 0, null, 0],
      ["bank_statement_import_id", "TEXT", 0, null, 0],
      ["card_statement_import_id", "TEXT", 0, null, 0],
      ["account_id", "TEXT", 0, null, 0],
      ["origin_card_id", "TEXT", 0, null, 0],
      ["destination_card_id", "TEXT", 1, null, 0],
      ["invoice_due_month", "TEXT", 1, null, 0],
      ["capacity_cents", "INTEGER", 1, null, 0],
      ["recorded_date", "DATETIME", 1, null, 0],
      ["admission_mode", "TEXT", 1, null, 0],
      ["admission_operation_id", "TEXT", 1, null, 0],
      ["admission_receipt", "TEXT", 1, null, 0],
      ["created_at", "DATETIME", 1, "CURRENT_TIMESTAMP", 0],
    ],
    indexes: [
      {
        name: "invoice_reconciliation_sources_tenant_id_destination_card_id_invoice_due_month_idx",
        unique: 0,
        columns: ["tenant_id", "destination_card_id", "invoice_due_month"],
      },
      {
        name: "invoice_reconciliation_sources_bank_statement_import_id_idx",
        unique: 0,
        columns: ["bank_statement_import_id"],
      },
      {
        name: "invoice_reconciliation_sources_card_statement_import_id_idx",
        unique: 0,
        columns: ["card_statement_import_id"],
      },
      {
        name: "invoice_reconciliation_sources_origin_key",
        unique: 1,
        columns: ["tenant_id", "source_expense_id", "source_index"],
      },
      {
        name: "invoice_reconciliation_sources_cfe_key",
        unique: 1,
        columns: ["tenant_id", "source_cash_flow_entry_id"],
      },
    ],
    foreignKeys: [
      fk("tenant_id", "tenants"),
      fk("owner_project_id", "projects"),
      fk("source_expense_id", "expenses"),
      fk("source_cash_flow_entry_id", "cash_flow_entries"),
      fk("bank_statement_import_id", "bank_statement_imports"),
      fk("card_statement_import_id", "credit_card_imports"),
      fk("account_id", "bank_accounts"),
      fk("origin_card_id", "credit_cards"),
      fk("destination_card_id", "credit_cards"),
      fk("admission_operation_id", "invoice_replay_operations"),
    ],
  },
  invoice_replay_operations: {
    columns: [
      ["id", "TEXT", 1, null, 1],
      ["tenant_id", "TEXT", 1, null, 0],
      ["owner_project_id", "TEXT", 1, null, 0],
      ["card_id", "TEXT", 1, null, 0],
      ["invoice_due_month", "TEXT", 1, null, 0],
      ["actor_user_id", "TEXT", 1, null, 0],
      ["protocol_version", "INTEGER", 1, "1", 0],
      ["kind", "TEXT", 1, null, 0],
      ["idempotency_key", "TEXT", 1, null, 0],
      ["request_hash", "TEXT", 1, null, 0],
      ["preview_fingerprint", "TEXT", 1, null, 0],
      ["resulting_fingerprint", "TEXT", 1, null, 0],
      ["receipt", "TEXT", 1, null, 0],
      ["public_result", "TEXT", 1, null, 0],
      ["created_at", "DATETIME", 1, "CURRENT_TIMESTAMP", 0],
    ],
    indexes: [
      {
        name: "invoice_replay_operations_tenant_id_card_id_invoice_due_month_created_at_idx",
        unique: 0,
        columns: ["tenant_id", "card_id", "invoice_due_month", "created_at"],
      },
      {
        name: "invoice_replay_operations_request_key",
        unique: 1,
        columns: ["tenant_id", "actor_user_id", "idempotency_key"],
      },
    ],
    // No operation -> source FK: only tenant, project, card and actor.
    foreignKeys: [
      fk("tenant_id", "tenants"),
      fk("owner_project_id", "projects"),
      fk("card_id", "credit_cards"),
      fk("actor_user_id", "users"),
    ],
  },
  invoice_funding_allocations: {
    columns: [
      ["id", "TEXT", 1, null, 1],
      ["tenant_id", "TEXT", 1, null, 0],
      ["source_id", "TEXT", 1, null, 0],
      ["operation_id", "TEXT", 1, null, 0],
      ["baseline_operation_id", "TEXT", 1, null, 0],
      ["layer", "TEXT", 1, null, 0],
      ["kind", "TEXT", 1, null, 0],
      ["purchase_expense_id", "TEXT", 1, null, 0],
      ["purchase_index", "INTEGER", 1, null, 0],
      ["cash_flow_entry_id", "TEXT", 1, null, 0],
      ["amount_cents", "INTEGER", 1, null, 0],
      ["original_claim_id", "TEXT", 0, null, 0],
      ["reversed_by_operation_id", "TEXT", 0, null, 0],
      ["created_at", "DATETIME", 1, "CURRENT_TIMESTAMP", 0],
      ["deleted_at", "DATETIME", 0, null, 0],
    ],
    indexes: [
      {
        name: "invoice_funding_allocations_tenant_id_source_id_deleted_at_idx",
        unique: 0,
        columns: ["tenant_id", "source_id", "deleted_at"],
      },
      {
        name: "invoice_funding_allocations_tenant_id_purchase_expense_id_purchase_index_deleted_at_idx",
        unique: 0,
        columns: [
          "tenant_id",
          "purchase_expense_id",
          "purchase_index",
          "deleted_at",
        ],
      },
      {
        name: "invoice_funding_allocations_cash_flow_entry_id_idx",
        unique: 0,
        columns: ["cash_flow_entry_id"],
      },
      {
        name: "invoice_funding_allocations_original_claim_id_idx",
        unique: 0,
        columns: ["original_claim_id"],
      },
      {
        name: "invoice_funding_allocations_operation_pair_key",
        unique: 1,
        columns: [
          "operation_id",
          "source_id",
          "purchase_expense_id",
          "purchase_index",
          "layer",
        ],
      },
    ],
    foreignKeys: [
      fk("tenant_id", "tenants"),
      fk("source_id", "invoice_reconciliation_sources"),
      fk("operation_id", "invoice_replay_operations"),
      fk("baseline_operation_id", "invoice_replay_operations"),
      fk("purchase_expense_id", "expenses"),
      fk("cash_flow_entry_id", "cash_flow_entries"),
      fk("original_claim_id", "imported_invoice_liquidations"),
      fk("reversed_by_operation_id", "invoice_replay_operations"),
    ],
  },
};

const byName = <T extends { name?: string; from?: string }>(a: T, b: T) =>
  String(a.name ?? a.from).localeCompare(String(b.name ?? b.from));

describe("#703 upgrade 71 -> 72 (schema only, disposable database)", () => {
  const root = resolve(__dirname, "../../../..");
  const directory = join(root, "prisma", `test-replay-upgrade-${randomUUID()}`);
  const migrations = join(directory, "migrations");
  const file = join(directory, "test-replay-upgrade.db");
  const url = `file:${file}`;
  const schema = join(directory, "schema.prisma");
  const evidenceRoot = process.env.INVOICE_REPLAY_EVIDENCE_DIR;
  const evidence = evidenceRoot
    ? join(resolve(evidenceRoot), basename(directory))
    : undefined;
  let owned = false;
  let db: PrismaClient | undefined;
  let legacy: {
    tables: string[];
    tableInfo: Record<string, string>;
    tableHash: Record<string, string>;
    objects: Row[];
    ledger: Row[];
  };
  let upgrade: Promise<void> | undefined;

  const sql = (query: string): Row[] => {
    const out = execFileSync("sqlite3", ["-json", file, query], {
      encoding: "utf8",
    }).trim();
    return out ? (JSON.parse(out) as Row[]) : [];
  };
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
      { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
  const preexistingTables = () =>
    sql(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> '_prisma_migrations' AND name NOT IN (${NEW_TABLES.map((t) => `'${t}'`).join(",")})
       ORDER BY name`,
    ).map((row) => String(row.name));
  const tableInfo = (table: string) =>
    JSON.stringify(sql(`SELECT * FROM pragma_table_info('${table}')`));
  const tableHash = (table: string) =>
    createHash("sha256")
      .update(JSON.stringify(sql(`SELECT * FROM "${table}" ORDER BY rowid`)))
      .digest("hex");
  const objects = () =>
    sql(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY type, name`,
    );
  const ledger = () =>
    sql("SELECT * FROM _prisma_migrations ORDER BY migration_name");
  const legacyNames = () =>
    legacy.ledger.map((row) => String(row.migration_name));
  const retain = (name: string, content: string) => {
    if (evidence)
      writeFileSync(join(evidence, name), content, { mode: 0o600, flag: "wx" });
  };
  const backup = (name: string) => {
    if (evidence) {
      sql(`VACUUM INTO '${join(evidence, name).replace(/'/g, "''")}'`);
      chmodSync(join(evidence, name), 0o600);
    }
  };

  const T = "replay-upgrade-tenant";
  const lit = (value: unknown) =>
    value === null
      ? "NULL"
      : typeof value === "number"
        ? String(value)
        : `'${String(value).replace(/'/g, "''")}'`;
  const insert = (table: string, row: Record<string, unknown>) =>
    `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.values(row).map(lit).join(",")});`;
  // One sqlite3 process = one connection: foreign_keys is switched ON and read
  // back on that very connection, then the case runs inside a transaction that
  // is always rolled back (or discarded when the statement fails under .bail).
  const attempt = (statements: string[]) => {
    const run = spawnSync("sqlite3", [file], {
      encoding: "utf8",
      input: [
        ".bail on",
        "PRAGMA foreign_keys=ON;",
        "SELECT 'fk=' || foreign_keys FROM pragma_foreign_keys;",
        "BEGIN;",
        ...statements,
        "SELECT 'completed';",
        "ROLLBACK;",
      ].join("\n"),
    });
    return {
      fkObserved: run.stdout.includes("fk=1"),
      completed: run.status === 0 && run.stdout.includes("completed"),
      stdout: run.stdout,
      stderr: run.stderr,
    };
  };
  const operation = (o: Row = {}) => ({
    id: "op-a",
    tenant_id: T,
    owner_project_id: "personal",
    card_id: "card-a",
    invoice_due_month: "2026-09",
    actor_user_id: "actor",
    protocol_version: 1,
    kind: "APPLY",
    idempotency_key: "key-a",
    request_hash: "a".repeat(64),
    preview_fingerprint: "b".repeat(64),
    resulting_fingerprint: "c".repeat(64),
    receipt: "{}",
    public_result: "{}",
    ...o,
  });
  const bankSource = (o: Row = {}) => ({
    id: "src-bank",
    tenant_id: T,
    owner_project_id: "personal",
    kind: "BANK_PAYMENT",
    source_expense_id: "bank-payment",
    source_index: 0,
    source_cash_flow_entry_id: null,
    bank_statement_import_id: "bank-import",
    card_statement_import_id: null,
    account_id: "bank-a",
    origin_card_id: null,
    destination_card_id: "card-a",
    invoice_due_month: "2026-09",
    capacity_cents: 11200,
    recorded_date: 1788998400000,
    admission_mode: "EXISTING_ASSOCIATION",
    admission_operation_id: "op-a",
    admission_receipt: "{}",
    ...o,
  });
  const transferSource = (o: Row = {}) =>
    bankSource({
      id: "src-transfer",
      kind: "CARD_TRANSFER",
      source_expense_id: "transfer",
      source_cash_flow_entry_id: "transfer-cfe",
      bank_statement_import_id: null,
      account_id: null,
      origin_card_id: "card-b",
      capacity_cents: 7000,
      ...o,
    });
  const creditSource = (o: Row = {}) =>
    bankSource({
      id: "src-credit",
      kind: "INVOICE_CREDIT",
      source_expense_id: "credit",
      source_cash_flow_entry_id: "credit-cfe",
      bank_statement_import_id: null,
      account_id: null,
      origin_card_id: "card-a",
      admission_mode: "DOCUMENTED_CREDIT",
      capacity_cents: 800,
      ...o,
    });
  const allocation = (o: Row = {}) => ({
    id: "alloc-a",
    tenant_id: T,
    source_id: "src-bank",
    operation_id: "op-a",
    baseline_operation_id: "op-a",
    layer: "ORIGINAL_COVERAGE",
    kind: "BANK_FUNDING",
    purchase_expense_id: "charge",
    purchase_index: 0,
    cash_flow_entry_id: "charge-cfe",
    amount_cents: 11200,
    original_claim_id: "original-claim",
    reversed_by_operation_id: null,
    deleted_at: null,
    ...o,
  });
  const SRC = "invoice_reconciliation_sources";
  const OPS = "invoice_replay_operations";
  const ALLOC = "invoice_funding_allocations";
  const withOperation = (...more: string[]) => [
    insert(OPS, operation()),
    ...more,
  ];
  const withSource = (...more: string[]) =>
    withOperation(insert(SRC, bankSource()), ...more);

  // Applies the 72nd migration folder from the repository. Fails, by design,
  // while that folder does not exist yet.
  const applyMigration = () => {
    upgrade ??= (async () => {
      const source = join(root, "prisma/migrations", MIGRATION);
      expect({
        migration: MIGRATION,
        presentInRepository: existsSync(source),
      }).toEqual({ migration: MIGRATION, presentInRepository: true });
      cpSync(source, join(migrations, MIGRATION), { recursive: true });
      retain("deploy-upgrade.log", deploy().toString());
      backup("upgraded-72.db");
    })();
    return upgrade;
  };

  beforeAll(async () => {
    mkdirSync(directory);
    owned = true;
    if (evidence) mkdirSync(evidence, { mode: 0o700 });
    expect(
      require("../../../../scripts/test-db-env.cjs").forbiddenReason(url),
    ).toBeNull();
    mkdirSync(migrations);
    cpSync(
      join(root, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    for (const name of readdirSync(join(root, "prisma/migrations")).sort()) {
      if (/^\d/.test(name) && name < MIGRATION)
        cpSync(join(root, "prisma/migrations", name), join(migrations, name), {
          recursive: true,
        });
    }
    cpSync(join(root, "prisma/schema.prisma"), schema);
    deploy();

    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$transaction(async (db) => {
      // The transaction pins this observation and the rejected write to one connection.
      expect(
        Number(
          (
            await db.$queryRawUnsafe<Row[]>(
              "SELECT foreign_keys AS enabled FROM pragma_foreign_keys",
            )
          )[0].enabled,
        ),
      ).toBe(1);
      await expect(
        db.project.create({
          data: {
            id: "orphan-project",
            tenantId: "missing-tenant",
            type: "PESSOAL",
            name: "orphan",
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      const tenantId = "replay-upgrade-tenant";
      const date = new Date("2026-09-01T00:00:00Z");
      await db.tenant.create({ data: { id: tenantId, name: "Synthetic" } });
      await db.user.create({
        data: { id: "actor", tenantId, username: "actor", name: "Synthetic" },
      });
      for (const [id, type] of [
        ["personal", "PESSOAL"],
        ["renovation", "REFORMA"],
      ] as const)
        await db.project.create({
          data: { id, tenantId, type, name: id },
        });
      for (const id of ["card-a", "card-b"])
        await db.creditCard.create({
          data: {
            id,
            tenantId,
            projectId: "personal",
            nickname: id,
            last4: "0703",
            institution: "ITAU",
          },
        });
      await db.bankAccount.create({
        data: {
          id: "bank-a",
          tenantId,
          projectId: "personal",
          nickname: "bank-a",
          last4: "1703",
          institution: "ITAU",
        },
      });
      await db.bankStatementImport.create({
        data: {
          id: "bank-import",
          tenantId,
          accountId: "bank-a",
          periodLabel: "2026-09",
          source: "OFX",
        },
      });
      await db.creditCardStatementImport.create({
        data: {
          id: "card-import",
          tenantId,
          cardId: "card-a",
          periodLabel: "2026-09",
          source: "OFX",
        },
      });
      for (const [id, project, amount, status, importId] of [
        ["bank-payment", "personal", 11200, "PAGO", "bank-import"],
        ["charge", "personal", 12000, "PAGO", "card-import"],
        ["credit", "personal", -800, "PAGO", "card-import"],
        ["transfer", "personal", 7000, "PLANEJADO", "card-import"],
        ["rateio-source", "personal", 5000, "PAGO", "card-import"],
        ["rateio-target", "renovation", 5000, "PAGO", null],
      ] as const)
        await db.expense.create({
          data: {
            id,
            tenantId,
            projectId: project,
            tipoDespesa: "OUTROS",
            valor: amount,
            valorTotal: amount,
            formaPagamento: "A_VISTA",
            status,
            dataPagamento: date,
            importId,
            ...(id === "transfer" ? { settlesInvoiceKey: "0703:2026-09" } : {}),
          },
        });
      for (const [id, expenseId, deleted] of [
        ["charge-cfe", "charge", false],
        ["credit-cfe", "credit", false],
        ["transfer-cfe", "transfer", false],
        ["source-cfe", "rateio-source", false],
        ["tombstone-cfe", "rateio-source", true],
      ] as const)
        await db.cashFlowEntry.create({
          data: {
            id,
            expenseId,
            tenantId,
            projectId: "personal",
            tipo: "DESPESA",
            categoria: "Outros",
            valor: 1000,
            data: date,
            status: "PAGO",
            invoiceDueMonth: "2026-09",
            ...(deleted ? { deletedAt: date } : {}),
          },
        });
      await db.importedInvoiceLiquidation.create({
        data: {
          id: "original-claim",
          tenantId,
          paymentExpenseId: "bank-payment",
          importId: "bank-import",
          purchaseExpenseId: "charge",
          cashFlowEntryId: "charge-cfe",
          cardId: "card-a",
          prevStatus: "PLANEJADO",
          entryValorCents: 12000,
          dueMonth: "2026-09",
        },
      });
      await db.rateioAllocation.create({
        data: {
          id: "legacy-edge",
          tenantId,
          sourceExpenseId: "rateio-source",
          targetExpenseId: "rateio-target",
          allocation: 5000,
          plannedStatus: "PLANEJADO",
        },
      });
      await db.crossProjectSettlement.create({
        data: {
          id: "legacy-settlement",
          tenantId,
          sourceExpenseId: "bank-payment",
          targetExpenseId: "rateio-target",
          parcelaIndex: 0,
          realValor: 5000,
          plannedValor: 5000,
          plannedStatus: "PLANEJADO",
        },
      });
    });
    await db.$disconnect();
    db = undefined;

    const tables = preexistingTables();
    legacy = {
      tables,
      tableInfo: Object.fromEntries(tables.map((t) => [t, tableInfo(t)])),
      tableHash: Object.fromEntries(tables.map((t) => [t, tableHash(t)])),
      objects: objects(),
      ledger: ledger(),
    };
    backup("legacy-71.db");
    retain("legacy-snapshot.json", JSON.stringify(legacy, null, 2));
  }, 60000);

  afterAll(async () => {
    await db?.$disconnect();
    if (owned && evidence && existsSync(file)) {
      backup("final.db");
      retain("final-ledger.json", JSON.stringify(ledger(), null, 2));
    }
    if (owned && realpathSync(directory) === directory)
      rmSync(directory, { recursive: true });
  });

  describe("legacy controls (must stay green before and after the migration exists)", () => {
    it("starts from the 71 committed migrations, without any replay object", () => {
      expect(legacy.ledger).toHaveLength(LEGACY_MIGRATION_COUNT);
      expect(legacyNames().at(-1)).toBe(LAST_LEGACY_MIGRATION);
      expect(legacy.tables).not.toEqual(
        expect.arrayContaining([...NEW_TABLES]),
      );
      expect(
        legacy.objects.filter((o) =>
          /invoice_(replay|reconciliation|funding)/.test(String(o.name)),
        ),
      ).toEqual([]);
    });

    it("is not a zeroed fixture: every referenced legacy table has rows", () => {
      for (const table of SEEDED_TABLES) {
        expect({
          table,
          rows: Number(sql(`SELECT count(*) AS n FROM "${table}"`)[0].n) > 0,
        }).toEqual({
          table,
          rows: true,
        });
      }
      expect(
        Number(
          sql(
            "SELECT count(*) AS n FROM cash_flow_entries WHERE deleted_at IS NOT NULL",
          )[0].n,
        ),
      ).toBeGreaterThan(0);
      expect(sql("PRAGMA foreign_key_check")).toEqual([]);
    });
  });

  describe("schema.prisma <-> committed SQL drift for the replay tables", () => {
    // The repository already carries expected drift (partial unique indexes and
    // additive CHECKs live only in SQL), so the whole diff is never empty. What
    // must hold is that the replay tables contribute nothing to it: no create,
    // drop, alter or redefine mentioning them, in either direction.
    it("prisma migrate diff mentions none of the three replay tables", async () => {
      await applyMigration();
      const run = spawnSync(
        process.execPath,
        [
          require.resolve("prisma/build/index.js"),
          "migrate",
          "diff",
          "--from-migrations",
          join(root, "prisma/migrations"),
          "--to-schema-datamodel",
          join(root, "prisma/schema.prisma"),
          "--shadow-database-url",
          `file:${join(directory, "drift-shadow.db")}`,
          "--script",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: url },
        },
      );
      retain("drift.json", JSON.stringify(run, null, 2));
      expect(run.status).toBe(0);
      expect(run.stdout.length).toBeGreaterThan(0);
      for (const table of NEW_TABLES) expect(run.stdout).not.toContain(table);
    }, 60000);
  });

  describe("additive upgrade", () => {
    it("U1 keeps every pre-existing table, column, row, index and SQL byte-identical", async () => {
      await applyMigration();
      for (const table of legacy.tables) {
        expect({ table, columns: tableInfo(table) }).toEqual({
          table,
          columns: legacy.tableInfo[table],
        });
        expect({ table, rowsSha256: tableHash(table) }).toEqual({
          table,
          rowsSha256: legacy.tableHash[table],
        });
      }
      expect(preexistingTables()).toEqual(legacy.tables);
      const after = objects();
      for (const before of legacy.objects) expect(after).toContainEqual(before);
      expect(sql("PRAGMA foreign_key_check")).toEqual([]);
      expect(sql("PRAGMA integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    });

    it("U1 adds exactly the three tables and their 12 explicit indexes, nothing else", async () => {
      await applyMigration();
      const legacyKeys = new Set(
        legacy.objects.map((o) => `${o.type}:${o.name}`),
      );
      const added = objects()
        .filter((o) => !legacyKeys.has(`${o.type}:${o.name}`))
        .map((o) => `${o.type}:${o.name}:${o.tbl_name}`)
        .sort();
      const expected = NEW_TABLES.flatMap((table) => [
        `table:${table}:${table}`,
        ...EXPECTED[table].indexes.map((i) => `index:${i.name}:${table}`),
      ]).sort();
      expect(expected).toHaveLength(15);
      expect(added).toEqual(expected);
    });

    it("U1 records exactly one new finished ledger row and leaves the previous 71 alone", async () => {
      await applyMigration();
      expect(
        ledger().filter((row) => row.migration_name !== MIGRATION),
      ).toEqual(legacy.ledger);
      expect(ledger()).toHaveLength(LEGACY_MIGRATION_COUNT + 1);
      expect(
        sql(
          `SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name='${MIGRATION}'
           AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1`,
        ),
      ).toEqual([{ n: 1 }]);
    });

    it.each(NEW_TABLES)(
      "U1 %s has the exact columns and explicit indexes",
      async (table) => {
        await applyMigration();
        expect(
          sql(
            `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`,
          ).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
        ).toEqual(EXPECTED[table].columns);
        const indexes = sql(
          `SELECT name, "unique" AS uniq FROM pragma_index_list('${table}') WHERE origin='c'`,
        )
          .map((i) => ({
            name: String(i.name),
            unique: Number(i.uniq),
            columns: sql(
              `SELECT name FROM pragma_index_info('${i.name}') ORDER BY seqno`,
            ).map((c) => String(c.name)),
          }))
          .sort(byName);
        expect(indexes).toEqual([...EXPECTED[table].indexes].sort(byName));
      },
    );

    it.each(NEW_TABLES)("U5 %s has the exact FK list", async (table) => {
      await applyMigration();
      const actual = sql(
        `SELECT "from", "table", "to", on_update, on_delete FROM pragma_foreign_key_list('${table}')`,
      )
        .map((r) => ({
          from: String(r.from),
          table: String(r.table),
          to: String(r.to),
          onUpdate: String(r.on_update),
          onDelete: String(r.on_delete),
        }))
        .sort(byName);
      expect(actual).toEqual([...EXPECTED[table].foreignKeys].sort(byName));
    });

    it("U5 has no FK from an operation to a source (the guard must not infer one)", async () => {
      await applyMigration();
      expect(
        sql(
          `SELECT "from" FROM pragma_foreign_key_list('invoice_replay_operations')
           WHERE "table"='invoice_reconciliation_sources'`,
        ),
      ).toEqual([]);
    });

    it("keeps deleted_at only on the funding allocations", async () => {
      await applyMigration();
      const withDeletedAt = NEW_TABLES.filter(
        (table) =>
          sql(
            `SELECT 1 FROM pragma_table_info('${table}') WHERE name='deleted_at'`,
          ).length === 1,
      );
      expect(withDeletedAt).toEqual(["invoice_funding_allocations"]);
    });
  });

  describe("13 CHECK constraints, each violated on its own (SQLite rules, no Prisma models)", () => {
    type Vector = {
      name: string;
      check: string;
      fragment: string;
      statements: () => string[];
    };
    const badMonths = [
      "2026-13",
      "2026-00",
      "0000-01",
      "2026-1",
      "2026/09",
      "2026-0a",
    ];
    const S5 = "kind = 'BANK_PAYMENT' AND source_index = 0";
    const source = (name: string, row: Row): Vector => ({
      name,
      check: "S5",
      fragment: S5,
      statements: () => withOperation(insert(SRC, row)),
    });
    const vectors: Vector[] = [
      {
        name: "source kind outside the enum",
        check: "S1",
        fragment: "kind IN ('BANK_PAYMENT','CARD_TRANSFER','INVOICE_CREDIT')",
        statements: () =>
          withOperation(insert(SRC, bankSource({ kind: "BOGUS" }))),
      },
      ...[
        ["negative source_index", { source_index: -1 }],
        ["zero capacity_cents", { capacity_cents: 0 }],
        ["negative capacity_cents", { capacity_cents: -1 }],
      ].map(
        ([name, row]): Vector => ({
          name: `source ${name}`,
          check: "S2",
          fragment: "source_index >= 0 AND capacity_cents > 0",
          statements: () =>
            withOperation(insert(SRC, creditSource(row as Row))),
        }),
      ),
      {
        name: "source admission_mode outside the enum",
        check: "S3",
        fragment:
          "admission_mode IN ('EXISTING_ASSOCIATION','ASSISTED_EXISTING_PAYMENT','DOCUMENTED_CREDIT')",
        statements: () =>
          withOperation(insert(SRC, bankSource({ admission_mode: "BOGUS" }))),
      },
      ...badMonths.map(
        (month): Vector => ({
          name: `source invoice_due_month ${month}`,
          check: "S4",
          fragment: "length(invoice_due_month) = 7",
          statements: () =>
            withOperation(
              insert(SRC, bankSource({ invoice_due_month: month })),
            ),
        }),
      ),
      source(
        "BANK_PAYMENT with source_index 1",
        bankSource({ source_index: 1 }),
      ),
      source(
        "BANK_PAYMENT without bank import",
        bankSource({ bank_statement_import_id: null }),
      ),
      source(
        "BANK_PAYMENT with a card import",
        bankSource({ card_statement_import_id: "card-import" }),
      ),
      source("BANK_PAYMENT without account", bankSource({ account_id: null })),
      source(
        "BANK_PAYMENT with an origin card",
        bankSource({ origin_card_id: "card-b" }),
      ),
      source(
        "BANK_PAYMENT admitted as DOCUMENTED_CREDIT",
        bankSource({ admission_mode: "DOCUMENTED_CREDIT" }),
      ),
      source(
        "CARD_TRANSFER with origin = destination",
        transferSource({ origin_card_id: "card-a" }),
      ),
      source(
        "CARD_TRANSFER without cash flow entry",
        transferSource({ source_cash_flow_entry_id: null }),
      ),
      source(
        "CARD_TRANSFER with an account",
        transferSource({ account_id: "bank-a" }),
      ),
      source(
        "CARD_TRANSFER with a bank import",
        transferSource({ bank_statement_import_id: "bank-import" }),
      ),
      source(
        "CARD_TRANSFER with source_index 1",
        transferSource({ source_index: 1 }),
      ),
      source(
        "CARD_TRANSFER without origin card",
        transferSource({ origin_card_id: null }),
      ),
      source(
        "CARD_TRANSFER admitted as DOCUMENTED_CREDIT",
        transferSource({ admission_mode: "DOCUMENTED_CREDIT" }),
      ),
      source(
        "INVOICE_CREDIT with origin != destination",
        creditSource({ origin_card_id: "card-b" }),
      ),
      source(
        "INVOICE_CREDIT admitted as EXISTING_ASSOCIATION",
        creditSource({ admission_mode: "EXISTING_ASSOCIATION" }),
      ),
      source(
        "INVOICE_CREDIT without cash flow entry",
        creditSource({ source_cash_flow_entry_id: null }),
      ),
      source(
        "INVOICE_CREDIT with a bank import",
        creditSource({ bank_statement_import_id: "bank-import" }),
      ),
      source(
        "INVOICE_CREDIT with an account",
        creditSource({ account_id: "bank-a" }),
      ),
      source(
        "INVOICE_CREDIT without origin card",
        creditSource({ origin_card_id: null }),
      ),
      ...[
        ["protocol_version 2", { protocol_version: 2 }],
        ["protocol_version 0", { protocol_version: 0 }],
      ].map(
        ([name, row]): Vector => ({
          name: `operation ${name}`,
          check: "O1",
          fragment: "protocol_version = 1",
          statements: () => [insert(OPS, operation(row as Row))],
        }),
      ),
      {
        name: "operation kind outside the enum",
        check: "O2",
        fragment: "'UNDO_REPLAY','UNDO_SOURCE_REPLAY'",
        statements: () => [insert(OPS, operation({ kind: "BOGUS" }))],
      },
      ...badMonths.map(
        (month): Vector => ({
          name: `operation invoice_due_month ${month}`,
          check: "O3",
          fragment: "length(invoice_due_month) = 7",
          statements: () => [
            insert(OPS, operation({ invoice_due_month: month })),
          ],
        }),
      ),
      ...[
        ["zero amount_cents", { amount_cents: 0 }],
        ["negative amount_cents", { amount_cents: -1 }],
        ["negative purchase_index", { purchase_index: -1 }],
      ].map(
        ([name, row]): Vector => ({
          name: `allocation ${name}`,
          check: "A1",
          fragment: "amount_cents > 0 AND purchase_index >= 0",
          statements: () => withSource(insert(ALLOC, allocation(row as Row))),
        }),
      ),
      {
        name: "allocation layer outside the enum",
        check: "A2",
        fragment: "layer IN ('ORIGINAL_COVERAGE','REPLAY')",
        statements: () =>
          withSource(insert(ALLOC, allocation({ layer: "BOGUS" }))),
      },
      {
        name: "allocation kind outside the enum",
        check: "A3",
        fragment: "kind IN ('BANK_FUNDING','TRANSFER_FUNDING','CREDIT_OFFSET')",
        statements: () =>
          withSource(insert(ALLOC, allocation({ kind: "BOGUS" }))),
      },
      {
        name: "ORIGINAL_COVERAGE allocation without original claim",
        check: "A4",
        fragment:
          "layer = 'ORIGINAL_COVERAGE' AND original_claim_id IS NOT NULL",
        statements: () =>
          withSource(insert(ALLOC, allocation({ original_claim_id: null }))),
      },
      {
        name: "REPLAY allocation carrying an original claim",
        check: "A4",
        fragment:
          "layer = 'ORIGINAL_COVERAGE' AND original_claim_id IS NOT NULL",
        statements: () =>
          withSource(insert(ALLOC, allocation({ layer: "REPLAY" }))),
      },
      {
        name: "deleted allocation without reversing operation",
        check: "A5",
        fragment: "deleted_at IS NULL AND reversed_by_operation_id IS NULL",
        statements: () =>
          withSource(insert(ALLOC, allocation({ deleted_at: 1788998400000 }))),
      },
      {
        name: "live allocation already reversed",
        check: "A5",
        fragment: "deleted_at IS NULL AND reversed_by_operation_id IS NULL",
        statements: () =>
          withSource(
            insert(
              OPS,
              operation({
                id: "op-b",
                kind: "UNDO_REPLAY",
                idempotency_key: "key-b",
              }),
            ),
            insert(ALLOC, allocation({ reversed_by_operation_id: "op-b" })),
          ),
      },
    ];

    it("covers all 13 CHECK constraints (5 sources, 3 operations, 5 allocations)", async () => {
      await applyMigration();
      expect(new Set(vectors.map((v) => v.check))).toEqual(
        new Set([
          "S1",
          "S2",
          "S3",
          "S4",
          "S5",
          "O1",
          "O2",
          "O3",
          "A1",
          "A2",
          "A3",
          "A4",
          "A5",
        ]),
      );
      const checks = (table: string) =>
        (
          String(
            sql(
              `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`,
            )[0].sql,
          ).match(/\bCHECK\s*\(/g) ?? []
        ).length;
      expect([checks(SRC), checks(OPS), checks(ALLOC)]).toEqual([5, 3, 5]);
    });

    it.each(vectors)("rejects: $name ($check)", async (vector) => {
      await applyMigration();
      const result = attempt(vector.statements());
      expect({
        fkObserved: result.fkObserved,
        completed: result.completed,
        checkFailed: result.stderr.includes("CHECK constraint failed"),
        names: result.stderr.includes(vector.fragment),
      }).toEqual({
        fkObserved: true,
        completed: false,
        checkFailed: true,
        names: true,
      });
    });

    const positives: Array<[string, () => string[]]> = [
      ["BANK_PAYMENT EXISTING_ASSOCIATION", () => withSource()],
      [
        "BANK_PAYMENT ASSISTED_EXISTING_PAYMENT",
        () =>
          withOperation(
            insert(
              SRC,
              bankSource({ admission_mode: "ASSISTED_EXISTING_PAYMENT" }),
            ),
          ),
      ],
      [
        "BANK_PAYMENT with an optional cash flow entry",
        () =>
          withOperation(
            insert(
              SRC,
              bankSource({ source_cash_flow_entry_id: "charge-cfe" }),
            ),
          ),
      ],
      [
        "two BANK_PAYMENT sources with NULL cash flow entry do not collide",
        () =>
          withSource(
            insert(
              SRC,
              bankSource({
                id: "src-bank-2",
                source_expense_id: "rateio-source",
              }),
            ),
          ),
      ],
      ["CARD_TRANSFER", () => withOperation(insert(SRC, transferSource()))],
      [
        "INVOICE_CREDIT source_index 0",
        () => withOperation(insert(SRC, creditSource())),
      ],
      [
        "INVOICE_CREDIT source_index 1",
        () => withOperation(insert(SRC, creditSource({ source_index: 1 }))),
      ],
      ...["2026-09", "0001-01", "9999-12"].flatMap(
        (month): Array<[string, () => string[]]> => [
          [
            `source month ${month}`,
            () =>
              withOperation(
                insert(SRC, bankSource({ invoice_due_month: month })),
              ),
          ],
          [
            `operation month ${month}`,
            () => [insert(OPS, operation({ invoice_due_month: month }))],
          ],
        ],
      ),
      ...[
        "APPLY",
        "UNDO_REPLAY",
        "UNDO_SOURCE_REPLAY",
        "UNDO_ORIGINAL_ADMISSION",
        "UNDO_BANK_IMPORT",
        "UNDO_CARD_IMPORT",
        "UNDO_TRANSFER",
        "UNDO_CREDIT",
        "UNDO_GRAPH",
      ].map((kind): [string, () => string[]] => [
        `operation kind ${kind}`,
        () => [insert(OPS, operation({ kind }))],
      ]),
      [
        "ORIGINAL_COVERAGE allocation",
        () => withSource(insert(ALLOC, allocation())),
      ],
      [
        "REPLAY allocation without claim",
        () =>
          withSource(
            insert(
              ALLOC,
              allocation({ layer: "REPLAY", original_claim_id: null }),
            ),
          ),
      ],
      ...["TRANSFER_FUNDING", "CREDIT_OFFSET"].map(
        (kind): [string, () => string[]] => [
          `allocation kind ${kind}`,
          () => withSource(insert(ALLOC, allocation({ kind }))),
        ],
      ),
      [
        "tombstoned allocation with reversing operation",
        () =>
          withSource(
            insert(
              OPS,
              operation({
                id: "op-b",
                kind: "UNDO_REPLAY",
                idempotency_key: "key-b",
              }),
            ),
            insert(
              ALLOC,
              allocation({
                deleted_at: 1788998400000,
                reversed_by_operation_id: "op-b",
              }),
            ),
          ),
      ],
    ];
    it.each(positives)("accepts: %s", async (_name, statements) => {
      await applyMigration();
      const result = attempt(statements());
      expect({
        fkObserved: result.fkObserved,
        completed: result.completed,
        stderr: result.stderr,
      }).toEqual({ fkObserved: true, completed: true, stderr: "" });
    });
  });

  describe("FK, UNIQUE and CASCADE observed on the same connection", () => {
    const rejected = (statements: string[], fragment: string) => {
      const result = attempt(statements);
      expect({
        fkObserved: result.fkObserved,
        completed: result.completed,
        names: result.stderr.includes(fragment),
      }).toEqual({ fkObserved: true, completed: false, names: true });
    };

    it("rejects orphan inserts (FK enforcement is ON, not merely an empty foreign_key_check)", async () => {
      await applyMigration();
      rejected(
        [insert(OPS, operation({ card_id: "missing-card" }))],
        "FOREIGN KEY constraint failed",
      );
      rejected(
        withOperation(
          insert(SRC, bankSource({ source_expense_id: "missing" })),
        ),
        "FOREIGN KEY constraint failed",
      );
      rejected(
        withSource(insert(ALLOC, allocation({ source_id: "missing-source" }))),
        "FOREIGN KEY constraint failed",
      );
      rejected(
        withSource(insert(ALLOC, allocation({ original_claim_id: "missing" }))),
        "FOREIGN KEY constraint failed",
      );
    });

    it("RESTRICTs deleting a referenced parent", async () => {
      await applyMigration();
      for (const parent of [
        "DELETE FROM invoice_replay_operations WHERE id='op-a';",
        "DELETE FROM expenses WHERE id='bank-payment';",
        "DELETE FROM credit_cards WHERE id='card-a';",
        "DELETE FROM tenants WHERE id='replay-upgrade-tenant';",
      ])
        rejected(withSource(parent), "FOREIGN KEY constraint failed");
      rejected(
        withSource(
          insert(ALLOC, allocation()),
          "DELETE FROM invoice_reconciliation_sources WHERE id='src-bank';",
        ),
        "FOREIGN KEY constraint failed",
      );
    });

    it("CASCADEs a parent id update to the referencing rows", async () => {
      await applyMigration();
      const result = attempt(
        withSource(
          "UPDATE invoice_replay_operations SET id='op-renamed' WHERE id='op-a';",
          "SELECT 'cascaded=' || admission_operation_id FROM invoice_reconciliation_sources;",
        ),
      );
      expect(result.completed).toBe(true);
      expect(result.stdout).toContain("cascaded=op-renamed");
    });

    it("enforces the four unique identities", async () => {
      await applyMigration();
      rejected(
        withSource(
          insert(SRC, bankSource({ id: "src-bank-dup", account_id: "bank-a" })),
        ),
        "UNIQUE constraint failed: invoice_reconciliation_sources.tenant_id, invoice_reconciliation_sources.source_expense_id",
      );
      rejected(
        withOperation(
          insert(SRC, transferSource()),
          insert(
            SRC,
            transferSource({
              id: "src-transfer-2",
              source_expense_id: "credit",
            }),
          ),
        ),
        "UNIQUE constraint failed: invoice_reconciliation_sources.tenant_id, invoice_reconciliation_sources.source_cash_flow_entry_id",
      );
      rejected(
        [insert(OPS, operation()), insert(OPS, operation({ id: "op-dup" }))],
        "UNIQUE constraint failed: invoice_replay_operations.tenant_id, invoice_replay_operations.actor_user_id, invoice_replay_operations.idempotency_key",
      );
      rejected(
        withSource(
          insert(ALLOC, allocation()),
          insert(ALLOC, allocation({ id: "alloc-dup" })),
        ),
        "UNIQUE constraint failed: invoice_funding_allocations.operation_id",
      );
    });

    it("leaves no rows behind and every pre-existing table byte-identical after all vectors", async () => {
      await applyMigration();
      for (const table of NEW_TABLES)
        expect(sql(`SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
      for (const table of legacy.tables)
        expect({ table, rowsSha256: tableHash(table) }).toEqual({
          table,
          rowsSha256: legacy.tableHash[table],
        });
      expect(sql("PRAGMA foreign_key_check")).toEqual([]);
    });
  });

  describe("72nd migration is the last one and is idempotent", () => {
    const committed = () =>
      readdirSync(join(root, "prisma/migrations"))
        .filter((name) => /^\d/.test(name))
        .sort();

    it("pins prisma/migrations to exactly 72 folders, the last being the replay migration", () => {
      const names = committed();
      expect(names).toHaveLength(72);
      expect(names[names.length - 1]).toBe(MIGRATION);
      expect(names.slice(0, LEGACY_MIGRATION_COUNT)).toEqual(legacyNames());
    });

    it("a repeated migrate deploy is a no-op on the synthetic database", async () => {
      await applyMigration();
      const before = { ledger: ledger(), objects: objects() };
      const output = deploy().toString();
      retain("deploy-noop.log", output);
      expect(output).toContain("No pending migrations to apply.");
      expect({ ledger: ledger(), objects: objects() }).toEqual(before);
      expect(sql("PRAGMA foreign_key_check")).toEqual([]);
    });

    it("U6 records the literal old-CLI (71 folders) result against a database already at 72", async () => {
      await applyMigration();
      const before = { ledger: ledger(), objects: objects() };
      const oldCli = join(directory, "old-cli-71");
      mkdirSync(join(oldCli, "migrations"), { recursive: true });
      cpSync(
        join(root, "prisma/migrations/migration_lock.toml"),
        join(oldCli, "migrations/migration_lock.toml"),
      );
      for (const name of legacyNames())
        cpSync(
          join(root, "prisma/migrations", name),
          join(oldCli, "migrations", name),
          { recursive: true },
        );
      cpSync(join(root, "prisma/schema.prisma"), join(oldCli, "schema.prisma"));
      const run = spawnSync(
        process.execPath,
        [
          require.resolve("prisma/build/index.js"),
          "migrate",
          "deploy",
          "--schema",
          join(oldCli, "schema.prisma"),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: url },
        },
      );
      // Observed with the installed Prisma 5.22 CLI, not a rollback guarantee.
      retain("u6-old-cli.json", JSON.stringify(run, null, 2));
      expect(run.error).toBeUndefined();
      expect(run.signal).toBeNull();
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("71 migrations found");
      expect(run.stdout).toContain("No pending migrations to apply.");
      console.info(
        `U6 old-71-folder CLI vs DB at 72: ${JSON.stringify({ status: run.status, stdout: run.stdout, stderr: run.stderr })}`,
      );
      expect({ ledger: ledger(), objects: objects() }).toEqual(before);
      expect(sql("PRAGMA foreign_key_check")).toEqual([]);
    });
  });

  describe("real PrismaService middleware on the upgraded schema", () => {
    const exercise = async (
      mode: "root" | "transaction",
      check: (client: Prisma.TransactionClient) => Promise<void>,
    ) => {
      await applyMigration();
      const middlewareFile = join(directory, `middleware-${randomUUID()}.db`);
      sql(`VACUUM INTO '${middlewareFile.replace(/'/g, "''")}'`);
      const middlewareUrl = `file:${middlewareFile}`;
      expect(
        require("../../../../scripts/test-db-env.cjs").forbiddenReason(
          middlewareUrl,
        ),
      ).toBeNull();
      const previousUrl = process.env.DATABASE_URL;
      let service: PrismaService | undefined;
      try {
        process.env.DATABASE_URL = middlewareUrl;
        service = new PrismaService();
        await service.$connect();
        await service.$transaction(async (tx) => {
          expect(
            Number(
              (await tx.$queryRaw<Row[]>`PRAGMA foreign_keys`)[0].foreign_keys,
            ),
          ).toBe(1);
          for (const statement of withSource())
            await tx.$executeRawUnsafe(statement);
        });
        if (mode === "transaction") await service.$transaction(check);
        else await check(service);
      } finally {
        await service?.$disconnect();
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        if (evidence) {
          cpSync(middlewareFile, join(evidence, basename(middlewareFile)));
          chmodSync(join(evidence, basename(middlewareFile)), 0o600);
        }
      }
    };

    it.each(["root", "transaction"] as const)(
      "Source/Operation do not infer deletedAt for reads or deletes (%s)",
      async (mode) => {
        await exercise(mode, async (client) => {
          expect(
            await client.invoiceReconciliationSource.findFirst(),
          ).toMatchObject({
            id: "src-bank",
          });
          expect(
            await client.invoiceReconciliationSource.findMany(),
          ).toHaveLength(1);
          expect(await client.invoiceReplayOperation.findFirst()).toMatchObject(
            {
              id: "op-a",
            },
          );
          expect(await client.invoiceReplayOperation.findMany()).toHaveLength(
            1,
          );
          expect(
            await client.invoiceReconciliationSource.delete({
              where: { id: "src-bank" },
            }),
          ).not.toHaveProperty("deletedAt");
          expect(
            await client.invoiceReconciliationSource.findUnique({
              where: { id: "src-bank" },
            }),
          ).toBeNull();
          await client.$executeRawUnsafe(insert(SRC, bankSource()));
          expect(await client.invoiceReconciliationSource.deleteMany()).toEqual(
            { count: 1 },
          );
          expect(
            await client.invoiceReplayOperation.delete({
              where: { id: "op-a" },
            }),
          ).not.toHaveProperty("deletedAt");
          expect(
            await client.invoiceReplayOperation.findUnique({
              where: { id: "op-a" },
            }),
          ).toBeNull();
          await client.$executeRawUnsafe(insert(OPS, operation()));
          expect(await client.invoiceReplayOperation.deleteMany()).toEqual({
            count: 1,
          });
          expect(await client.invoiceReplayOperation.findMany()).toEqual([]);
        });
      },
    );

    it.each(["root", "transaction"] as const)(
      "FundingAllocation retains soft-delete filtering and history (%s)",
      async (mode) => {
        await exercise(mode, async (client) => {
          await client.$executeRawUnsafe(
            insert(
              ALLOC,
              allocation({
                deleted_at: 1788998400000,
                reversed_by_operation_id: "op-a",
              }),
            ),
          );
          await client.$executeRawUnsafe(
            insert(
              ALLOC,
              allocation({
                id: "alloc-live",
                layer: "REPLAY",
                original_claim_id: null,
              }),
            ),
          );
          expect(
            await client.invoiceFundingAllocation.findFirst({
              where: { id: "alloc-a" },
            }),
          ).toBeNull();
          expect(await client.invoiceFundingAllocation.findMany()).toEqual([
            expect.objectContaining({ id: "alloc-live", deletedAt: null }),
          ]);
          expect(
            await client.invoiceFundingAllocation.findMany({
              where: { deletedAt: INCLUDE_SOFT_DELETED },
            }),
          ).toHaveLength(2);
          // Re-deleting history keeps the reversal CHECK valid without an economic producer.
          const deleted = await client.invoiceFundingAllocation.delete({
            where: { id: "alloc-a" },
          });
          expect(deleted.deletedAt).toBeInstanceOf(Date);
          expect(
            await client.invoiceFundingAllocation.findUnique({
              where: { id: "alloc-a" },
            }),
          ).not.toBeNull();
          expect(
            await client.invoiceFundingAllocation.deleteMany({
              where: { id: "alloc-a" },
            }),
          ).toEqual({
            count: 1,
          });
          expect(
            await client.invoiceFundingAllocation.findMany({
              where: { deletedAt: { not: null } },
            }),
          ).toHaveLength(1);
        });
      },
    );
  });
});
