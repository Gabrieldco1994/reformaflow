-- CreateTable
CREATE TABLE "budget_allocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "source_project_id" TEXT NOT NULL,
    "source_receipt_id" TEXT,
    "target_project_id" TEXT NOT NULL,
    "valor" INTEGER NOT NULL,
    "descricao" TEXT,
    "mes" TEXT NOT NULL,
    "data_alocacao" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "budget_allocations_source_project_id_fkey" FOREIGN KEY ("source_project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_allocations_source_receipt_id_fkey" FOREIGN KEY ("source_receipt_id") REFERENCES "receipts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "budget_allocations_target_project_id_fkey" FOREIGN KEY ("target_project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_cash_flow_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "receipt_id" TEXT,
    "expense_id" TEXT,
    "budget_allocation_id" TEXT,
    "valor" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "data" DATETIME NOT NULL,
    "categoria" TEXT NOT NULL,
    "subcategoria" TEXT,
    "ambiente" TEXT,
    "forma_pagamento" TEXT,
    "status" TEXT NOT NULL,
    "parcela" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "cash_flow_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cash_flow_entries_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "cash_flow_entries_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "cash_flow_entries_budget_allocation_id_fkey" FOREIGN KEY ("budget_allocation_id") REFERENCES "budget_allocations" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_cash_flow_entries" ("ambiente", "categoria", "created_at", "data", "deleted_at", "expense_id", "forma_pagamento", "id", "parcela", "project_id", "receipt_id", "status", "subcategoria", "tenant_id", "tipo", "updated_at", "valor") SELECT "ambiente", "categoria", "created_at", "data", "deleted_at", "expense_id", "forma_pagamento", "id", "parcela", "project_id", "receipt_id", "status", "subcategoria", "tenant_id", "tipo", "updated_at", "valor" FROM "cash_flow_entries";
DROP TABLE "cash_flow_entries";
ALTER TABLE "new_cash_flow_entries" RENAME TO "cash_flow_entries";
CREATE INDEX "cash_flow_entries_project_id_data_idx" ON "cash_flow_entries"("project_id", "data");
CREATE INDEX "cash_flow_entries_receipt_id_idx" ON "cash_flow_entries"("receipt_id");
CREATE INDEX "cash_flow_entries_expense_id_idx" ON "cash_flow_entries"("expense_id");
CREATE INDEX "cash_flow_entries_budget_allocation_id_idx" ON "cash_flow_entries"("budget_allocation_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "budget_allocations_tenant_id_source_project_id_idx" ON "budget_allocations"("tenant_id", "source_project_id");

-- CreateIndex
CREATE INDEX "budget_allocations_tenant_id_target_project_id_idx" ON "budget_allocations"("tenant_id", "target_project_id");

-- CreateIndex
CREATE INDEX "budget_allocations_mes_idx" ON "budget_allocations"("mes");
