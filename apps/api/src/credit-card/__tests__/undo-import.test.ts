/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Teste de integração do "Desfazer importação" de fatura de cartão.
 *
 * Cobre (banco real descartável do worktree — prisma/test.db):
 *   1) Importar → medir → desfazer → o total de despesas do cartão volta ao
 *      valor de antes; Expense + CashFlowEntry + o registro de import soft-deletados.
 *   2) Idempotência: desfazer duas vezes não quebra nem "revive" nada.
 *   3) Dependência cross-project (link): desfazer o import reverte o
 *      CrossProjectSettlement e restaura a planejada do outro projeto — sem órfão.
 *   4) Atomicidade: falha no meio da transação não deixa o lote meio-revertido.
 *   5) getImportDetail: preview do impacto lista linhas/valor/dependências.
 *
 * A trava de banco (test-db-env) precisa vir ANTES de qualquer `new PrismaClient()`.
 * Prepare o banco com `npm run test:db:prepare` na raiz do repo.
 * Rodar: `cd apps/api && npx ts-node src/credit-card/__tests__/undo-import.test.ts`
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');
import { PrismaClient } from '@prisma/client';
import { CreditCardService } from '../credit-card.service';
import { ConciliacaoService } from '../../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../../merchant-classifier/merchant-classifier.service';

const prisma = new PrismaClient();
let failures = 0;
let passed = 0;

function assert(cond: any, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); return; }
  failures++; console.error(`  ✗ ${msg}`);
}
function header(t: string) { console.log(`\n── ${t}`); }

async function sumCardDespesaCents(tenantId: string, cardLast4: string): Promise<number> {
  const entries = await prisma.cashFlowEntry.findMany({
    where: {
      tenantId,
      deletedAt: null,
      tipo: 'DESPESA',
      expense: { deletedAt: null, cardLast4 },
    },
    select: { valor: true },
  });
  return entries.reduce((s, e) => s + e.valor, 0);
}

