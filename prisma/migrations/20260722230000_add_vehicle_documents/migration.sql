-- CreateTable
CREATE TABLE "vehicle_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "reminder_id" TEXT,
    "tipo" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "numero" TEXT,
    "data_vencimento" DATETIME NOT NULL,
    "lembrete_antecedencia_dias" INTEGER NOT NULL DEFAULT 30,
    "observacoes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "vehicle_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "vehicle_documents_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "reminders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_documents_reminder_id_key" ON "vehicle_documents"("reminder_id");

-- CreateIndex
CREATE INDEX "vehicle_documents_project_id_data_vencimento_idx" ON "vehicle_documents"("project_id", "data_vencimento");

-- CreateIndex
CREATE INDEX "vehicle_documents_tenant_id_idx" ON "vehicle_documents"("tenant_id");

-- Existing CARRO users have a persisted module snapshot. Grant the new module
-- to everyone who already had carInfo, without duplicating the slug.
UPDATE "users"
SET "allowed_modules" = json_insert(
    "allowed_modules",
    '$[#]',
    'vehicleDocuments'
)
WHERE json_valid("allowed_modules")
  AND EXISTS (
    SELECT 1
    FROM json_each("users"."allowed_modules")
    WHERE json_each.value = 'carInfo'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each("users"."allowed_modules")
    WHERE json_each.value = 'vehicleDocuments'
  );
