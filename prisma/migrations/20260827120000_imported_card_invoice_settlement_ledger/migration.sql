-- Ledger nativo de liquidação automática de fatura por importação de extrato (issue #569).
--
-- Substitui `Expense.settled_invoice_key` (a migration `20260826194251_add_settled_invoice_key`
-- foi removida antes do merge — nunca chegou ao `main`). A chave "{last4}:{dueMonth}"
-- era ambígua no fallback por fatura importada e forçava `undoImport` a adivinhar o
-- mês do pagamento para registros sem chave.
--
-- Agora a importação grava, na MESMA transação, exatamente quais `cash_flow_entries`
-- cada `PAGAMENTO_FATURA_CARTAO` moveu de PLANEJADO → PAGO. `undoImport` reverte só
-- esses ids (ainda ativos e PAGO), nunca uma reconstrução do ciclo pelos dias atuais
-- do cartão.
--
-- FKs com ON DELETE RESTRICT (nada aqui é destrutivo — Expense/CashFlowEntry usam
-- soft-delete). Índice único parcial garante que uma parcela só seja reivindicada
-- por uma liquidação ATIVA por vez.

-- CreateTable
CREATE TABLE "imported_card_invoice_settlements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "bank_statement_import_id" TEXT NOT NULL,
    "payment_expense_id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "card_project_id" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "target_due_month" TEXT,
    "matched_card_import_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_at" DATETIME,
    CONSTRAINT "imported_card_invoice_settlements_payment_expense_id_fkey" FOREIGN KEY ("payment_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_card_invoice_settlements_bank_statement_import_id_fkey" FOREIGN KEY ("bank_statement_import_id") REFERENCES "bank_statement_imports" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_card_invoice_settlements_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "credit_cards" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_card_invoice_settlements_card_project_id_fkey" FOREIGN KEY ("card_project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_card_invoice_settlements_matched_card_import_id_fkey" FOREIGN KEY ("matched_card_import_id") REFERENCES "credit_card_imports" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "imported_card_invoice_settlement_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "cash_flow_entry_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" DATETIME,
    CONSTRAINT "imported_card_invoice_settlement_entries_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "imported_card_invoice_settlements" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "imported_card_invoice_settlement_entries_cash_flow_entry_id_fkey" FOREIGN KEY ("cash_flow_entry_id") REFERENCES "cash_flow_entries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "imported_card_invoice_settlements_payment_expense_id_key" ON "imported_card_invoice_settlements"("payment_expense_id");
CREATE INDEX "imported_card_invoice_settlements_tenant_id_idx" ON "imported_card_invoice_settlements"("tenant_id");
CREATE INDEX "imported_card_invoice_settlements_bank_statement_import_id_idx" ON "imported_card_invoice_settlements"("bank_statement_import_id");
CREATE INDEX "imported_card_invoice_settlements_card_id_idx" ON "imported_card_invoice_settlements"("card_id");

-- CreateIndex
CREATE INDEX "imported_card_invoice_settlement_entries_settlement_id_idx" ON "imported_card_invoice_settlement_entries"("settlement_id");
CREATE INDEX "imported_card_invoice_settlement_entries_tenant_id_idx" ON "imported_card_invoice_settlement_entries"("tenant_id");
CREATE INDEX "imported_card_invoice_settlement_entries_cash_flow_entry_id_idx" ON "imported_card_invoice_settlement_entries"("cash_flow_entry_id");

-- CreateIndex: uma parcela só pode estar reivindicada por UMA liquidação ativa
CREATE UNIQUE INDEX "imported_card_invoice_settlement_entries_active_cash_flow_entry_key" ON "imported_card_invoice_settlement_entries"("cash_flow_entry_id") WHERE "released_at" IS NULL;
