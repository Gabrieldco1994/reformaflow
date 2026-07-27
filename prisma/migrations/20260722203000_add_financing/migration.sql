-- CreateTable
CREATE TABLE "financings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "instituicao" TEXT,
    "sistema" TEXT NOT NULL DEFAULT 'PRICE',
    "valor_total_financiado" INTEGER NOT NULL,
    "taxa_juros_mensal_bps" INTEGER NOT NULL,
    "prazo_meses" INTEGER NOT NULL,
    "data_primeira_parcela" DATETIME NOT NULL,
    "dia_vencimento" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ATIVO',
    "observacoes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "financings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "financings_project_id_key" ON "financings"("project_id");

-- CreateTable
CREATE TABLE "financing_installments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "financing_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "numero_parcela" INTEGER NOT NULL,
    "data_vencimento" DATETIME NOT NULL,
    "valor_previsto" INTEGER NOT NULL,
    "saldo_devedor_previsto" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVISTO',
    "valor_pago" INTEGER,
    "data_pagamento" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "financing_installments_financing_id_fkey" FOREIGN KEY ("financing_id") REFERENCES "financings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "financing_installments_financing_id_numero_parcela_key" ON "financing_installments"("financing_id", "numero_parcela");

-- CreateIndex
CREATE INDEX "financing_installments_project_id_data_vencimento_idx" ON "financing_installments"("project_id", "data_vencimento");
