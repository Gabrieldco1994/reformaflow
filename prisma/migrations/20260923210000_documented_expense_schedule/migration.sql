ALTER TABLE "expenses" ADD COLUMN "documented_schedule" TEXT;
ALTER TABLE "cash_flow_entries" ADD COLUMN "invoice_due_month" TEXT;
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_documented_schedule" TEXT;
