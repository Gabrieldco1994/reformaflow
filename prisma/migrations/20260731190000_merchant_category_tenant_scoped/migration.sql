-- MerchantCategory: escopo por tenant (corrige vazamento entre tenants, issue #381).
--
-- `tenant_id` NULL = regra GLOBAL (só ADMIN promove). Lookup é tenant-first,
-- depois fallback global. A tabela é um CACHE de classificador que se reconstrói
-- sozinho por tenant (miss → IA reclassifica e regrava), então zerar o cache
-- legado não perde conhecimento genérico — só evita reatribuir chaves privadas
-- (nomes de contraparte PIX, chaves com data embutida) ao tenant errado.
--
-- Zera todas as ~130 linhas legadas (sem coluna de autoria confiável) recriando
-- a tabela com o novo unique composto. Regra nunca muta valor/caixa.

DROP TABLE "merchant_categories";

CREATE TABLE "merchant_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT,
    "merchant_key" TEXT NOT NULL,
    "merchant_sample" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "source" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "ai_response" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "merchant_categories_tenant_id_merchant_key_key" ON "merchant_categories"("tenant_id", "merchant_key");
CREATE INDEX "merchant_categories_category_idx" ON "merchant_categories"("category");
