#!/usr/bin/env node
// Backfill idempotente e transacional (Fase B, Jornadas): o fix de código
// (ONCE_PER_USER -> ONCE_PER_PROJECT em journey-catalog.ts) só afeta
// bootstraps FUTUROS — journey-bootstrap.service.ts nunca atualiza uma
// jornada já existente. As 6 linhas de JourneyTrigger do onboarding, já
// materializadas em produção, continuam com o repeatPolicy antigo gravado
// até este script rodar.
//
// Só toca um trigger `onboarding:*` com repeatPolicy ONCE_PER_USER cuja
// linha nunca foi editada por um admin (updatedAt === createdAt) — ver
// scripts/lib/backfill-onboarding-repeat-policy.mjs para o critério exato.
//
// Uso:
//   node scripts/backfill-onboarding-repeat-policy.mjs --dry-run
//   node scripts/backfill-onboarding-repeat-policy.mjs
import { PrismaClient } from '@prisma/client';
import { computeRepeatPolicyBackfill } from './lib/backfill-onboarding-repeat-policy.mjs';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

try {
  const journeys = await prisma.journey.findMany({
    where: { key: { startsWith: 'onboarding:' } },
    select: { id: true, key: true },
  });
  const journeyKeyById = new Map(journeys.map((j) => [j.id, j.key]));

  const triggers = await prisma.journeyTrigger.findMany({
    where: { journeyId: { in: journeys.map((j) => j.id) } },
    select: { id: true, journeyId: true, repeatPolicy: true, createdAt: true, updatedAt: true },
  });

  const input = triggers.map((t) => ({
    id: t.id,
    journeyKey: journeyKeyById.get(t.journeyId),
    repeatPolicy: t.repeatPolicy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));

  const updates = computeRepeatPolicyBackfill(input);

  for (const u of updates) {
    console.log(
      `${dryRun ? '[dry-run] would set' : 'setting'} repeatPolicy=ONCE_PER_PROJECT on ${u.journeyKey}`,
    );
  }

  if (!dryRun && updates.length > 0) {
    await prisma.$transaction(
      updates.map((u) =>
        prisma.journeyTrigger.update({
          where: { id: u.id },
          data: { repeatPolicy: 'ONCE_PER_PROJECT' },
        }),
      ),
    );
  }

  console.log(
    `${dryRun ? 'Would update' : 'Updated'} ${updates.length} trigger(s) out of ${triggers.length} onboarding trigger(s).`,
  );
} finally {
  await prisma.$disconnect();
}
