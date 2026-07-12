-- CreateTable
CREATE TABLE "plants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "localizacao" TEXT,
    "especie_popular" TEXT,
    "especie_cientifica" TEXT,
    "ultima_saude" TEXT,
    "ultimo_risco_pet" TEXT,
    "ultimo_diagnostico_em" DATETIME,
    "observacoes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "plants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "plant_diagnosis_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "plant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "especie_popular" TEXT,
    "especie_cientifica" TEXT,
    "confianca_especie" REAL,
    "saude_status" TEXT,
    "saude_confianca" REAL,
    "risco_pet" TEXT,
    "diagnosis_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plant_diagnosis_logs_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_maintenance_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plant_id" TEXT,
    "tipo" TEXT NOT NULL,
    "data_realizada" DATETIME NOT NULL,
    "data_proxima" DATETIME,
    "quilometragem" INTEGER,
    "custo" INTEGER,
    "fornecedor" TEXT,
    "observacoes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "maintenance_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "maintenance_logs_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_maintenance_logs" ("created_at", "custo", "data_proxima", "data_realizada", "deleted_at", "fornecedor", "id", "observacoes", "project_id", "quilometragem", "tenant_id", "tipo", "updated_at") SELECT "created_at", "custo", "data_proxima", "data_realizada", "deleted_at", "fornecedor", "id", "observacoes", "project_id", "quilometragem", "tenant_id", "tipo", "updated_at" FROM "maintenance_logs";
DROP TABLE "maintenance_logs";
ALTER TABLE "new_maintenance_logs" RENAME TO "maintenance_logs";
CREATE INDEX "maintenance_logs_project_id_idx" ON "maintenance_logs"("project_id");
CREATE INDEX "maintenance_logs_plant_id_idx" ON "maintenance_logs"("plant_id");
CREATE TABLE "new_reminders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plant_id" TEXT,
    "titulo" TEXT NOT NULL,
    "descricao" TEXT,
    "data" DATETIME NOT NULL,
    "recorrencia" TEXT NOT NULL DEFAULT 'UNICA',
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "prioridade" TEXT NOT NULL DEFAULT 'MEDIA',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "reminders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reminders_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_reminders" ("created_at", "data", "deleted_at", "descricao", "id", "prioridade", "project_id", "recorrencia", "status", "tenant_id", "titulo", "updated_at") SELECT "created_at", "data", "deleted_at", "descricao", "id", "prioridade", "project_id", "recorrencia", "status", "tenant_id", "titulo", "updated_at" FROM "reminders";
DROP TABLE "reminders";
ALTER TABLE "new_reminders" RENAME TO "reminders";
CREATE INDEX "reminders_project_id_idx" ON "reminders"("project_id");
CREATE INDEX "reminders_data_idx" ON "reminders"("data");
CREATE INDEX "reminders_plant_id_idx" ON "reminders"("plant_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "plants_project_id_idx" ON "plants"("project_id");

-- CreateIndex
CREATE INDEX "plant_diagnosis_logs_plant_id_idx" ON "plant_diagnosis_logs"("plant_id");

-- CreateIndex
CREATE INDEX "plant_diagnosis_logs_project_id_idx" ON "plant_diagnosis_logs"("project_id");
