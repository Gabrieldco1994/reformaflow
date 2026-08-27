/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Teste de integração do "Desfazer importação" de extrato bancário.
 *
 * Cobre (banco real descartável do worktree — prisma/test.db):
 *   1) Importar (débito + crédito + pagamento de fatura) → medir → desfazer →
 *      Expense/Receipt/CashFlowEntry criados soft-deletados; import soft-deletado;
 *      e a LIQUIDAÇÃO DE FATURA revertida (compra do cartão volta a PLANEJADO).
 *   2) Idempotência: desfazer duas vezes retorna alreadyUndone, sem quebrar.
 *   3) Atomicidade: falha no meio da transação não deixa lote meio-revertido.
 *   4) Efeito IRREVERSÍVEL: propagação de recorrência (RecurringBill) NÃO é
 *      revertida — apenas reportada.
 *
 * A trava de banco precisa vir ANTES de qualquer `new PrismaClient()`.
 * Prepare o banco com `npm run test:db:prepare` na raiz do repo.
 * Rodar: `cd apps/api && npx ts-node src/bank-account/__tests__/undo-import.test.ts`
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');
import { PrismaClient } from '@prisma/client';
import { BankAccountService } from '../bank-account.service';
import { MerchantClassifierService } from '../../merchant-classifier/merchant-classifier.service';
import { ConciliacaoService } from '../../conciliacao/conciliacao.service';
import { CardInvoiceSettlementService } from '../../credit-card/card-invoice-settlement.service';
import type { RateioRequester } from '../../expense/rateio.types';

const prisma = new PrismaClient();
let failures = 0;
let passed = 0;

function assert(cond: any, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); return; }
  failures++; console.error(`  ✗ ${msg}`);
}
function header(t: string) { console.log(`\n── ${t}`); }

async function liveDespesaCents(tenantId: string, bankLast4: string): Promise<number> {
  const entries = await prisma.cashFlowEntry.findMany({
    where: { tenantId, deletedAt: null, tipo: 'DESPESA', expense: { deletedAt: null, bankLast4 } },
    select: { valor: true },
  });
  return entries.reduce((s, e) => s + e.valor, 0);
}

async function cleanup(tenantId: string) {
  await prisma.crossProjectSettlement.deleteMany({ where: { tenantId } });
  await prisma.rateioAllocation.deleteMany({ where: { tenantId } });
  await prisma.$executeRaw`DELETE FROM cash_flow_entries WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM bank_statement_imports WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM credit_card_imports WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM bank_accounts WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM credit_cards WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM recurring_bills WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM receipts WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM expenses WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM projects WHERE tenant_id = ${tenantId}`;
  await prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
}

