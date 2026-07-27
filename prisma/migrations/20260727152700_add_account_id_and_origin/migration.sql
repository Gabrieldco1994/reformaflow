-- AddColumn accountId and origin to Receipt
ALTER TABLE "receipts" ADD COLUMN "account_id" TEXT;
ALTER TABLE "receipts" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'none';

-- AddColumn accountId and origin to Expense
ALTER TABLE "expenses" ADD COLUMN "account_id" TEXT;
ALTER TABLE "expenses" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'none';

-- CreateIndex for Receipt.accountId
CREATE INDEX "receipts_account_id_idx" ON "receipts"("account_id");

-- CreateIndex for Expense.accountId
CREATE INDEX "expenses_account_id_idx" ON "expenses"("account_id");

-- Add foreign key constraints
PRAGMA foreign_keys=OFF;

-- For receipts
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- For expenses
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

PRAGMA foreign_keys=ON;
