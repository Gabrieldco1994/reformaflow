#!/usr/bin/env node
/**
 * Migração de dados: corrigir JourneyStep para passos SEM tela própria
 *
 * Passos que não têm slug (maria-insight, feedback) foram bootstrap-ados com
 * experience: 'FULL' inconscientemente. A validação assertFullExperienceHasSlug
 * recusa qualquer save com FULL para passos sem slug.
 *
 * Requisitos da migração:
 * - Dry-run first, reportando quantas linhas seriam alteradas
 * - Transacional
 * - Idempotente: rodar duas vezes não altera nada na segunda execução
 *
 * Armadilha #4 do CLAUDE.md: $transaction ignora soft-delete middleware.
 * Aqui só fazemos UPDATE, sem DELETE, então não é problema.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set');
  process.exit(1);
}

// Passos que não têm tela própria (de @reformaflow/domain)
const JOURNEY_STEPS_WITHOUT_SLUG = new Set(['maria-insight', 'feedback']);

async function main() {
  const prisma = new PrismaClient();

  try {
    const dryRun = process.argv[2] === '--dry-run';

    if (dryRun) {
      console.log('Running in DRY-RUN mode (no changes will be made)\n');
    } else {
      console.log('Running in APPLY mode (changes will be committed)\n');
    }

    // Encontrar todas as linhas que precisam ser corrigidas
    const stepsToFix = await prisma.journeyStep.findMany({
      where: {
        stepKey: {
          in: Array.from(JOURNEY_STEPS_WITHOUT_SLUG),
        },
        experience: 'FULL',
      },
      select: {
        id: true,
        journeyId: true,
        stepKey: true,
        experience: true,
      },
    });

    console.log(`Found ${stepsToFix.length} JourneyStep rows to fix:`);
    if (stepsToFix.length === 0) {
      console.log('  (none)');
    } else {
      stepsToFix.forEach((step) => {
        console.log(
          `  - id=${step.id}, stepKey=${step.stepKey}, journeyId=${step.journeyId}, experience=FULL → SUMMARY`,
        );
      });
    }

    if (!dryRun && stepsToFix.length > 0) {
      console.log('\nApplying changes in a transaction...');

      // Usar transação para garantir atomicidade
      await prisma.$transaction(async (tx) => {
        for (const step of stepsToFix) {
          await tx.journeyStep.update({
            where: { id: step.id },
            data: { experience: 'SUMMARY' },
          });
        }
      });

      console.log(`✓ Updated ${stepsToFix.length} rows to experience=SUMMARY`);
    } else if (dryRun) {
      console.log(
        `\n(Dry-run) Would update ${stepsToFix.length} rows. Run without --dry-run to apply.`,
      );
    } else {
      console.log('\nNo rows to fix.');
    }

    // Verify idempotency: run the query again
    if (!dryRun && stepsToFix.length > 0) {
      console.log('\nVerifying idempotency (running query again)...');
      const stepsStillToFix = await prisma.journeyStep.findMany({
        where: {
          stepKey: {
            in: Array.from(JOURNEY_STEPS_WITHOUT_SLUG),
          },
          experience: 'FULL',
        },
        select: { id: true },
      });

      if (stepsStillToFix.length === 0) {
        console.log('✓ Idempotency verified: second run found 0 rows to fix');
      } else {
        console.error(
          `✗ Idempotency check FAILED: found ${stepsStillToFix.length} rows that still need fixing!`,
        );
        process.exit(1);
      }
    }

    console.log('\nMigration complete.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
