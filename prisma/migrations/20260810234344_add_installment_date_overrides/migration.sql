-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "installment_date_overrides" TEXT;

-- AlterTable
ALTER TABLE "rateio_allocations" ADD COLUMN "planned_installment_date_overrides" TEXT;
