#!/usr/bin/env node
// Backfill idempotente e transacional (Fase B, Jornadas — item b): para todo
// `Project` com `onboardedAt` preenchido, materializa um `JourneyCompletion`
// equivalente. Sem isto, o primeiro acesso de alguém a um projeto já
// onboardado (depois do shell/redirect sair, item c) reabriria a jornada —
// regressão visível para todo usuário existente.
//
// `onboardedAt` NÃO é removido neste ciclo (fica como prova/fallback até a
// paridade estar provada em produção).
//
// Atribuição de userId — ver scripts/lib/backfill-onboarding-journey-completion.mjs:
// 1) Project.createdByUserId, se presente; 2) senão, o único usuário do
// tenant (só quando o tenant tem exatamente 1); caso ambíguo, PULA e
// reporta — nunca adivinha a quem atribuir a conclusão.
//
// Uso:
//   node scripts/backfill-onboarding-journey-completion.mjs --dry-run
//   node scripts/backfill-onboarding-journey-completion.mjs
import { PrismaClient } from '@prisma/client';
import { computeJourneyCompletionBackfill } from './lib/backfill-onboarding-journey-completion.mjs';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

try {
  const projects = await prisma.project.findMany({
    where: { deletedAt: null, onboardedAt: { not: null } },
    select: { id: true, tenantId: true, type: true, createdByUserId: true, onboardedAt: true },
  });

  const tenantIds = [...new Set(projects.map((p) => p.tenantId))];
  const users = await prisma.user.findMany({
    where: { tenantId: { in: tenantIds } },
    select: { id: true, tenantId: true },
  });
  const usersByTenantId = new Map();
  for (const u of users) {
    const list = usersByTenantId.get(u.tenantId) ?? [];
    list.push(u.id);
    usersByTenantId.set(u.tenantId, list);
  }

  const journeys = await prisma.journey.findMany({
    where: { key: { startsWith: 'onboarding:' } },
    select: { id: true, key: true },
  });
  const journeyIdByKey = new Map(journeys.map((j) => [j.key, j.id]));

  const completions = await prisma.journeyCompletion.findMany({
    where: { journeyId: { in: journeys.map((j) => j.id) } },
    select: { journeyId: true, completionKey: true },
  });
  const existingCompletionKeys = new Set(
    completions.map((c) => `${c.journeyId}::${c.completionKey}`),
  );

  const { creates, skipped } = computeJourneyCompletionBackfill({
    projects,
    usersByTenantId,
    journeyIdByKey,
    existingCompletionKeys,
  });

  for (const c of creates) {
    console.log(
      `${dryRun ? '[dry-run] would create' : 'creating'} completion for project ${c.projectId} (user ${c.userId})`,
    );
  }
  for (const s of skipped) {
    console.log(`[skip] project ${s.projectId}: ${s.reason}${s.reason === 'ambiguous-user' ? ` (tenant ${s.tenantId})` : ''}`);
  }

  if (!dryRun && creates.length > 0) {
    await prisma.$transaction(
      creates.map((c) =>
        prisma.journeyCompletion.create({
          data: {
            journeyId: c.journeyId,
            tenantId: c.tenantId,
            userId: c.userId,
            projectId: c.projectId,
            completionKey: c.completionKey,
            completedAt: c.completedAt,
          },
        }),
      ),
    );
  }

  console.log(
    `${dryRun ? 'Would create' : 'Created'} ${creates.length} completion(s), skipped ${skipped.length} project(s), out of ${projects.length} onboarded project(s).`,
  );
} finally {
  await prisma.$disconnect();
}
