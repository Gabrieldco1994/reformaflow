ALTER TABLE "cross_project_settlements" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'LEGACY_REPLACEMENT'
  CHECK ("mode" IN ('LEGACY_REPLACEMENT', 'ADDITIVE'));
ALTER TABLE "cross_project_settlements" ADD COLUMN "request_id" TEXT;
ALTER TABLE "cross_project_settlements" ADD COLUMN "reversed_at" DATETIME;
ALTER TABLE "cross_project_settlements" ADD COLUMN "reversed_by_user_id" TEXT;
ALTER TABLE "cross_project_settlements" ADD COLUMN "created_by_user_id" TEXT;
ALTER TABLE "cross_project_settlements" ADD COLUMN "source_cash_flow_entry_id" TEXT;
ALTER TABLE "cross_project_settlements" ADD COLUMN "target_paid_cash_flow_entry_id" TEXT;
ALTER TABLE "cross_project_settlements" ADD COLUMN "target_pending_cash_flow_entry_id" TEXT;
ALTER TABLE "cross_project_settlements" ADD COLUMN "snapshot" TEXT
  CHECK ("mode" <> 'ADDITIVE' OR (
    typeof("real_valor") = 'integer' AND "real_valor" > 0 AND
    typeof("parcela_index") = 'integer' AND "parcela_index" >= 0 AND
    "planned_valor" > 0 AND "real_valor" <= "planned_valor" AND
    length("request_id") > 0 AND "request_id" IS NOT NULL AND
    "created_by_user_id" IS NOT NULL AND "source_cash_flow_entry_id" IS NOT NULL AND
    "target_paid_cash_flow_entry_id" IS NOT NULL AND "target_pending_cash_flow_entry_id" IS NOT NULL AND
    "snapshot" IS NOT NULL AND
    (("reversed_at" IS NULL AND "reversed_by_user_id" IS NULL) OR
     ("reversed_at" IS NOT NULL AND "reversed_by_user_id" IS NOT NULL))
  ));
DROP INDEX "cross_project_settlements_target_expense_id_parcela_index_key";
CREATE INDEX "cross_project_settlements_target_expense_id_parcela_index_idx"
  ON "cross_project_settlements"("target_expense_id", "parcela_index");
CREATE UNIQUE INDEX "settlement_legacy_target_idx"
  ON "cross_project_settlements"("target_expense_id", "parcela_index") WHERE "mode" = 'LEGACY_REPLACEMENT';
CREATE UNIQUE INDEX "settlement_active_additive_tuple"
  ON "cross_project_settlements"("source_expense_id", "target_expense_id", "parcela_index")
  WHERE "mode" = 'ADDITIVE' AND "reversed_at" IS NULL;
CREATE UNIQUE INDEX "settlement_tenant_request"
  ON "cross_project_settlements"("tenant_id", "request_id") WHERE "request_id" IS NOT NULL;
CREATE UNIQUE INDEX "settlement_target_paid_cfe"
  ON "cross_project_settlements"("target_paid_cash_flow_entry_id") WHERE "target_paid_cash_flow_entry_id" IS NOT NULL;
