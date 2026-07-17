-- CreateTable
CREATE TABLE "price_monitor_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "query" TEXT,
    "product_url" TEXT,
    "notes" TEXT,
    "reference_price_cents" INTEGER,
    "target_price_cents" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_best_price_cents" INTEGER,
    "last_best_store" TEXT,
    "last_best_link" TEXT,
    "last_checked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "price_monitor_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "price_monitor_items_project_id_is_active_idx" ON "price_monitor_items"("project_id", "is_active");

-- CreateIndex
CREATE INDEX "price_monitor_items_tenant_id_project_id_title_idx" ON "price_monitor_items"("tenant_id", "project_id", "title");
