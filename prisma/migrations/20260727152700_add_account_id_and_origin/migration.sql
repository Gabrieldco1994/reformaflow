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
