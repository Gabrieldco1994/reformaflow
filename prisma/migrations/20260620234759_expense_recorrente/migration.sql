-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_expenses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tipo_despesa" TEXT NOT NULL,
    "categoria_mao_de_obra" TEXT,
    "room_id" TEXT,
    "valor" INTEGER NOT NULL,
    "quantidade" INTEGER NOT NULL DEFAULT 1,
    "valor_total" INTEGER NOT NULL,
    "titulo" TEXT,
    "fornecedor" TEXT,
    "link" TEXT,
    "image_url" TEXT,
    "forma_pagamento" TEXT NOT NULL,
    "data_pagamento" DATETIME,
    "quantidade_parcela" INTEGER,
    "data_inicio_parcela" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PLANEJADO',
    "recorrente" BOOLEAN NOT NULL DEFAULT false,
    "recorrencia_fim" DATETIME,
    "paid_parcelas" TEXT,
    "planned_expense_id" TEXT,
    "settled_by_expense_id" TEXT,
    "import_id" TEXT,
    "external_id" TEXT,
    "series_key" TEXT,
    "card_last4" TEXT,
    "bank_last4" TEXT,
    "linked_expense_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "expenses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "expenses_planned_expense_id_fkey" FOREIGN KEY ("planned_expense_id") REFERENCES "expenses" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_expenses" ("bank_last4", "card_last4", "categoria_mao_de_obra", "created_at", "data_inicio_parcela", "data_pagamento", "deleted_at", "external_id", "forma_pagamento", "fornecedor", "id", "image_url", "import_id", "link", "linked_expense_id", "paid_parcelas", "planned_expense_id", "project_id", "quantidade", "quantidade_parcela", "room_id", "series_key", "settled_by_expense_id", "status", "tenant_id", "tipo_despesa", "titulo", "updated_at", "valor", "valor_total") SELECT "bank_last4", "card_last4", "categoria_mao_de_obra", "created_at", "data_inicio_parcela", "data_pagamento", "deleted_at", "external_id", "forma_pagamento", "fornecedor", "id", "image_url", "import_id", "link", "linked_expense_id", "paid_parcelas", "planned_expense_id", "project_id", "quantidade", "quantidade_parcela", "room_id", "series_key", "settled_by_expense_id", "status", "tenant_id", "tipo_despesa", "titulo", "updated_at", "valor", "valor_total" FROM "expenses";
DROP TABLE "expenses";
ALTER TABLE "new_expenses" RENAME TO "expenses";
CREATE UNIQUE INDEX "expenses_planned_expense_id_key" ON "expenses"("planned_expense_id");
CREATE UNIQUE INDEX "expenses_settled_by_expense_id_key" ON "expenses"("settled_by_expense_id");
CREATE INDEX "expenses_linked_expense_id_idx" ON "expenses"("linked_expense_id");
CREATE INDEX "expenses_series_key_idx" ON "expenses"("series_key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
