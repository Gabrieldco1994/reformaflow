-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN "opening_balance_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bank_accounts" ADD COLUMN "opening_balance_date" DATETIME;
