-- CreateTable
CREATE TABLE "car_info" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "marca" TEXT,
    "modelo" TEXT,
    "ano_fabricacao" INTEGER,
    "ano_modelo" INTEGER,
    "cor" TEXT,
    "placa" TEXT,
    "tabela_fipe" INTEGER,
    "valor_pago" INTEGER,
    "km_atual" INTEGER,
    "km_ultima_revisao" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "car_info_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "car_info_project_id_key" ON "car_info"("project_id");
