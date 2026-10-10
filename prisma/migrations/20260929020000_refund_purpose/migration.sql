ALTER TABLE "expenses" ADD COLUMN "refund_purpose_revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "rateio_allocations" ADD COLUMN "is_refund_credit" BOOLEAN NOT NULL DEFAULT false
  CHECK ("is_refund_credit" = false OR "allocation" < 0);

CREATE UNIQUE INDEX "rateio_allocations_refund_source_key"
  ON "rateio_allocations" ("source_expense_id") WHERE "is_refund_credit" = true;
