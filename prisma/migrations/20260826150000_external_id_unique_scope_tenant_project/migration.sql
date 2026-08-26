-- #570 (Fase 2): unique index físico para `externalId`, escopado por
-- (tenant_id, project_id, external_id) — não (tenant_id, external_id).
--
-- Motivo do escopo com project_id: o dedupe de aplicação
-- (`findExistingExternalIds` em bank-account.service.ts e
-- credit-card.service.ts) SEMPRE filtrou por project_id além de
-- tenant_id/external_id. Uma constraint tenant-wide (sem project_id)
-- responderia P2002 num cenário que a aplicação já considera válido
-- (mesmo externalId em projetos DIFERENTES do mesmo tenant), reabrindo
-- o mesmo formato de bug do incidente #586: índice físico desalinhado
-- da lógica de aplicação. Ver src/bank-account/__tests__/
-- external-id-unique-constraint-scope.spec.ts para o cenário coberto.
--
-- Índice FÍSICO, sem `WHERE deleted_at IS NULL`: exclusão é definitiva
-- (mesmo padrão de #568/#570 Fase 1) — uma linha soft-deletada continua
-- ocupando o slot de unicidade, então reimportar o mesmo dado após
-- soft-delete é bloqueado tanto pelo dedupe de aplicação quanto por
-- esta constraint em profundidade.
--
-- `receipts` mantém o `@@index([projectId, externalId])` pré-existente
-- (colunas líder diferentes, serve padrão de consulta distinto) e
-- ganha esta unique por cima — decisão do PO, não remover o índice
-- antigo.

-- CreateIndex
CREATE UNIQUE INDEX "expenses_tenant_id_project_id_external_id_key" ON "expenses"("tenant_id", "project_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_tenant_id_project_id_external_id_key" ON "receipts"("tenant_id", "project_id", "external_id");
