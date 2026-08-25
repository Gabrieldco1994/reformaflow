/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #586 (Defeito 1 + Defeito 2 do PR #616, que ficou incompleto) — spec
 * RED do middleware de soft-delete comendo os dois pontos de reativação de
 * `FinancingService.upsert()`.
 *
 * Diferença deliberada em relação ao `e2e.test.ts` irmão (que já existia e
 * passava verde sem pegar o bug): AQUI o serviço sob teste é instanciado com
 * `new PrismaService()` — o `@Injectable` real de `apps/api/src/prisma/prisma.service.ts`
 * que registra o `$use` de soft-delete no construtor — nunca `new PrismaClient()`
 * bruto. É esse `$use` que reinjeta `deletedAt: null` em QUALQUER `findMany`/
 * `findFirst` cujo `where.deletedAt` esteja `undefined`, dentro OU fora de
 * `$transaction` (o middleware intercepta por AÇÃO, não por contexto de
 * transação). O `PrismaClient` bruto do e2e antigo nunca teve esse `$use`
 * registrado — por isso nunca reproduziu o 500 real de produção.
 *
 * Cobre:
 *  1) Reativação CARRO, 0 parcelas protegidas — upsert → remove → upsert com
 *     DTO diferente não pode colidir em `financings_project_id_key`
 *     (Financing.findFirst) nem em (financingId, numeroParcela)
 *     (FinancingInstallment.findMany).
 *  2) Reativação CASA com parcelas PAGAS protegidas — mesmo ciclo, mas as
 *     parcelas pagas sobrevivem intocadas (id, numeroParcela, status PAGO) e
 *     as demais são recalculadas pelo cronograma novo, sem colisão.
 *  3) Condição A — uma FinancingInstallment soft-deletada nunca entra em
 *     `protectedNumeros`, mesmo que `isInstallmentProtected` diria que sim
 *     (espelho Expense soft-deletado mas com status PAGO — `tx.expense.findUnique`
 *     nunca é interceptado pelo `$use`, então enxerga a Expense apagada como
 *     PAGA). Sem o guard `if (installment.deletedAt !== null) continue;` em
 *     `financing.service.ts`, essa parcela contaria para `maxProtectedNumero`
 *     e um `prazoMeses` novo menor que ela seria rejeitado indevidamente.
 *
 * Execução manual (arquivo `.test.ts`, fora do `testRegex` do jest — mesma
 * convenção do `e2e.test.ts` irmão, que roda como script standalone):
 *   cd apps/api && npx ts-node -T -r tsconfig-paths/register src/financing/__tests__/e2e-soft-delete-reactivation.test.ts
 *
 * Prepare o banco uma vez com `npm run test:db:prepare` na raiz do repo antes
 * de rodar. Roda contra `prisma/test.db` do worktree atual (nunca `dev.db`).
 */
// O guard do banco de teste precisa carregar ANTES de qualquer import do Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');

import { PrismaService } from '../../prisma/prisma.service';
import { FinancingService } from '../financing.service';
import { ExpenseService } from '../../expense/expense.service';
import { ConciliacaoService } from '../../conciliacao/conciliacao.service';

const prisma = new PrismaService();
let failures = 0;
let passed = 0;

/** Cópia local e deliberadamente NÃO importada de `prisma.service.ts`: usada
 * só nas queries de VERIFICAÇÃO deste spec (para ver linhas soft-deletadas
 * fisicamente, independente do fix estar aplicado ou não em produção). Não
 * tem relação com `INCLUDE_SOFT_DELETED` exportado pelo fix — se acoplasse a
 * ele, o spec quebraria ao rodar contra o baseline RED (antes do fix existir). */
const VERIFY_INCLUDE_SOFT_DELETED = { not: undefined } as const;

function assert(cond: any, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
    return;
  }
  failures++;
  console.error(`  ✗ ${msg}`);
}

function header(t: string) {
  console.log(`\n── ${t}`);
}

async function expectNoThrow(label: string, fn: () => Promise<any>): Promise<any> {
  let result: any;
  let threw: any = null;
  try {
    result = await fn();
  } catch (e) {
    threw = e;
  }
  assert(threw === null, `${label} não lança (got: ${threw?.message ?? threw ?? 'ok'})`);
  return result;
}

