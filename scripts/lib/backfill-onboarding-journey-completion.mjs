// Lógica pura do backfill de JourneyCompletion a partir de Project.onboardedAt
// (Fase B, Jornadas — item (b)). Roda ANTES de remover a coluna onboardedAt
// (ela não sai neste ciclo) e ANTES de remover o shell/redirect (item c).
//
// Para todo Project com onboardedAt preenchido, materializa um
// JourneyCompletion equivalente — usando o MESMO formato de completionKey que
// o runtime real usa para ONCE_PER_PROJECT (journeys-completion.service.ts):
// `${tenantId}:${userId}:${projectId}`. Sem essa linha, o primeiro acesso de
// alguém a um projeto já onboardado (depois do shell sair) reabriria a
// jornada — regressão visível para todo usuário existente, não bug
// silencioso.
//
// Atribuição de userId (Project não guarda "quem completou o onboarding",
// só created_by_user_id, que é opcional):
//   1. `project.createdByUserId`, se presente;
//   2. senão, o ÚNICO usuário do tenant do projeto — só é seguro fazer essa
//      inferência quando o tenant tem exatamente 1 usuário (comum: 26 de 27
//      tenants de produção têm um único usuário). Tenant com 0 ou 2+
//      usuários é AMBÍGUO — nunca adivinha, sempre pula com aviso.
export function computeJourneyCompletionBackfill({
  projects,
  usersByTenantId,
  journeyIdByKey,
  existingCompletionKeys,
}) {
  const creates = [];
  const skipped = [];

  for (const project of projects) {
    if (!project.onboardedAt) continue;

    const journeyKey = `onboarding:${project.type}`;
    const journeyId = journeyIdByKey.get(journeyKey);
    if (!journeyId) {
      skipped.push({ projectId: project.id, reason: 'journey-not-found', journeyKey });
      continue;
    }

    const userId = resolveUserId(project, usersByTenantId);
    if (!userId) {
      skipped.push({ projectId: project.id, reason: 'ambiguous-user', tenantId: project.tenantId });
      continue;
    }

    const completionKey = `${project.tenantId}:${userId}:${project.id}`;
    // Idempotência: `[journeyId, completionKey]` é a chave única real da
    // tabela — uma linha já materializada (rodada anterior deste script, OU
    // uma conclusão real via o runtime) nunca é recriada nem duplicada.
    if (existingCompletionKeys.has(`${journeyId}::${completionKey}`)) {
      skipped.push({ projectId: project.id, reason: 'already-exists', completionKey });
      continue;
    }

    creates.push({
      journeyId,
      tenantId: project.tenantId,
      userId,
      projectId: project.id,
      completionKey,
      completedAt: project.onboardedAt,
    });
  }

  return { creates, skipped };
}

function resolveUserId(project, usersByTenantId) {
  if (project.createdByUserId) return project.createdByUserId;
  const tenantUsers = usersByTenantId.get(project.tenantId) ?? [];
  return tenantUsers.length === 1 ? tenantUsers[0] : null;
}
