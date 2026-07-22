#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

function parseStringArray(value, field, userId) {
  const parsed = JSON.parse(value || '[]');
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`User ${userId} has invalid ${field}`);
  }
  return parsed;
}

try {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      allowedModules: true,
      allowedProjectTypes: true,
    },
  });

  const updates = users.flatMap((user) => {
    const projectTypes = parseStringArray(
      user.allowedProjectTypes,
      'allowedProjectTypes',
      user.id,
    );
    const modules = parseStringArray(user.allowedModules, 'allowedModules', user.id);

    if (!projectTypes.includes('COMPRA') || modules.includes('simulation')) {
      return [];
    }

    return [{ id: user.id, allowedModules: [...modules, 'simulation'] }];
  });

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
    `${dryRun ? 'Would update' : 'Updated'} ${updates.length} COMPRA user(s) with simulation access.`,
  );
} finally {
  await prisma.$disconnect();
}
