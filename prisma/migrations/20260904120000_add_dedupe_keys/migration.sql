-- #659 — dedupe de importação cross-origin (Tier A + Tier B).
--
-- Os 3 canais de importação (Carteira/receipt, extrato/bank, fatura/card) semeiam
-- `external_id` com um `seed` diferente por canal, então o MESMO arquivo importado
-- por 2 canais não casa e o dinheiro dobra no Caixa consolidado. A correção usa
-- 2 chaves independentes de canal:
--
--   dedupe_key_strong  — FITID (id do banco) OU hash dos bytes do arquivo. Prova
--                        de "é a MESMA transação" → auto-skip. UNIQUE PARCIAL como
--                        rede da corrida entre canais concorrentes.
--   dedupe_key_natural — (tenant, project, date, amount, merchant, ordinal) sem
--                        respaldo de id/arquivo. Colide entre arquivos diferentes
--                        (dois cafés iguais no mesmo dia) → NUNCA auto-skip, só
--                        superfície `possibleDuplicate`. Índice não-único.
--
-- Ambos os modelos já têm `deleted_at` → não entram em `modelsWithoutSoftDelete`.
-- Reversível: DROP dos índices + DROP COLUMN.

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN "dedupe_key_strong" TEXT;
ALTER TABLE "expenses" ADD COLUMN "dedupe_key_natural" TEXT;
ALTER TABLE "receipts" ADD COLUMN "dedupe_key_strong" TEXT;
ALTER TABLE "receipts" ADD COLUMN "dedupe_key_natural" TEXT;

-- CreateIndex (UNIQUE PARCIAL — Prisma não expressa `WHERE`, escrito à mão)
CREATE UNIQUE INDEX "expenses_dedupe_key_strong_key" ON "expenses"("dedupe_key_strong") WHERE "dedupe_key_strong" IS NOT NULL;
CREATE UNIQUE INDEX "receipts_dedupe_key_strong_key" ON "receipts"("dedupe_key_strong") WHERE "dedupe_key_strong" IS NOT NULL;

-- CreateIndex
CREATE INDEX "expenses_dedupe_key_natural_idx" ON "expenses"("dedupe_key_natural");
CREATE INDEX "receipts_dedupe_key_natural_idx" ON "receipts"("dedupe_key_natural");