async function main() {
  const conciliacao = new ConciliacaoService(prisma as any);
  const cardSettlement = new CardInvoiceSettlementService(prisma as any);
  const svc = new BankAccountService(
    prisma as any,
    new MerchantClassifierService(prisma as any),
    conciliacao,
    cardSettlement,
  );

  const tenant = await prisma.tenant.create({ data: { name: 'test-undo-bank-' + Date.now() } });
  const pessoal = await prisma.project.create({ data: { tenantId: tenant.id, type: 'PESSOAL', name: 'Pessoal' } });
  const casa = await prisma.project.create({ data: { tenantId: tenant.id, type: 'CASA', name: 'Casa' } });
  const requester: RateioRequester = {
    role: 'OWNER',
    allowedProjects: [pessoal.id, casa.id],
    allowedProjectTypes: ['PESSOAL', 'CASA'],
    allowedModules: ['expenses'],
  };
  console.log(`Tenant: ${tenant.id}  CASA: ${casa.id}`);

  const acc = (await svc.createAccount(tenant.id, pessoal.id, {
    institution: 'ITAU', nickname: 'Itaú CC', last4: '4247',
  } as any)).bankAccount;

  // Cartão COM fechamento/vencimento (estratégia 1 de liquidação, reversível por dueMonth)
  const card = await prisma.creditCard.create({
    data: {
      tenantId: tenant.id, projectId: pessoal.id, institution: 'Itaú',
      nickname: 'Itaucard', last4: '7777', closingDay: 10, dueDay: 20,
    },
  });
  const ccImport = await prisma.creditCardStatementImport.create({
    data: {
      tenantId: tenant.id, cardId: card.id, periodLabel: '2026-06', source: 'PDF',
      status: 'COMPLETED', inserted: 1, duplicated: 0, totalAmountCents: 30000,
    },
  });
  // Compra do cartão importada como PLANEJADO (caixaMonth 2026-06 p/ closing=10,due=20)
  const purchase = await prisma.expense.create({
    data: {
      tenantId: tenant.id, projectId: pessoal.id, tipoDespesa: 'ALIMENTACAO',
      titulo: 'Restaurante', fornecedor: 'Restaurante', valor: 30000, quantidade: 1, valorTotal: 30000,
      formaPagamento: 'A_VISTA', dataPagamento: new Date(Date.UTC(2026, 5, 5)), status: 'PLANEJADO',
      importId: ccImport.id, cardLast4: '7777',
    },
  });
  await prisma.cashFlowEntry.create({
    data: {
      tenantId: tenant.id, projectId: pessoal.id, expenseId: purchase.id, valor: 30000, tipo: 'DESPESA',
      data: new Date(Date.UTC(2026, 5, 5)), categoria: 'ALIMENTACAO', formaPagamento: 'CARTAO_CREDITO', status: 'PLANEJADO',
    },
  });

  // ───── 1) Import extrato → medir → desfazer ────────────────
  header('1) Desfazer devolve o estado anterior + reverte liquidação de fatura');
  const csv = `date,title,amount
2026-06-10,SUPERMERCADO XYZ,-120.00
2026-06-11,SALARIO EMPRESA,5000.00
2026-06-12,ENEL DISTRIBUICAO SP,-200.00
2026-06-15,PAGAMENTO FATURA CARTAO,-300.00`;

  // Descobre o externalId da linha de pagamento p/ forçar cardLast4 na decisão.
  const preview: any = await svc.previewImport(tenant.id, pessoal.id, acc.id, csv, 'extrato.csv', 'CSV_GENERIC' as any, undefined, requester);
  const payTx = preview.preview.find((p: any) => /PAGAMENTO FATURA/.test(p.merchant));
  assert(!!payTx, 'preview identifica a linha de pagamento de fatura');
  const decisions = [{ externalId: payTx.externalId, overrides: { cardLast4: '7777' } }];

  const r1: any = await svc.commitImport(
    tenant.id, pessoal.id, acc.id, csv, 'extrato.csv', 'CSV_GENERIC' as any,
    undefined, undefined, decisions as any, null, requester
  );
  const importId = r1.importId;
  assert(!!importId, 'commit devolve importId');
  assert(r1.cardPayments === 1, `1 pagto de fatura vinculado (got ${r1.cardPayments})`);

  // liquidação: a compra do cartão virou PAGO
  const purchaseAfterImport = await prisma.expense.findUnique({ where: { id: purchase.id } });
  assert(purchaseAfterImport?.status === 'PAGO', `compra do cartão liquidada p/ PAGO (got ${purchaseAfterImport?.status})`);

  const recurAfterImport = await prisma.recurringBill.count({ where: { tenantId: tenant.id, projectId: casa.id, deletedAt: null } });
  assert(recurAfterImport >= 1, `recorrência ENEL propagada p/ CASA (got ${recurAfterImport})`);

  const debitsBeforeUndo = await liveDespesaCents(tenant.id, '4247');
  assert(debitsBeforeUndo > 0, `caixa de débitos > 0 (got ${debitsBeforeUndo})`);

  const detail: any = await svc.getImportDetail(tenant.id, pessoal.id, acc.id, importId, requester);
  assert(detail.impact.expenses >= 3, `detail: >=3 despesas (super+enel+pagto) (got ${detail.impact.expenses})`);
  assert(detail.impact.receipts === 1, `detail: 1 recebimento (got ${detail.impact.receipts})`);
  assert(detail.impact.invoiceLiquidations >= 1, `detail: >=1 liquidação de fatura (got ${detail.impact.invoiceLiquidations})`);
  assert(detail.irreversible.recurrencesPropagated >= 1, `detail: >=1 recorrência irreversível (got ${detail.irreversible.recurrencesPropagated})`);

  const undo1: any = await svc.undoImport(tenant.id, pessoal.id, acc.id, importId, requester);
  assert(undo1.ok === true, 'undo ok');
  assert(undo1.revertedInvoiceParcelas >= 1, `undo reverteu >=1 parcela de fatura (got ${undo1.revertedInvoiceParcelas})`);

  // compra do cartão volta a PLANEJADO
  const purchaseAfterUndo = await prisma.expense.findUnique({ where: { id: purchase.id } });
  assert(purchaseAfterUndo?.status === 'PLANEJADO', `compra restaurada a PLANEJADO (got ${purchaseAfterUndo?.status})`);
  assert(purchaseAfterUndo?.deletedAt == null, 'compra do cartão NÃO foi apagada (é de outro lote)');
  const purchaseCF = await prisma.cashFlowEntry.findFirst({ where: { expenseId: purchase.id, deletedAt: null } });
  assert(purchaseCF?.status === 'PLANEJADO', `caixa da compra restaurado a PLANEJADO (got ${purchaseCF?.status})`);

  // criados pelo lote soft-deletados
  const liveExp = await prisma.expense.count({ where: { tenantId: tenant.id, importId, deletedAt: null } });
  assert(liveExp === 0, `nenhuma despesa viva do lote (got ${liveExp})`);
  const liveRec = await prisma.receipt.count({ where: { tenantId: tenant.id, importId, deletedAt: null } });
  assert(liveRec === 0, `nenhum recebimento vivo do lote (got ${liveRec})`);
  const debitsAfterUndo = await liveDespesaCents(tenant.id, '4247');
  assert(debitsAfterUndo === 0, `caixa de débitos do banco zerado (got ${debitsAfterUndo})`);
  const importRow = await prisma.bankStatementImport.findUnique({ where: { id: importId } });
  assert(importRow?.deletedAt != null, 'registro de import soft-deletado');

  // recorrência NÃO revertida (irreversível)
  const recurAfterUndo = await prisma.recurringBill.count({ where: { tenantId: tenant.id, projectId: casa.id, deletedAt: null } });
  assert(recurAfterUndo === recurAfterImport, `recorrência CASA permanece (irreversível) (got ${recurAfterUndo})`);

  // ───── 2) Idempotência ─────────────────────────────────────
  header('2) Idempotência');
  const undo2: any = await svc.undoImport(tenant.id, pessoal.id, acc.id, importId, requester);
  assert(undo2.ok === true && undo2.alreadyUndone === true, 'segundo undo: alreadyUndone, sem throw');
  const purchaseStill = await prisma.expense.findUnique({ where: { id: purchase.id } });
  assert(purchaseStill?.status === 'PLANEJADO', 'compra segue PLANEJADO após 2º undo (não re-reverteu)');

  // ───── 3) Atomicidade ──────────────────────────────────────
  header('3) Atomicidade: falha no meio não deixa lote meio-revertido');
  const csv3 = `date,title,amount
2026-07-10,MERCADO A,-40.00
2026-07-11,MERCADO B,-60.00`;
  const r3: any = await svc.commitImport(tenant.id, pessoal.id, acc.id, csv3, 'extrato3.csv', 'CSV_GENERIC' as any, undefined, undefined, undefined, null, requester);
  const importId3 = r3.importId;
  const beforeAtomic = await liveDespesaCents(tenant.id, '4247');
  assert(beforeAtomic > 0, `lote 3 criou débitos (got ${beforeAtomic})`);

  const originalReverse = conciliacao.reverseSourceLinks.bind(conciliacao);
  (conciliacao as any).reverseSourceLinks = () => { throw new Error('boom-atomicidade'); };
  let threw = false;
  try {
    await svc.undoImport(tenant.id, pessoal.id, acc.id, importId3, requester);
  } catch {
    threw = true;
  } finally {
    (conciliacao as any).reverseSourceLinks = originalReverse;
  }
  assert(threw, 'undo lançou erro na falha injetada');
  const afterAtomic = await liveDespesaCents(tenant.id, '4247');
  assert(afterAtomic === beforeAtomic, `rollback: caixa inalterado (${afterAtomic} === ${beforeAtomic})`);
  const importRow3 = await prisma.bankStatementImport.findUnique({ where: { id: importId3 } });
  assert(importRow3?.deletedAt == null, 'import do lote 3 NÃO soft-deletado (rollback)');
  const liveExp3 = await prisma.expense.count({ where: { tenantId: tenant.id, importId: importId3, deletedAt: null } });
  assert(liveExp3 === 2, `2 despesas do lote 3 seguem vivas (got ${liveExp3})`);

  // undo real do lote 3
  await svc.undoImport(tenant.id, pessoal.id, acc.id, importId3, requester);

  header('Cleanup');
  await cleanup(tenant.id);
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
