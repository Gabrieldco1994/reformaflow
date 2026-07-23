-- Espelha FinancingInstallment -> Expense (despesa PLANEJADA avulsa, rolling 12m).
-- expense_id nulo = fora da janela, ainda não materializada.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_financing_installments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "financing_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "numero_parcela" INTEGER NOT NULL,
    "data_vencimento" DATETIME NOT NULL,
    "valor_previsto" INTEGER NOT NULL,
    "saldo_devedor_previsto" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVISTO',
    "valor_pago" INTEGER,
    "data_pagamento" DATETIME,
    "expense_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "financing_installments_financing_id_fkey" FOREIGN KEY ("financing_id") REFERENCES "financings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "financing_installments_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_financing_installments" ("created_at", "data_pagamento", "data_vencimento", "deleted_at", "financing_id", "id", "numero_parcela", "project_id", "saldo_devedor_previsto", "status", "tenant_id", "updated_at", "valor_pago", "valor_previsto") SELECT "created_at", "data_pagamento", "data_vencimento", "deleted_at", "financing_id", "id", "numero_parcela", "project_id", "saldo_devedor_previsto", "status", "tenant_id", "updated_at", "valor_pago", "valor_previsto" FROM "financing_installments";
DROP TABLE "financing_installments";
ALTER TABLE "new_financing_installments" RENAME TO "financing_installments";
CREATE UNIQUE INDEX "financing_installments_expense_id_key" ON "financing_installments"("expense_id");
CREATE INDEX "financing_installments_project_id_data_vencimento_idx" ON "financing_installments"("project_id", "data_vencimento");
CREATE UNIQUE INDEX "financing_installments_financing_id_numero_parcela_key" ON "financing_installments"("financing_id", "numero_parcela");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
