-- #569 — trilha exata de liquidação de fatura por importação de extrato (PR 1 / degrau).
--
-- ADITIVA, sem backfill: o legado pré-#569 permanece sem carimbo
-- (`invoice_undo_state IS NULL`) e continua fail-closed no `undoImport`.
--
-- Pré-condição do rollback DESTRUTIVO futuro (DROP TABLE + DROP COLUMN), a medir
-- EM PRODUÇÃO (`fly ssh ... sqlite3 -readonly /data/dev.db`), + backup restaurável
-- + autorização explícita do PO (design §3.3 / §3.3.1):
--   SELECT count(*) FROM imported_invoice_liquidations = 0
--   E SELECT count(*) FROM expenses WHERE invoice_undo_state IS NOT NULL = 0
-- "zero linhas na tabela" NÃO basta: um pagamento processado com 0 liquidações
-- carrega carimbo PROCESSED_NONE e nenhuma linha.
--
-- Reversível: DROP TABLE + DROP dos índices + DROP COLUMN das 5 colunas.

-- AlterTable (5 colunas de carimbo, todas NULL default, sem backfill)
ALTER TABLE "expenses" ADD COLUMN "invoice_undo_state" TEXT;
ALTER TABLE "expenses" ADD COLUMN "invoice_undo_parcela_count" INTEGER;
ALTER TABLE "expenses" ADD COLUMN "invoice_undo_due_month" TEXT;
ALTER TABLE "expenses" ADD COLUMN "invoice_undo_card_id" TEXT;
ALTER TABLE "expenses" ADD COLUMN "invoice_undo_trail_version" INTEGER;

-- CreateTable
CREATE TABLE "imported_invoice_liquidations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "payment_expense_id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "purchase_expense_id" TEXT NOT NULL,
    "cash_flow_entry_id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "prev_status" TEXT NOT NULL,
    "entry_valor_cents" INTEGER NOT NULL,
    "parcela" TEXT,
    "due_month" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "imported_invoice_liquidations_payment_expense_id_fkey" FOREIGN KEY ("payment_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_invoice_liquidations_purchase_expense_id_fkey" FOREIGN KEY ("purchase_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_invoice_liquidations_cash_flow_entry_id_fkey" FOREIGN KEY ("cash_flow_entry_id") REFERENCES "cash_flow_entries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_invoice_liquidations_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "credit_card_imports" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_invoice_liquidations_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "credit_cards" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex (UNIQUE PARCIAL — Prisma não expressa `WHERE`, escrito à mão)
-- D1 anti dupla-reivindicação: no máximo UMA liquidação ATIVA por CashFlowEntry.
CREATE UNIQUE INDEX "imported_invoice_liquidations_entry_active_key" ON "imported_invoice_liquidations"("cash_flow_entry_id") WHERE "deleted_at" IS NULL;

-- CreateIndex (auxiliares)
CREATE INDEX "imported_invoice_liquidations_import_id_idx" ON "imported_invoice_liquidations"("import_id");
CREATE INDEX "imported_invoice_liquidations_payment_expense_id_idx" ON "imported_invoice_liquidations"("payment_expense_id");
CREATE INDEX "imported_invoice_liquidations_tenant_id_idx" ON "imported_invoice_liquidations"("tenant_id");
