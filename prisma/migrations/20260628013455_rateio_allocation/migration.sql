-- CreateTable
CREATE TABLE "rateio_allocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "source_expense_id" TEXT NOT NULL,
    "target_expense_id" TEXT NOT NULL,
    "allocation" INTEGER NOT NULL,
    "planned_status" TEXT NOT NULL,
    "planned_paid" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rateio_allocations_source_expense_id_fkey" FOREIGN KEY ("source_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "rateio_allocations_target_expense_id_fkey" FOREIGN KEY ("target_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "rateio_allocations_source_expense_id_idx" ON "rateio_allocations"("source_expense_id");

-- CreateIndex
CREATE INDEX "rateio_allocations_tenant_id_idx" ON "rateio_allocations"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "rateio_allocations_target_expense_id_key" ON "rateio_allocations"("target_expense_id");
