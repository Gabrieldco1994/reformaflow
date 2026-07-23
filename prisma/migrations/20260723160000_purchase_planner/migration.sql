-- CreateTable
CREATE TABLE "purchase_scenarios" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "horizonte_meses" INTEGER NOT NULL DEFAULT 6,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "purchase_scenarios_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "purchase_scenario_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scenario_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "valor_cents" INTEGER NOT NULL,
    "entrada_cents" INTEGER,
    "parcelas" INTEGER,
    "taxa_juros_mensal_bps" INTEGER,
    "sistema" TEXT,
    "mes_inicio" TEXT NOT NULL,
    "incluido" BOOLEAN NOT NULL DEFAULT true,
    "source_price_item_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "purchase_scenario_items_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "purchase_scenarios" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "purchase_scenario_items_source_price_item_id_fkey" FOREIGN KEY ("source_price_item_id") REFERENCES "price_monitor_items" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "purchase_scenarios_tenant_id_project_id_idx" ON "purchase_scenarios"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "purchase_scenario_items_tenant_id_project_id_scenario_id_idx" ON "purchase_scenario_items"("tenant_id", "project_id", "scenario_id");
