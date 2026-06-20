-- CreateTable
CREATE TABLE "category_budgets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tipo_despesa" TEXT NOT NULL,
    "mes" TEXT,
    "valor_limite_cents" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "category_budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "category_budgets_tenant_id_project_id_idx" ON "category_budgets"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "category_budgets_tenant_id_project_id_tipo_despesa_mes_idx" ON "category_budgets"("tenant_id", "project_id", "tipo_despesa", "mes");
