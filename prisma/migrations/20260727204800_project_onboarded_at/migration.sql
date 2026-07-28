-- Onboarding guiado por projeto: null = pendente (1º acesso ainda não visto).
-- Projetos já existentes recebem backfill = created_at para não reabrir o
-- wizard pra ninguém que já usa o produto.
ALTER TABLE "projects" ADD COLUMN "onboarded_at" DATETIME;
UPDATE "projects" SET "onboarded_at" = "created_at" WHERE "onboarded_at" IS NULL;
