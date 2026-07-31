/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prova de isolamento tenant do MerchantClassifierService (issue #381).
 *
 * Cobre:
 *   1) Regra de um tenant NÃO vaza para outro (o bug).
 *   2) Regra global (`tenantId` null) é visível para todos como fallback.
 *   3) Precedência: regra do próprio tenant vence a global para a mesma chave.
 *   4) remove-rule é escopado ao tenant e NUNCA apaga a global.
 *   5) manualExpenseType respeita o mesmo escopo.
 *
 * Roda contra o banco descartável do worktree (prisma/test.db), nunca o dev.db.
 * A trava abaixo precisa vir ANTES de qualquer `new PrismaClient()`.
 * Prepare com `npm run test:db:prepare` na raiz, depois:
 *   cd apps/api && npx ts-node src/merchant-classifier/__tests__/e2e.test.ts
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');
import { PrismaClient } from '@prisma/client';
import { MerchantClassifierService } from '../merchant-classifier.service';

const prisma = new PrismaClient();
let failures = 0;
let passed = 0;

function assert(cond: any, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); return; }
  failures++; console.error(`  ✗ ${msg}`);
}
function header(t: string) { console.log(`\n── ${t}`); }

const A = 'tenant-mc-a';
const B = 'tenant-mc-b';
const RAW = 'Padaria Teste XYZ 381';
const KEY = MerchantClassifierService.normalizeKey(RAW);

async function main() {
  const svc = new MerchantClassifierService(prisma as any);

  // Limpeza defensiva de execuções anteriores
  await prisma.merchantCategory.deleteMany({ where: { merchantKey: KEY } });

  header('1) Isolamento entre tenants');
  await svc.setManual(RAW, 'alimentação', null, A);
  assert((await svc.fromCache(RAW, A))?.category === 'alimentação', 'tenant A vê a própria regra');
  assert((await svc.fromCache(RAW, B)) === null, 'tenant B NÃO vê a regra do tenant A (bug corrigido)');

  header('2) Regra global é visível como fallback');
  await svc.promoteGlobal(RAW, 'transporte', null);
  assert((await svc.fromCache(RAW, B))?.category === 'transporte', 'tenant B (sem regra própria) cai na global');

  header('3) Precedência: regra do tenant vence a global');
  assert((await svc.fromCache(RAW, A))?.category === 'alimentação', 'tenant A mantém a própria regra sobre a global');
  await svc.setManual(RAW, 'saúde', null, B);
  assert((await svc.fromCache(RAW, B))?.category === 'saúde', 'tenant B agora vê a própria regra, não a global');

  header('4) remove-rule é escopado e não toca a global');
  const rem = await svc.removeManual(RAW, B);
  assert(rem.deleted, 'removeManual apagou a regra do tenant B');
  assert((await svc.fromCache(RAW, B))?.category === 'transporte', 'tenant B volta a cair na global (global intacta)');
  assert((await svc.fromCache(RAW, A))?.category === 'alimentação', 'regra do tenant A permanece intacta');

  header('5) manualExpenseType respeita o escopo');
  assert((await svc.manualExpenseType(RAW, A)) === 'ALIMENTACAO', 'tenant A resolve pela própria regra');
  assert((await svc.manualExpenseType(RAW, B)) === 'TRANSPORTE', 'tenant B resolve pela global (source MANUAL)');

  header('Cleanup');
  await prisma.merchantCategory.deleteMany({ where: { merchantKey: KEY } });
  console.log('  ✓ regras de teste removidas');

  console.log(`\n${passed} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
