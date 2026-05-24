-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "bank_last4" TEXT;

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "agency" TEXT,
    "account_number" TEXT,
    "last4" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "bank_accounts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "bank_statement_imports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "period_label" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "file_name" TEXT,
    "file_size" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "duplicated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "total_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "bank_statement_imports_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "bank_accounts_project_id_idx" ON "bank_accounts"("project_id");

-- CreateIndex
CREATE INDEX "bank_accounts_tenant_id_idx" ON "bank_accounts"("tenant_id");

-- CreateIndex
CREATE INDEX "bank_statement_imports_account_id_idx" ON "bank_statement_imports"("account_id");

-- CreateIndex
CREATE INDEX "bank_statement_imports_tenant_id_idx" ON "bank_statement_imports"("tenant_id");