async function scenario1_carroSemProtegidas(): Promise<{ tenantId: string; projectId: string }> {
  header('Cenário 1 — Reativação CARRO, 0 parcelas protegidas');

  const tenant = await prisma.tenant.create({ data: { name: 'test-586-carro-' + Date.now() } });
  const carro = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'CARRO', name: 'Carro' },
  });
  const conciliacao = new ConciliacaoService(prisma as any);
  const expenseService = new ExpenseService(prisma as any, conciliacao);
  const svc = new FinancingService(prisma as any, expenseService);

  const dataPrimeiraParcela = '2026-01-10';

  const original = await svc.upsert(tenant.id, carro.id, {
    instituicao: 'Banco A',
    sistema: 'PRICE',
    valorTotalFinanciado: 4_000_000,
    taxaJurosMensalBps: 90,
    prazoMeses: 48,
    dataPrimeiraParcela,
    diaVencimento: 10,
  } as any);
  assert(!!original, 'upsert original (CARRO) retorna financiamento');
  const financingRowId = original!.id;

  await svc.remove(tenant.id, carro.id);
  const afterRemove = await prisma.financing.findUnique({ where: { id: financingRowId } });
  assert(!!afterRemove?.deletedAt, 'Financing (CARRO) soft-deletado após remove()');

  // ── Este é o ponto que reproduz o P2002 em `Financing.findFirst` (Bug 1)
  // quando `existing` não enxerga a linha soft-deletada.
  const reactivated = await expectNoThrow('upsert() de reativação (CARRO, sem protegidas)', () =>
    svc.upsert(tenant.id, carro.id, {
      instituicao: 'Banco B',
      sistema: 'SAC',
      valorTotalFinanciado: 2_000_000,
      taxaJurosMensalBps: 60,
      prazoMeses: 18,
      dataPrimeiraParcela,
      diaVencimento: 15,
    } as any),
  );

  if (reactivated) {
    assert(reactivated.id === financingRowId, 'reutiliza a mesma linha física (reativação, não recriação)');
    assert(reactivated.prazoMeses === 18, `prazoMeses NOVO = 18 (got ${reactivated.prazoMeses})`);
    assert(!reactivated.deletedAt, 'deletedAt desfeito após reativação');

    const countForProject = await prisma.financing.count({ where: { projectId: carro.id } });
    assert(countForProject === 1, `apenas 1 linha de Financing física para o projeto (got ${countForProject})`);

    // ── Este é o ponto que reproduz o P2002 em (financingId, numeroParcela)
    // (Bug 2) quando `current` não enxerga as parcelas soft-deletadas e o
    // `createMany` colide com os slots físicos ainda ocupados.
    const liveInstallments = await prisma.financingInstallment.findMany({
      where: { financingId: financingRowId, deletedAt: null },
    });
    assert(liveInstallments.length === 18, `18 parcelas vivas batendo com o prazoMeses NOVO (got ${liveInstallments.length})`);

    const totalPhysical = await prisma.financingInstallment.count({ where: { financingId: financingRowId } });
    assert(totalPhysical === 18, `total físico de parcelas = 18 (as antigas foram hard-deletadas) (got ${totalPhysical})`);
  }

  return { tenantId: tenant.id, projectId: carro.id };
}

