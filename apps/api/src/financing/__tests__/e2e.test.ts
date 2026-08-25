/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Teste end-to-end (issue #586, Condição D) do fluxo
 * `upsert()` → `remove()` (soft-delete) → `upsert()` de novo com DTO NOVO.
 *
 * Roda contra SQLite REAL (`prisma/test.db` do worktree, nunca `dev.db`) para
 * provar as constraints FÍSICAS que um mock não simula: o índice único
 * `projectId` em `Financing` e os três índices únicos de
 * `FinancingInstallment` (`financingId+numeroParcela`, `expenseId`). É esse
 * ambiente que fez o Defeito 1 explodir em produção (Minha Casa, 2026-07-24)
 * — `create()` colidindo por cima de uma linha soft-deletada.
 *
 * Cobre:
 *   1) Cria um Financing real (prazo 60, R$ 50.000) via `service.upsert`.
 *   2) `service.remove` soft-deleta Financing + parcelas + espelhos.
 *   3) `service.upsert` de novo no MESMO projeto com DTO DIFERENTE
 *      (prazo 24, R$ 30.000): sem exceção, sem colisão de unique constraint,
 *      resultado reflete os termos NOVOS (não os antigos), e o número de
 *      parcelas vivas bate com o prazo NOVO.
 *   4) Bônus: mesmo fluxo com uma parcela PAGA (protegida) antes do remove —
 *      sobrevive ao ciclo remove→upsert intocada.
 *
 * Execução isolada num tenant temporário (criado e removido ao final).
 * Prepare o banco uma vez com `npm run test:db:prepare` na raiz do repo.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');
import { PrismaClient } from '@prisma/client';
import { FinancingService } from '../financing.service';
import { ExpenseService } from '../../expense/expense.service';
import { ConciliacaoService } from '../../conciliacao/conciliacao.service';

const prisma = new PrismaClient();
let failures = 0;
let passed = 0;

function assert(cond: any, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); return; }
  failures++; console.error(`  ✗ ${msg}`);
}

function header(t: string) { console.log(`\n── ${t}`); }

