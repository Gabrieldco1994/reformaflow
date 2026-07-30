#!/usr/bin/env node
// Backfill idempotente e transacional (Fase B, Jornadas): corrige jornadas
// `onboarding:PESSOAL` já materializadas por `journey-bootstrap.service.ts`
// ANTES do fix de `enabledByDefault` em journey-catalog.ts — essas linhas
// nasceram com `expense`/`import`/`expense-import` todos `enabled: true`
// (usuário via 3 pedidos seguidos pra lançar a mesma 1ª despesa).
//
// Só toca `expense`/`import` de jornadas `onboarding:*` cuja linha nunca foi
// editada por um admin (updatedAt === createdAt) — ver
// `scripts/lib/backfill-onboarding-expense-import-parity.mjs` para o
// critério exato. Uma escolha deliberada do admin nunca é sobrescrita.
//
// Uso:
//   node scripts/backfill-onboarding-expense-import-parity.mjs --dry-run
//   node scripts/backfill-onboarding-expense-import-parity.mjs
import { PrismaClient } from '@prisma/client';
import { computeExpenseImportParityUpdates } from './lib/backfill-onboarding-expense-import-parity.mjs';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

try {
  const journeys = await prisma.journey.findMany({
    where: { key: { startsWith: 'onboarding:' } },
    select: { id: true, key: true },
  });
  const journeyIds = journeys.map((j) => j.id);

  const steps = await prisma.journeyStep.findMany({
    where: { journeyId: { in: journeyIds } },
    select: {
      id: true,
      journeyId: true,
      stepKey: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const updates = computeExpenseImportParityUpdates(steps);
  const journeyKeyById = new Map(journeys.map((j) => [j.id, j.key]));

  for (const u of updates) {
    console.log(
      `${dryRun ? '[dry-run] would disable' : 'disabling'} "${u.stepKey}" on ${journeyKeyById.get(u.journeyId)}`,
    );
  }

  if (!dryRun && updates.length > 0) {
    await prisma.$transaction(
      updates.map((u) =>
        prisma.journeyStep.update({ where: { id: u.id }, data: { enabled: false } }),
      ),
    );
  }

  console.log(
    `${dryRun ? 'Would update' : 'Updated'} ${updates.length} step row(s) across ${journeys.length} onboarding journey(ies).`,
  );
} finally {
  await prisma.$disconnect();
}