async function scenario2_casaComProtegidas(): Promise<{ tenantId: string; projectId: string }> {
  header('Cenário 2 — Reativação CASA com parcelas PAGAS protegidas');

  const tenant = await prisma.tenant.create({ data: { name: 'test-586-casa-' + Date.now() } });
  const casa = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'CASA', name: 'Casa' },
  });
  const conciliacao = new ConciliacaoService(prisma as any);
  const expenseService = new ExpenseService(prisma as any, conciliacao);
  const svc = new FinancingService(prisma as any, expenseService);

  const dataPrimeiraParcela = '2026-01-10';

  const original = await svc.upsert(tenant.id, casa.id, {
    instituicao: 'Banco Casa Original',
    sistema: 'PRICE',
    valorTotalFinanciado: 30_000_000, // R$ 300.000,00 — proporcional ao caso real
    taxaJurosMensalBps: 95,
    prazoMeses: 60,
    dataPrimeiraParcela,
    diaVencimento: 10,
  } as any);
  assert(!!original, 'upsert original (CASA) retorna financiamento');
  const financingRowId = original!.id;

  const liveBefore = await prisma.financingInstallment.findMany({
    where: { financingId: financingRowId, deletedAt: null },
    orderBy: { numeroParcela: 'asc' },
  });
  assert(liveBefore.length === 60, `60 parcelas vivas criadas (got ${liveBefore.length})`);

  // Paga as duas primeiras parcelas — tornam-se PROTEGIDAS.
  const parcela1 = liveBefore[0];
  const parcela2 = liveBefore[1];
  await svc.payInstallment(tenant.id, casa.id, parcela1.id, {
    valorPago: parcela1.valorPrevisto,
    dataPagamento: dataPrimeiraParcela,
  } as any);
  await svc.payInstallment(tenant.id, casa.id, parcela2.id, {
    valorPago: parcela2.valorPrevisto,
    dataPagamento: '2026-02-10',
  } as any);

  const paid1 = await prisma.financingInstallment.findUnique({ where: { id: parcela1.id } });
  const paid2 = await prisma.financingInstallment.findUnique({ where: { id: parcela2.id } });
  assert(paid1?.status === 'PAGO' && paid2?.status === 'PAGO', 'parcelas 1 e 2 marcadas PAGO antes do remove()');

  await svc.remove(tenant.id, casa.id);
  const paid1AfterRemove = await prisma.financingInstallment.findUnique({ where: { id: parcela1.id } });
  const paid2AfterRemove = await prisma.financingInstallment.findUnique({ where: { id: parcela2.id } });
  assert(
    !paid1AfterRemove?.deletedAt && !paid2AfterRemove?.deletedAt,
    'parcelas PAGAS (protegidas) NÃO são soft-deletadas pelo remove()',
  );

  const nonProtectedAfterRemove = await prisma.financingInstallment.findMany({
    where: {
      financingId: financingRowId,
      numeroParcela: { gt: 2 },
      deletedAt: VERIFY_INCLUDE_SOFT_DELETED,
    },
  });
  assert(
    nonProtectedAfterRemove.length === 58 && nonProtectedAfterRemove.every((i) => !!i.deletedAt),
    'parcelas 3..60 (não protegidas) soft-deletadas por remove(), ainda presentes fisicamente',
  );

  // ── Reativação com DTO diferente. Sem os dois fixes, colide em
  // (financingId, numeroParcela) ao tentar recriar 3..N por cima das
  // linhas físicas soft-deletadas que `current` não enxergou.
  const reactivated = await expectNoThrow('upsert() de reativação (CASA, com protegidas)', () =>
    svc.upsert(tenant.id, casa.id, {
      instituicao: 'Banco Casa Novo',
      sistema: 'SAC',
      valorTotalFinanciado: 20_000_000,
      taxaJurosMensalBps: 75,
      prazoMeses: 40,
      dataPrimeiraParcela,
      diaVencimento: 20,
    } as any),
  );

  if (reactivated) {
    assert(reactivated.id === financingRowId, 'reutiliza a mesma linha física de Financing (CASA)');
    assert(reactivated.prazoMeses === 40, `prazoMeses NOVO = 40 (got ${reactivated.prazoMeses})`);

    const paid1AfterUpsert = await prisma.financingInstallment.findUnique({ where: { id: parcela1.id } });
    const paid2AfterUpsert = await prisma.financingInstallment.findUnique({ where: { id: parcela2.id } });
    assert(
      paid1AfterUpsert?.status === 'PAGO' &&
        paid1AfterUpsert?.numeroParcela === 1 &&
        !paid1AfterUpsert?.deletedAt,
      'parcela 1 protegida preserva id/numeroParcela/status PAGO após reativação',
    );
    assert(
      paid2AfterUpsert?.status === 'PAGO' &&
        paid2AfterUpsert?.numeroParcela === 2 &&
        !paid2AfterUpsert?.deletedAt,
      'parcela 2 protegida preserva id/numeroParcela/status PAGO após reativação',
    );

    const liveAfter = await prisma.financingInstallment.findMany({
      where: { financingId: financingRowId, deletedAt: null },
    });
    assert(liveAfter.length === 40, `40 parcelas vivas batendo com o prazoMeses NOVO (got ${liveAfter.length})`);

    const nonProtectedLiveNumeros = new Set(
      liveAfter.filter((i) => i.numeroParcela > 2).map((i) => i.numeroParcela),
    );
    assert(
      nonProtectedLiveNumeros.size === 38,
      `parcelas 3..40 recalculadas pelo cronograma novo (got ${nonProtectedLiveNumeros.size})`,
    );
  }

  return { tenantId: tenant.id, projectId: casa.id };
}

