#!/usr/bin/env node
/**
 * Reconcilia o snapshot de autorização de todos os usuários com `TYPE_MODULES`.
 *
 * O acesso é uma FOTO tirada no signup. Módulo novo em `TYPE_MODULES` não
 * alcança quem já tinha conta — foi assim que `financing` sumiu do menu para
 * usuários antigos de CASA/CARRO, e `recurrences`/`pendencias` para PESSOAL.
 *
 * Só ADICIONA. Nunca remove módulo de ninguém.
 *
 * Uso:
 *   node scripts/reconcile-user-modules.mjs             # DRY-RUN (padrão, não escreve)
 *   node scripts/reconcile-user-modules.mjs --apply     # escreve de verdade
 *
 * O dry-run é o PADRÃO de propósito: este script mexe em autorização de
 * usuários reais, e um `--apply` acidental por copiar-colar do histórico é o
 * tipo de erro que não se desfaz sozinho.
 */
import { PrismaClient } from '@prisma/client';
import { computeModuleReconciliation } from './lib/reconcile-user-modules.mjs';

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();

try {
  const dbUrl = process.env.DATABASE_URL ?? '(não definido)';
  console.log(`Banco : ${dbUrl}`);
  console.log(`Modo  : ${apply ? 'APLICAR (escreve no banco)' : 'DRY-RUN (não escreve)'}\n`);

  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      username: true,
      role: true,
      allowedModules: true,
      allowedProjectTypes: true,
    },
  });

  const updates = computeModuleReconciliation(users);

  if (updates.length === 0) {
    console.log(`Nada a fazer: os ${users.length} usuários já estão reconciliados.`);
  } else {
    const byModule = {};
    for (const u of updates) {
      for (const m of u.missing) byModule[m] = (byModule[m] ?? 0) + 1;
    }

    console.log(`${updates.length} de ${users.length} usuários com módulo faltando.\n`);
    console.log('Por módulo:');
    for (const [mod, count] of Object.entries(byModule).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${mod}`);
    }

    console.log('\nAmostra (até 10):');
    for (const u of updates.slice(0, 10)) {
      console.log(`  ${u.username} [${u.projectTypes.join(', ')}] += ${u.missing.join(', ')}`);
    }

    if (apply) {
      // Transação: ou todos os usuários ficam consistentes, ou nenhum muda.
      // Reconciliação pela metade é pior que não rodar — deixa o suporte sem
      // saber quem foi corrigido.
      await prisma.$transaction(async (tx) => {
        for (const update of updates) {
          await tx.user.update({
            where: { id: update.id },
            data: { allowedModules: JSON.stringify(update.allowedModules) },
          });
        }
      });
      console.log(`\nAplicado: ${updates.length} usuários atualizados.`);
      console.log('Eles precisam recarregar a página (ou refazer login) para ver os módulos novos.');
    } else {
      console.log('\nNada foi escrito. Para aplicar: adicione --apply');
    }
  }
} finally {
  await prisma.$disconnect();
}
