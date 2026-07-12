-- AlterTable
ALTER TABLE "maintenance_logs" ADD COLUMN "generated_by" TEXT;

-- AlterTable
ALTER TABLE "reminders" ADD COLUMN "generated_by" TEXT;
