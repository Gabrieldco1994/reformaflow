-- CreateTable
CREATE TABLE "invoice_adjustments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "card_last4" TEXT NOT NULL,
    "due_month" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "invoice_adjustments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "invoice_adjustments_tenant_id_project_id_due_month_idx" ON "invoice_adjustments"("tenant_id", "project_id", "due_month");

-- CreateIndex
CREATE INDEX "invoice_adjustments_tenant_id_project_id_card_last4_due_month_idx" ON "invoice_adjustments"("tenant_id", "project_id", "card_last4", "due_month");

