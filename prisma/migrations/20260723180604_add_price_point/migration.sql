-- CreateTable
CREATE TABLE "price_points" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "price_monitor_item_id" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "store" TEXT,
    "link" TEXT,
    "checked_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_points_price_monitor_item_id_fkey" FOREIGN KEY ("price_monitor_item_id") REFERENCES "price_monitor_items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "price_points_tenant_id_price_monitor_item_id_checked_at_idx" ON "price_points"("tenant_id", "price_monitor_item_id", "checked_at");

