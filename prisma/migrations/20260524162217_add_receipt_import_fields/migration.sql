-- AlterTable
ALTER TABLE "receipts" ADD COLUMN "bank_last4" TEXT;
ALTER TABLE "receipts" ADD COLUMN "descricao" TEXT;
ALTER TABLE "receipts" ADD COLUMN "external_id" TEXT;
ALTER TABLE "receipts" ADD COLUMN "import_id" TEXT;

-- CreateIndex
CREATE INDEX "receipts_project_id_external_id_idx" ON "receipts"("project_id", "external_id");