async function cleanup(tenantId: string) {
  // Ordem: filhos (settlements/rateio) antes de expenses (FK), depois o resto.
  await prisma.crossProjectSettlement.deleteMany({ where: { tenantId } });
  await prisma.rateioAllocation.deleteMany({ where: { tenantId } });
  await prisma.$executeRaw`DELETE FROM cash_flow_entries WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM credit_card_imports WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM credit_cards WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM expenses WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM projects WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
}

async function main() {
  const conciliacao = new ConciliacaoService(prisma as any);
  const cardSvc = new CreditCardService(
    prisma as any,
    conciliacao,
    new MerchantClassifierService(prisma as any),
  );

  const tenant = await prisma.tenant.create({ data: { name: 'test-undo-cc-' + Date.now() } });
  const pessoal = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'PESSOAL', name: 'Pessoal' },
  });
  const reforma = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'REFORMA', name: 'Reforma' },
  });
  console.log(`Tenant: ${tenant.id}`);

  const card = await cardSvc.createCard(tenant.id, pessoal.id, {
    institution: 'ITAU', brand: 'Visa', nickname: 'Itaú', last4: '1234', limitTotalCents: 1000000,
  } as any);

  // ───── 1) Importar → medir → desfazer → total volta ─────────
  header('1) Desfazer devolve o estado anterior');
  const before = await sumCardDespesaCents(tenant.id, '1234');
  assert(before === 0, `antes: total do cartão = 0 (got ${before})`);

  const csv = `data;descricao;valor
12/05/2026;LEROY MERLIN PARC 1/3;R$ 300,00
13/05/2026;IFOOD ESTABELECIMENTO;R$ 89,90
`;
  const r1 = await cardSvc.commitImport(tenant.id, pessoal.id, card.id, csv, 'fatura.csv', 'AUTO' as any);
  const importId = r1.importId;
  assert(!!importId, 'commit devolve importId');
  const afterImport = await sumCardDespesaCents(tenant.id, '1234');
  assert(afterImport > before, `após import: total subiu (${afterImport} > ${before})`);

  // detalhe do lote (preview do impacto)
  const detail = await cardSvc.getImportDetail(tenant.id, pessoal.id, card.id, importId);
  assert(detail.impact.expenses === 2, `detail: 2 despesas criadas (got ${detail.impact.expenses})`);
  assert(detail.impact.cashFlowEntries >= 4, `detail: >=4 cashflow (Leroy 1/3 + iFood) (got ${detail.impact.cashFlowEntries})`);

  const undo1 = await cardSvc.undoImport(tenant.id, pessoal.id, card.id, importId);
  assert(undo1.ok === true, 'undo ok');
  assert(undo1.removedExpenses === 2, `undo removeu 2 despesas (got ${undo1.removedExpenses})`);

  const afterUndo = await sumCardDespesaCents(tenant.id, '1234');
  assert(afterUndo === before, `após desfazer: total voltou a ${before} (got ${afterUndo})`);

  const liveExpenses = await prisma.expense.count({
    where: { tenantId: tenant.id, importId, deletedAt: null },
  });
  assert(liveExpenses === 0, `nenhuma despesa viva do lote (got ${liveExpenses})`);
  const liveEntries = await prisma.cashFlowEntry.count({
    where: { tenantId: tenant.id, deletedAt: null, expense: { cardLast4: '1234' } },
  });
  assert(liveEntries === 0, `nenhum cashflow vivo do cartão (got ${liveEntries})`);
  const importRow = await prisma.creditCardStatementImport.findUnique({ where: { id: importId } });
  assert(importRow?.deletedAt != null, 'registro de import soft-deletado');

  // ───── 2) Idempotência ──────────────────────────────────────
  header('2) Idempotência: desfazer duas vezes');
  const undo2 = await cardSvc.undoImport(tenant.id, pessoal.id, card.id, importId);
  assert(undo2.ok === true && undo2.alreadyUndone === true, 'segundo undo: alreadyUndone, sem throw');
  const stillZero = await sumCardDespesaCents(tenant.id, '1234');
  assert(stillZero === before, `total permanece ${before} após 2º undo (got ${stillZero})`);

  // ───── 3) Dependência cross-project revertida ───────────────
  header('3) Link cross-project é revertido, não deixado órfão');
  const csv2 = `data;descricao;valor
20/06/2026;LOJA MATERIAL;R$ 500,00
`;
  const r2 = await cardSvc.commitImport(tenant.id, pessoal.id, card.id, csv2, 'fatura2.csv', 'AUTO' as any);
  const importId2 = r2.importId;
  const src = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, importId: importId2, cardLast4: '1234', deletedAt: null },
  });
  assert(!!src, 'despesa importada criada');

  const planned = await prisma.expense.create({
    data: {
      tenantId: tenant.id, projectId: reforma.id, tipoDespesa: 'MATERIAL_CONSTRUCAO',
      titulo: 'Material', fornecedor: 'Loja', valor: 50000, quantidade: 1, valorTotal: 50000,
      formaPagamento: 'A_VISTA', dataInicioParcela: new Date(Date.UTC(2026, 5, 20)), status: 'PLANEJADO',
    },
  });
  await prisma.cashFlowEntry.create({
    data: {
      tenantId: tenant.id, projectId: reforma.id, expenseId: planned.id, valor: 50000, tipo: 'DESPESA',
      data: new Date(Date.UTC(2026, 5, 20)), categoria: 'MATERIAL_CONSTRUCAO', formaPagamento: 'A_VISTA', status: 'PLANEJADO',
    },
  });
  await cardSvc.linkToExpense(tenant.id, pessoal.id, src!.id, planned.id);
  const plannedLinked = await prisma.expense.findUnique({ where: { id: planned.id } });
  assert(plannedLinked?.status === 'PAGO', 'planejada REFORMA virou PAGO pelo link');
  const settlementsBefore = await prisma.crossProjectSettlement.count({ where: { sourceExpenseId: src!.id } });
  assert(settlementsBefore === 1, `1 CrossProjectSettlement criado (got ${settlementsBefore})`);

  const undo3 = await cardSvc.undoImport(tenant.id, pessoal.id, card.id, importId2);
  assert(undo3.ok === true, 'undo do lote com link ok');
  assert(undo3.revertedSettlements === 1, `undo reverteu 1 settlement (got ${undo3.revertedSettlements})`);
  const plannedAfter = await prisma.expense.findUnique({ where: { id: planned.id } });
  assert(plannedAfter?.status === 'PLANEJADO', 'planejada REFORMA restaurada a PLANEJADO');
  const settlementsAfter = await prisma.crossProjectSettlement.count({ where: { sourceExpenseId: src!.id } });
  assert(settlementsAfter === 0, `nenhum settlement órfão (got ${settlementsAfter})`);
  const srcAfter = await prisma.expense.findUnique({ where: { id: src!.id } });
  assert(srcAfter?.deletedAt != null, 'despesa-fonte soft-deletada');

  // ───── 4) Atomicidade: falha no meio → rollback total ───────
  header('4) Atomicidade: falha no meio não deixa lote meio-revertido');
  const csv4 = `data;descricao;valor
01/07/2026;COMPRA A;R$ 100,00
02/07/2026;COMPRA B;R$ 200,00
`;
  const r4 = await cardSvc.commitImport(tenant.id, pessoal.id, card.id, csv4, 'fatura4.csv', 'AUTO' as any);
  const importId4 = r4.importId;
  const beforeAtomic = await sumCardDespesaCents(tenant.id, '1234');
  assert(beforeAtomic > 0, `lote 4 criou despesas (total ${beforeAtomic})`);

  // Injeta falha DENTRO da transação: sabota reverseSourceLinks (chamado pelo
  // undo depois de já ter soft-deletado despesas+caixa no mesmo $transaction).
  // Se a tx não for atômica, sobraria lote meio-revertido.
  const originalReverse = conciliacao.reverseSourceLinks.bind(conciliacao);
  (conciliacao as any).reverseSourceLinks = () => { throw new Error('boom-atomicidade'); };
  let threw = false;
  try {
    await cardSvc.undoImport(tenant.id, pessoal.id, card.id, importId4);
  } catch {
    threw = true;
  } finally {
    (conciliacao as any).reverseSourceLinks = originalReverse;
  }
  assert(threw, 'undo lançou erro na falha injetada');
  const afterAtomic = await sumCardDespesaCents(tenant.id, '1234');
  assert(afterAtomic === beforeAtomic, `rollback: total inalterado (${afterAtomic} === ${beforeAtomic})`);
  const importRow4 = await prisma.creditCardStatementImport.findUnique({ where: { id: importId4 } });
  assert(importRow4?.deletedAt == null, 'registro de import NÃO foi soft-deletado (rollback)');
  const liveAfterAtomic = await prisma.expense.count({
    where: { tenantId: tenant.id, importId: importId4, deletedAt: null },
  });
  assert(liveAfterAtomic === 2, `2 despesas do lote 4 seguem vivas (got ${liveAfterAtomic})`);

  // limpeza real do lote 4 (undo de verdade)
  await cardSvc.undoImport(tenant.id, pessoal.id, card.id, importId4);

  // ───── Cleanup ──────────────────────────────────────────────
  header('Cleanup');
  await cleanup(tenant.id);
  console.log(`  ✓ tenant temporário removido`);

  console.log(`\n${passed} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
