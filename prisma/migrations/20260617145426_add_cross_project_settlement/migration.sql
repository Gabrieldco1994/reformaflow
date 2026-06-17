-- CreateTable
CREATE TABLE "cross_project_settlements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "source_expense_id" TEXT NOT NULL,
    "target_expense_id" TEXT NOT NULL,
    "parcela_index" INTEGER NOT NULL,
    "real_valor" INTEGER NOT NULL,
    "planned_valor" INTEGER NOT NULL,
    "planned_status" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cross_project_settlements_source_expense_id_fkey" FOREIGN KEY ("source_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cross_project_settlements_target_expense_id_fkey" FOREIGN KEY ("target_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "cross_project_settlements_source_expense_id_idx" ON "cross_project_settlements"("source_expense_id");

-- CreateIndex
CREATE INDEX "cross_project_settlements_tenant_id_idx" ON "cross_project_settlements"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cross_project_settlements_target_expense_id_parcela_index_key" ON "cross_project_settlements"("target_expense_id", "parcela_index");
