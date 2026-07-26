-- Série recorrente EXPLÍCITA: preenchida quando a despesa nasce do fluxo de
-- recorrência. Aditiva e nullable — despesas existentes seguem sem série
-- explícita e continuam sendo detectadas por heurística.
ALTER TABLE "expenses" ADD COLUMN "recurrence_key" TEXT;
CREATE INDEX "expenses_recurrence_key_idx" ON "expenses"("recurrence_key");
