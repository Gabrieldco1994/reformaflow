// PR: PR 1 (degrau) — §6.7 / parecer SRE §3.3.1 ponto 5 / #7.
// Upgrade legado REAL: aplica a sequência de migrations ATÉ a imediatamente
// anterior a `20260909120000_imported_invoice_liquidations` num banco dedicado,
// semeia dados legados PAGOS no schema ANTIGO (sem colunas de carimbo, lote misto),
// faz backup do arquivo, roda `prisma migrate deploy` COMPLETO no mesmo banco e
// assevera preservação + colunas NULL + tabela vazia + FKs + `foreign_key_check`.
// Guard `scripts/test-db-env.cjs`: o banco fica DENTRO do worktree e é removido
// no afterAll.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REAL_MIGRATIONS = path.join(REPO_ROOT, "prisma/migrations");
const REAL_SCHEMA = path.join(REPO_ROOT, "prisma/schema.prisma");
const TARGET_MIGRATION = "20260909120000_imported_invoice_liquidations";

const RUN = `569up-${process.pid}`;
const TMP_DIR = path.join(REPO_ROOT, "prisma", `.tmp-${RUN}`);
const TMP_MIGRATIONS = path.join(TMP_DIR, "migrations");
const DB_FILE = path.join(REPO_ROOT, "prisma", `test-${RUN}.db`);
const DB_URL = `file:${DB_FILE}`;