async function main() {
  const conciliacao = new ConciliacaoService(prisma as any);
  const expenseService = new ExpenseService(prisma as any, conciliacao);
  const financingSvc = new FinancingService(prisma as any, expenseService);

  // ───── Setup tenant + projeto (CASA — dono real de `financing`) ────
  const tenant = await prisma.tenant.create({ data: { name: 'test-financing-' + Date.now() } });
  const casa = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'CASA', name: 'Casa' },
  });
  console.log(`Tenant: ${tenant.id} | Projeto CASA: ${casa.id}`);

  // Âncora fixa: independente do dia em que o teste roda, a 1a parcela cai
  // "no passado" o suficiente para garantir que TODAS as parcelas do prazo
  // curto (24 meses) entrem na janela rolling do materializeWindow em algum
  // momento do ciclo — mas o que este teste prova (contagem de
  // FinancingInstallment) não depende da janela, só do prazoMeses.
  const dataPrimeiraParcela = '2026-01-10';

  // ───── 1) Cria financiamento original (prazo 60, R$ 50.000) ────────
  header('1) Cria financiamento original via upsert');
  const original = await financingSvc.upsert(tenant.id, casa.id, {
    instituicao: 'Banco Original',
    sistema: 'PRICE',
    valorTotalFinanciado: 5_000_000, // R$ 50.000,00
    taxaJurosMensalBps: 100,
    prazoMeses: 60,
    dataPrimeiraParcela,
    diaVencimento: 10,
  } as any);
  assert(!!original, 'upsert original retorna financiamento');
  assert(original!.prazoMeses === 60, `prazoMeses original = 60 (got ${original!.prazoMeses})`);
  assert(original!.valorTotalFinanciado === 5_000_000, 'valorTotalFinanciado original = 5_000_000');

  const originalInstallments = await prisma.financingInstallment.findMany({
    where: { financingId: original!.id, deletedAt: null },
  });
  assert(originalInstallments.length === 60, `60 parcelas vivas criadas (got ${originalInstallments.length})`);

  const financingRowId = original!.id;

  // ───── 2) remove() soft-deleta tudo ─────────────────────────────────
  header('2) remove() soft-deleta Financing + parcelas + espelhos');
  const removeResult = await financingSvc.remove(tenant.id, casa.id);
  assert(removeResult.deleted === true, 'remove() retorna deleted=true');

  const financingAfterRemove = await prisma.financing.findUnique({ where: { id: financingRowId } });
  assert(!!financingAfterRemove?.deletedAt, 'Financing soft-deletado (deletedAt setado)');

  const installmentsAfterRemove = await prisma.financingInstallment.findMany({
    where: { financingId: financingRowId },
  });
  assert(
    installmentsAfterRemove.length > 0 && installmentsAfterRemove.every((i) => !!i.deletedAt),
    'todas as parcelas (não protegidas) soft-deletadas, ainda presentes fisicamente',
  );

  // Confirma que a busca "viva" (deletedAt: null) do getWithSummary não acha
  // mais nada — é exatamente essa lente que o Defeito 1 usava no `existing`.
  const financingViaGet = await financingSvc.get(tenant.id, casa.id);
  assert(financingViaGet === null, 'get() não enxerga o financiamento soft-deletado (lente normal)');

  // ───── 3) upsert() DE NOVO com DTO DIFERENTE (prazo 24, R$ 30.000) ──
  header('3) upsert() de novo com termos NOVOS — não pode colidir nem herdar valores antigos');
  let reactivated: any;
  let threw: any = null;
  try {
    reactivated = await financingSvc.upsert(tenant.id, casa.id, {
      instituicao: 'Banco Novo',
      sistema: 'SAC',
      valorTotalFinanciado: 3_000_000, // R$ 30.000,00 — DIFERENTE do original
      taxaJurosMensalBps: 80,
      prazoMeses: 24, // DIFERENTE do original (60)
      dataPrimeiraParcela,
      diaVencimento: 15,
    } as any);
  } catch (e) {
    threw = e;
  }
  assert(threw === null, `upsert() após remove() não lança (got: ${threw?.message ?? threw})`);
  assert(!!reactivated, 'upsert() reativado retorna financiamento');

  // Reusa a MESMA linha física (reativação), não cria uma segunda.
  assert(reactivated!.id === financingRowId, 'reutiliza a mesma linha física de Financing (reativação, não recriação)');
  const financingCountForProject = await prisma.financing.count({ where: { projectId: casa.id } });
  assert(financingCountForProject === 1, `apenas 1 linha de Financing para o projeto, mesmo com histórico soft-deletado (got ${financingCountForProject})`);

  // Termos refletem o DTO NOVO — não o financiamento antigo (Condição C).
  assert(reactivated!.prazoMeses === 24, `prazoMeses NOVO = 24, não 60 (got ${reactivated!.prazoMeses})`);
  assert(reactivated!.valorTotalFinanciado === 3_000_000, `valorTotalFinanciado NOVO = 3_000_000, não 5_000_000 (got ${reactivated!.valorTotalFinanciado})`);
  assert(reactivated!.instituicao === 'Banco Novo', `instituicao NOVA = Banco Novo (got ${reactivated!.instituicao})`);
  assert(reactivated!.sistema === 'SAC', `sistema NOVO = SAC (got ${reactivated!.sistema})`);
  assert(!reactivated!.deletedAt, 'deletedAt desfeito (null) após reativação');

  const liveInstallmentsAfter = await prisma.financingInstallment.findMany({
    where: { financingId: financingRowId, deletedAt: null },
  });
  assert(
    liveInstallmentsAfter.length === 24,
    `24 parcelas vivas batendo com o prazoMeses NOVO (got ${liveInstallmentsAfter.length})`,
  );

  // As 60 antigas foram hard-deletadas (não soft) — não sobra lixo físico
  // ocupando os índices únicos, senão o próximo upsert colidiria de novo.
  const totalInstallmentRowsForFinancing = await prisma.financingInstallment.count({
    where: { financingId: financingRowId },
  });
  assert(
    totalInstallmentRowsForFinancing === 24,
    `total físico de parcelas (vivas+soft) = 24 — as 60 antigas foram hard-deletadas, não só soft (got ${totalInstallmentRowsForFinancing})`,
  );

  // ───── 4) Bônus: parcela PAGA (protegida) sobrevive ao ciclo ────────
  header('4) Bônus — parcela PAGA sobrevive a um novo ciclo remove→upsert');
  const primeiraParcelaViva = liveInstallmentsAfter
    .slice()
    .sort((a, b) => a.numeroParcela - b.numeroParcela)[0];
  await financingSvc.payInstallment(tenant.id, casa.id, primeiraParcelaViva.id, {
    valorPago: primeiraParcelaViva.valorPrevisto,
    dataPagamento: dataPrimeiraParcela,
  } as any);

  const paidCheck = await prisma.financingInstallment.findUnique({ where: { id: primeiraParcelaViva.id } });
  assert(paidCheck?.status === 'PAGO', 'parcela 1 marcada PAGO antes do 2o ciclo remove→upsert');

  await financingSvc.remove(tenant.id, casa.id);
  const paidAfterRemove = await prisma.financingInstallment.findUnique({ where: { id: primeiraParcelaViva.id } });
  assert(!paidAfterRemove?.deletedAt, 'parcela PAGA (protegida) NÃO é soft-deletada pelo remove()');

  const secondReactivation = await financingSvc.upsert(tenant.id, casa.id, {
    instituicao: 'Banco Novo 2',
    sistema: 'SAC',
    valorTotalFinanciado: 4_000_000,
    taxaJurosMensalBps: 70,
    prazoMeses: 30, // >= maxProtectedNumero (1), permitido
    dataPrimeiraParcela,
    diaVencimento: 15,
  } as any);
  assert(!!secondReactivation, '2o ciclo remove→upsert com parcela paga não lança');
  const paidAfterSecondUpsert = await prisma.financingInstallment.findUnique({ where: { id: primeiraParcelaViva.id } });
  assert(paidAfterSecondUpsert?.status === 'PAGO', 'parcela protegida preserva status PAGO após o 2o upsert');
  assert(paidAfterSecondUpsert?.numeroParcela === 1, 'parcela protegida preserva numeroParcela original');
  assert(!paidAfterSecondUpsert?.deletedAt, 'parcela protegida segue viva (não foi tocada pelo recálculo)');

  // ───── Cleanup ────────────────────────────────────────────────────
  header('Cleanup');
  const finalFinancing = await prisma.financing.findFirst({ where: { projectId: casa.id } });
  await prisma.$transaction([
    prisma.cashFlowEntry.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.expense.deleteMany({ where: { tenantId: tenant.id } }),
    ...(finalFinancing
      ? [prisma.financingInstallment.deleteMany({ where: { financingId: finalFinancing.id } })]
      : []),
    prisma.financing.deleteMany({ where: { projectId: casa.id } }),
    prisma.project.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.tenant.deleteMany({ where: { id: tenant.id } }),
  ]);
  console.log('  ✓ tenant temporário removido');

  console.log(`\n${passed} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