async function scenario3_condicaoA(): Promise<{ tenantId: string; projectId: string }> {
  header('Cenário 3 — Condição A: parcela soft-deletada nunca entra em protectedNumeros');

  const tenant = await prisma.tenant.create({ data: { name: 'test-586-condA-' + Date.now() } });
  const casa = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'CASA', name: 'Casa Condicao A' },
  });
  const conciliacao = new ConciliacaoService(prisma as any);
  const expenseService = new ExpenseService(prisma as any, conciliacao);
  const svc = new FinancingService(prisma as any, expenseService);

  const dataPrimeiraParcela = '2026-01-10';

  const original = await svc.upsert(tenant.id, casa.id, {
    instituicao: 'Banco Cond A',
    sistema: 'PRICE',
    valorTotalFinanciado: 6_000_000,
    taxaJurosMensalBps: 80,
    prazoMeses: 6,
    dataPrimeiraParcela,
    diaVencimento: 10,
  } as any);
  const financingRowId = original!.id;

  const installments = await prisma.financingInstallment.findMany({
    where: { financingId: financingRowId, deletedAt: null },
    orderBy: { numeroParcela: 'asc' },
  });
  assert(installments.length === 6, `6 parcelas criadas para o cenário Condição A (got ${installments.length})`);

  // Paga a parcela 3 (fica PAGA + expense espelho PAGA).
  const parcela3 = installments.find((i) => i.numeroParcela === 3)!;
  await svc.payInstallment(tenant.id, casa.id, parcela3.id, {
    valorPago: parcela3.valorPrevisto,
    dataPagamento: '2026-03-10',
  } as any);
  const paidParcela3 = await prisma.financingInstallment.findUnique({ where: { id: parcela3.id } });
  assert(paidParcela3?.status === 'PAGO' && !!paidParcela3?.expenseId, 'parcela 3 PAGA com expense espelho vinculada');

  // Simula diretamente o estado adversarial: parcela 3 soft-deletada E sua
  // expense espelho soft-deletada, mas AMBAS mantendo status PAGO (não passa
  // por `remove()` — remove() nunca soft-deletaria uma parcela protegida;
  // este é justamente o estado que `isInstallmentProtected` enxergaria como
  // "ainda protegida" via `tx.expense.findUnique`, que ignora soft-delete).
  const now = new Date();
  await prisma.financingInstallment.update({
    where: { id: parcela3.id },
    data: { deletedAt: now },
  });
  await prisma.expense.update({
    where: { id: paidParcela3!.expenseId! },
    data: { deletedAt: now },
  });

  const expenseAfterSoftDelete = await prisma.expense.findUnique({ where: { id: paidParcela3!.expenseId! } });
  assert(
    expenseAfterSoftDelete?.status === 'PAGO' && !!expenseAfterSoftDelete?.deletedAt,
    'expense espelho soft-deletada mas com status PAGO (estado adversarial montado)',
  );

  // ── Se Condição A estiver ausente/enfraquecida, `upsert()` com prazoMeses=1
  // (< numeroParcela 3) lançaria BadRequestException, pois a parcela 3
  // soft-deletada seria contada em protectedNumeros. Com o guard presente,
  // ela é ignorada e o upsert é aceito.
  await expectNoThrow(
    'upsert() com prazoMeses=1 (< parcela 3 soft-deletada) — Condição A não deve protegê-la',
    () =>
      svc.upsert(tenant.id, casa.id, {
        instituicao: 'Banco Cond A Novo',
        sistema: 'SAC',
        valorTotalFinanciado: 1_000_000,
        taxaJurosMensalBps: 50,
        prazoMeses: 1,
        dataPrimeiraParcela,
        diaVencimento: 12,
      } as any),
  );

  return { tenantId: tenant.id, projectId: casa.id };
}

async function cleanupTenant(tenantId: string, projectId: string) {
  const finalFinancing = await prisma.financing.findFirst({ where: { projectId } });
  await prisma.cashFlowEntry.deleteMany({ where: { tenantId } });
  await prisma.expense.deleteMany({ where: { tenantId } });
  if (finalFinancing) {
    await prisma.financingInstallment.deleteMany({ where: { financingId: finalFinancing.id } });
  }
  await prisma.financing.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
}

async function main() {
  await prisma.onModuleInit();

  const scopes: Array<{ tenantId: string; projectId: string }> = [];
  try {
    scopes.push(await scenario1_carroSemProtegidas());
    scopes.push(await scenario2_casaComProtegidas());
    scopes.push(await scenario3_condicaoA());
  } finally {
    header('Cleanup');
    for (const scope of scopes) {
      await cleanupTenant(scope.tenantId, scope.projectId);
    }
    console.log('  ✓ tenants temporários removidos');
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  await prisma.onModuleDestroy();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  try {
    await prisma.onModuleDestroy();
  } catch {
    // noop
  }
  process.exit(1);
});
