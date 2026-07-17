-- Columns already exist from previous migrations
-- CreateIndex
CREATE INDEX IF NOT EXISTS "price_monitor_items_target_price_idx" ON "price_monitor_items"("target_price");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "price_monitor_items_monitoring_end_date_idx" ON "price_monitor_items"("monitoring_end_date");
