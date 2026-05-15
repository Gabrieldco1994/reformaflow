-- CreateTable
CREATE TABLE "schedule_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "data_inicio" DATETIME NOT NULL,
    "trabalha_dias_uteis" BOOLEAN NOT NULL DEFAULT true,
    "trabalha_sabados" BOOLEAN NOT NULL DEFAULT false,
    "linha_base_data" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "schedule_configs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "schedule_stages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "schedule_stages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "schedule_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stage_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "nome" TEXT NOT NULL,
    "duracao" INTEGER NOT NULL DEFAULT 1,
    "data_inicio" DATETIME,
    "data_termino" DATETIME,
    "predecessoras" TEXT,
    "valor_orcado" INTEGER,
    "custo_real" INTEGER,
    "percentual_concluido" REAL NOT NULL DEFAULT 0,
    "ordem" INTEGER NOT NULL,
    "data_inicio_base" DATETIME,
    "data_termino_base" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "schedule_tasks_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "schedule_stages" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "schedule_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "schedule_holidays" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "data" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "schedule_holidays_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_configs_project_id_key" ON "schedule_configs"("project_id");

-- CreateIndex
CREATE INDEX "schedule_stages_project_id_idx" ON "schedule_stages"("project_id");

-- CreateIndex
CREATE INDEX "schedule_tasks_stage_id_idx" ON "schedule_tasks"("stage_id");

-- CreateIndex
CREATE INDEX "schedule_tasks_project_id_idx" ON "schedule_tasks"("project_id");

-- CreateIndex
CREATE INDEX "schedule_holidays_project_id_idx" ON "schedule_holidays"("project_id");