function deploy(): void {
  execFileSync(
    "npx",
    ["prisma", "migrate", "deploy", "--schema", path.join(TMP_DIR, "schema.prisma")],
    { cwd: path.join(REPO_ROOT, "apps/api"), env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" },
  );
}

describe("#569 §6.7 — upgrade legado REAL (seed no schema antigo, depois migrate deploy)", () => {
  let db: PrismaClient;
  let backupPath: string;
  const legacy = {
    tenant: "iul-up-real",
    project: "iul-up-real-proj",
    importLegacy: "imp-legacy-569",
    importMixed: "imp-mixed-569",
    purchaseLegacy: "exp-legacy-purchase",
    paymentLegacy: "exp-legacy-payment",
    entryLegacy: "cfe-legacy",
    paymentMixedNew: "exp-mixed-new-payment",
  };

  beforeAll(() => {
    // 1) migrations dir SEM a migration alvo
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.rmSync(DB_FILE, { force: true });
    fs.mkdirSync(TMP_MIGRATIONS, { recursive: true });
    fs.copyFileSync(path.join(REAL_MIGRATIONS, "migration_lock.toml"), path.join(TMP_MIGRATIONS, "migration_lock.toml"));
    for (const name of fs.readdirSync(REAL_MIGRATIONS)) {
      if (name === "migration_lock.toml" || name === TARGET_MIGRATION) continue;
      const src = path.join(REAL_MIGRATIONS, name);
      if (!fs.statSync(src).isDirectory()) continue;
      fs.cpSync(src, path.join(TMP_MIGRATIONS, name), { recursive: true });
    }
    fs.copyFileSync(REAL_SCHEMA, path.join(TMP_DIR, "schema.prisma"));

    // 2) deploy do schema ANTERIOR
    deploy();

    // 3) seed legado via SQL cru (schema antigo — sem colunas invoice_undo_*)
    const seed = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    return (async () => {
      await seed.$executeRawUnsafe(
        `INSERT INTO tenants (id, name, created_at, updated_at)
         VALUES ('${legacy.tenant}', 'Upgrade Real Tenant', datetime('now'), datetime('now'))`,
      );
      await seed.$executeRawUnsafe(
        `INSERT INTO projects (id, tenant_id, type, name, created_at, updated_at)
         VALUES ('${legacy.project}', '${legacy.tenant}', 'PESSOAL', 'Upgrade Real', datetime('now'), datetime('now'))`,
      );
      await seed.$executeRawUnsafe(
        `INSERT INTO bank_accounts (id, project_id, tenant_id, institution, nickname, last4, opening_balance_cents, created_at, updated_at)
         VALUES ('acc-x', '${legacy.project}', '${legacy.tenant}', 'ITAU', 'Conta X', '8700', 0, datetime('now'), datetime('now'))`,
      );
      // lote legado (estado 1): compra PAGO + entry PAGO + pagamento importado, ZERO ledger
      await seed.$executeRawUnsafe(
        `INSERT INTO bank_statement_imports (id, tenant_id, account_id, period_label, source, inserted, total_amount_cents, created_at, updated_at)
         VALUES ('${legacy.importLegacy}', '${legacy.tenant}', 'acc-x', '2025-12', 'OFX', 1, 30000, datetime('now'), datetime('now'))`,
      );
      await seed.$executeRawUnsafe(
        `INSERT INTO expenses (id, tenant_id, project_id, tipo_despesa, titulo, valor, quantidade, valor_total, forma_pagamento, data_pagamento, status, card_last4, created_at, updated_at)
         VALUES ('${legacy.purchaseLegacy}', '${legacy.tenant}', '${legacy.project}', 'OUTROS', 'compra legada', 30000, 1, 30000, 'A_VISTA', datetime('now'), 'PAGO', '4700', datetime('now'), datetime('now'))`,
      );
      await seed.$executeRawUnsafe(
        `INSERT INTO cash_flow_entries (id, tenant_id, project_id, expense_id, valor, tipo, data, categoria, forma_pagamento, status, created_at, updated_at)
         VALUES ('${legacy.entryLegacy}', '${legacy.tenant}', '${legacy.project}', '${legacy.purchaseLegacy}', 30000, 'DESPESA', datetime('now'), 'OUTROS', 'CARTAO_CREDITO', 'PAGO', datetime('now'), datetime('now'))`,
      );
      await seed.$executeRawUnsafe(
        `INSERT INTO expenses (id, tenant_id, project_id, tipo_despesa, titulo, valor, quantidade, valor_total, forma_pagamento, data_pagamento, status, import_id, card_last4, created_at, updated_at)
         VALUES ('${legacy.paymentLegacy}', '${legacy.tenant}', '${legacy.project}', 'PAGAMENTO_FATURA_CARTAO', 'pgto legado', 30000, 1, 30000, 'A_VISTA', datetime('now'), 'PAGO', '${legacy.importLegacy}', '4700', datetime('now'), datetime('now'))`,
      );
      // lote misto (estado 4): 1 pagamento importado legado + 1 pagamento importado "novo" (sem carimbo ainda, schema antigo)
      await seed.$executeRawUnsafe(
        `INSERT INTO bank_statement_imports (id, tenant_id, account_id, period_label, source, inserted, total_amount_cents, created_at, updated_at)
         VALUES ('${legacy.importMixed}', '${legacy.tenant}', 'acc-x', '2026-01', 'OFX', 2, 60000, datetime('now'), datetime('now'))`,
      );
      await seed.$executeRawUnsafe(
        `INSERT INTO expenses (id, tenant_id, project_id, tipo_despesa, titulo, valor, quantidade, valor_total, forma_pagamento, data_pagamento, status, import_id, card_last4, created_at, updated_at)
         VALUES ('${legacy.paymentMixedNew}', '${legacy.tenant}', '${legacy.project}', 'PAGAMENTO_FATURA_CARTAO', 'pgto misto', 60000, 1, 60000, 'A_VISTA', datetime('now'), 'PAGO', '${legacy.importMixed}', '4700', datetime('now'), datetime('now'))`,
      );
      await seed.$disconnect();

      // 4) backup do arquivo antes da migração alvo
      backupPath = `${DB_FILE}.bak`;
      fs.copyFileSync(DB_FILE, backupPath);

      // 5) copia a migration alvo e roda deploy COMPLETO no MESMO banco
      fs.cpSync(
        path.join(REAL_MIGRATIONS, TARGET_MIGRATION),
        path.join(TMP_MIGRATIONS, TARGET_MIGRATION),
        { recursive: true },
      );
      deploy();

      db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      await db.$connect();
    })();
  }, 120_000);

  afterAll(async () => {
    if (db) await db.$disconnect();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.rmSync(DB_FILE, { force: true });
    if (backupPath) fs.rmSync(backupPath, { force: true });
    fs.rmSync(`${DB_FILE}-journal`, { force: true });
  });

  it("Expense/CashFlowEntry legadas preservadas (ids/valores/status) após a migração alvo", async () => {
    const purchase = (await db.$queryRawUnsafe(
      `SELECT id, valor, status FROM expenses WHERE id = '${legacy.purchaseLegacy}'`,
    )) as Array<Record<string, unknown>>;
    expect(purchase).toEqual([{ id: legacy.purchaseLegacy, valor: 30000, status: "PAGO" }]);
    const entry = (await db.$queryRawUnsafe(
      `SELECT id, valor, status FROM cash_flow_entries WHERE id = '${legacy.entryLegacy}'`,
    )) as Array<Record<string, unknown>>;
    expect(entry).toEqual([{ id: legacy.entryLegacy, valor: 30000, status: "PAGO" }]);
    const payments = (await db.$queryRawUnsafe(
      `SELECT count(*) AS c FROM expenses WHERE tipo_despesa = 'PAGAMENTO_FATURA_CARTAO'`,
    )) as Array<{ c: bigint }>;
    expect(Number(payments[0].c)).toBe(2);
  });

  it("5 colunas invoice_undo_* existem e são NULL em TODA linha (sem backfill); imported_invoice_liquidations vazia", async () => {
    const cols = (await db.$queryRawUnsafe("PRAGMA table_info('expenses')")) as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "invoice_undo_state",
        "invoice_undo_parcela_count",
        "invoice_undo_due_month",
        "invoice_undo_card_id",
        "invoice_undo_trail_version",
      ]),
    );
    const notNull = (await db.$queryRawUnsafe(
      `SELECT count(*) AS c FROM expenses
       WHERE invoice_undo_state IS NOT NULL OR invoice_undo_parcela_count IS NOT NULL
          OR invoice_undo_due_month IS NOT NULL OR invoice_undo_card_id IS NOT NULL
          OR invoice_undo_trail_version IS NOT NULL`,
    )) as Array<{ c: bigint }>;
    expect(Number(notNull[0].c)).toBe(0);
    const ledger = (await db.$queryRawUnsafe(
      "SELECT count(*) AS c FROM imported_invoice_liquidations",
    )) as Array<{ c: bigint }>;
    expect(Number(ledger[0].c)).toBe(0);
  });

  it("PRAGMA foreign_key_check zero violações; as 5 FKs (incl. credit_card_imports e credit_cards) existem em PRAGMA foreign_key_list", async () => {
    const fk = (await db.$queryRawUnsafe("PRAGMA foreign_key_check")) as unknown[];
    expect(fk).toHaveLength(0);
    const list = (await db.$queryRawUnsafe(
      "PRAGMA foreign_key_list('imported_invoice_liquidations')",
    )) as Array<{ table: string; to: string }>;
    expect(list).toHaveLength(5);
    const targets = list.map((r) => r.table).sort();
    expect(targets).toEqual([
      "cash_flow_entries",
      "credit_card_imports",
      "credit_cards",
      "expenses",
      "expenses",
    ]);
  });

  it("hard-delete FK-OFF-style não é o caminho: RESTRICT bloqueia apagar um import com liquidação ativa via ORM", async () => {
    // linhas reais que as novas FKs (card_id, import_id) exigem
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO credit_cards (id, project_id, tenant_id, institution, brand, nickname, last4, created_at, updated_at)
       VALUES ('card-569-restrict', '${legacy.project}', '${legacy.tenant}', 'OUTROS', 'Outros', 'restrict', '4700', datetime('now'), datetime('now'))`,
    );
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO credit_card_imports (id, card_id, tenant_id, period_label, source, created_at, updated_at)
       VALUES ('cc-imp-569-restrict', 'card-569-restrict', '${legacy.tenant}', '2025-12', 'OFX', datetime('now'), datetime('now'))`,
    );
    // materializa uma liquidação apontando para esse import
    await db.$executeRawUnsafe(
      `INSERT INTO imported_invoice_liquidations
         (id, tenant_id, payment_expense_id, import_id, purchase_expense_id, cash_flow_entry_id, card_id, prev_status, entry_valor_cents, due_month, created_at)
       VALUES ('iil-restrict-569', '${legacy.tenant}', '${legacy.paymentLegacy}', 'cc-imp-569-restrict', '${legacy.purchaseLegacy}', '${legacy.entryLegacy}', 'card-569-restrict', 'PLANEJADO', 30000, '2025-12', datetime('now'))`,
    );
    await expect(
      db.$executeRawUnsafe(`DELETE FROM credit_card_imports WHERE id = 'cc-imp-569-restrict'`),
    ).rejects.toThrow();
    await db.$executeRawUnsafe(`DELETE FROM imported_invoice_liquidations WHERE id = 'iil-restrict-569'`);
  });

  it("índice único PARCIAL WHERE deleted_at IS NULL existe", async () => {
    const idx = (await db.$queryRawUnsafe(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='imported_invoice_liquidations_entry_active_key'",
    )) as Array<{ sql: string }>;
    expect(idx).toHaveLength(1);
    expect(idx[0].sql).toMatch(/WHERE\s+"?deleted_at"?\s+IS\s+NULL/i);
  });

  it("lote legado sem carimbo continua fail-closed: SELECT do carimbo do pagamento importado é NULL", async () => {
    const stamp = (await db.$queryRawUnsafe(
      `SELECT invoice_undo_state, invoice_undo_trail_version FROM expenses WHERE id = '${legacy.paymentLegacy}'`,
    )) as Array<Record<string, unknown>>;
    expect(stamp[0].invoice_undo_state).toBeNull();
    expect(stamp[0].invoice_undo_trail_version).toBeNull();
  });
});
