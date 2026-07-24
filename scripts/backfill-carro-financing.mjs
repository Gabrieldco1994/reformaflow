#!/usr/bin/env node
// Backfill idempotente: adiciona 'financing' a allowedModules dos usuários
// com CARRO explícito em allowedProjectTypes (issue #293). Usuários com
// allowedProjectTypes vazio (legado, sem restrição) NÃO são tocados — eles
// já derivam acesso por módulo (ver access-rules.accessibleProjectTypes).
import { PrismaClient } from '@prisma/client';
import { computeFinancingBackfillUpdates } from './lib/backfill-carro-financing.mjs';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

try {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      allowedModules: true,
      allowedProjectTypes: true,
    },
  });

  const updates = computeFinancingBackfillUpdates(users);

  if (!dryRun && updates.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const update of updates) {
        await tx.user.update({
          where: { id: update.id },
          data: { allowedModules: JSON.stringify(update.allowedModules) },
        });
      }
    });
  }

  console.log(
    `${dryRun ? 'Would update' : 'Updated'} ${updates.length} CARRO user(s) with financing access.`,
  );
} finally {
  await prisma.$disconnect();
}
