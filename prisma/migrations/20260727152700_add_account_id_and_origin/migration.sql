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

-- Note: Foreign key constraints are defined in schema.prisma and are
-- automatically managed by Prisma. PRAGMA statements are SQLite-specific
-- and break in PostgreSQL CI environments, so they are not used here.
