-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "card_last4" TEXT;
ALTER TABLE "expenses" ADD COLUMN "external_id" TEXT;
ALTER TABLE "expenses" ADD COLUMN "import_id" TEXT;

-- CreateTable
CREATE TABLE "credit_cards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT 'Outros',
    "nickname" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "limit_total_cents" INTEGER,
    "limit_available_cents" INTEGER,
    "closing_day" INTEGER,
    "due_day" INTEGER,
    "notes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "credit_cards_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "credit_card_imports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "card_id" TEXT NOT NULL,
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
    CONSTRAINT "credit_card_imports_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "credit_cards" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "credit_cards_project_id_idx" ON "credit_cards"("project_id");

-- CreateIndex
CREATE INDEX "credit_cards_tenant_id_idx" ON "credit_cards"("tenant_id");

-- CreateIndex
CREATE INDEX "credit_card_imports_card_id_idx" ON "credit_card_imports"("card_id");

-- CreateIndex
CREATE INDEX "credit_card_imports_tenant_id_idx" ON "credit_card_imports"("tenant_id");
