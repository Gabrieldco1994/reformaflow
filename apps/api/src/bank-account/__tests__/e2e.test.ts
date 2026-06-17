/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Teste end-to-end do fluxo de contas bancárias.
 *
 * Cobre:
 *   1) Múltiplas contas (Itaú + Nubank) no projeto PESSOAL
 *   2) Import extrato CSV: cria Expenses (débitos) e ignora créditos
 *   3) Idempotência: re-import não duplica
 *   4) Link cross-project: débito do banco vincula a despesa planejada de REFORMA
 *   5) Suggest-links retorna candidatos próximos por valor + data
 *
 * Execução isolada num tenant temporário.
 */
import { PrismaClient } from '@prisma/client';
import { BankAccountService } from '../bank-account.service';
import { MerchantClassifierService } from '../../merchant-classifier/merchant-classifier.service';
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
  const svc = new BankAccountService(prisma as any, new MerchantClassifierService(prisma as any), new ConciliacaoService(prisma as any));

  const tenant = await prisma.tenant.create({ data: { name: 'test-banks-' + Date.now() } });
  const pessoal = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'PESSOAL', name: 'Pessoal' },
  });
  const reforma = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'REFORMA', name: 'Reforma' },
  });
  const casa = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'CASA', name: 'Casa' },
  });
  console.log(`Tenant: ${tenant.id}`);

  // ───── 1) Cria 2 contas ────────────────────────────────────
  header('1) Múltiplas contas bancárias');
  const itau = await svc.createAccount(tenant.id, pessoal.id, {
    institution: 'ITAU', nickname: 'Itaú Conta Corrente', agency: '7057', accountNumber: '077424-7', last4: '4247',
  } as any);
  const nubank = await svc.createAccount(tenant.id, pessoal.id, {
    institution: 'NUBANK', nickname: 'Nubank Conta', last4: '9999',
  } as any);
  const accounts = await svc.listAccounts(tenant.id, pessoal.id);
  assert(accounts.length === 2, 'lista 2 contas');
  assert(accounts.every((a: any) => !!a.nickname), 'todas com nickname');

  // ───── 2) Import CSV — débitos + créditos ──────────────────
  header('2) Import CSV: débitos viram Expense, créditos viram Receipt');
  const csv = `date,title,amount
2026-05-12,LEROY MERLIN MATERIAL,-450.00
2026-05-13,IFOOD RESTAURANTE,-89.90
2026-05-14,NETFLIX,-55.90
2026-05-15,SALARIO EMPRESA X,8500.00`;

  const r1 = await svc.commitImport(
    tenant.id, pessoal.id, itau.id, csv, 'itau-extrato.csv', 'CSV_GENERIC' as any,
  );
  assert(r1.inserted === 3, `3 débitos inseridos (got ${r1.inserted})`);
  assert(r1.receiptsInserted === 1, `1 recebimento criado (got ${r1.receiptsInserted})`);
  assert(r1.duplicated === 0, 'sem duplicados na 1a importação');

  // Validações: cada débito gera 1 Expense + 1 CashFlowEntry PAGO
  const expenses = await prisma.expense.findMany({
    where: { tenantId: tenant.id, projectId: pessoal.id, bankLast4: '4247', deletedAt: null },
    orderBy: { dataPagamento: 'asc' },
  });
  assert(expenses.length === 3, `3 expenses criadas (got ${expenses.length})`);
  assert(expenses.every((e) => e.status === 'PAGO'), 'todas as expenses PAGO');
  assert(expenses.every((e) => e.formaPagamento === 'A_VISTA'), 'todas A_VISTA');

  const entries = await prisma.cashFlowEntry.findMany({
    where: { tenantId: tenant.id, expense: { bankLast4: '4247' } },
  });
  assert(entries.length === 3, `3 cashFlowEntries (got ${entries.length})`);
  assert(entries.every((e) => e.status === 'PAGO'), 'todos entries PAGO');

  // ───── 3) Idempotência ─────────────────────────────────────
  header('3) Idempotência');
  const r2 = await svc.commitImport(
    tenant.id, pessoal.id, itau.id, csv, 'itau-extrato.csv', 'CSV_GENERIC' as any,
  );
  assert(r2.inserted === 0, `re-import: 0 inseridos (got ${r2.inserted})`);
  assert(r2.duplicated === 4, `re-import: 4 duplicados (3 débitos + 1 crédito) (got ${r2.duplicated})`);

  const expensesAfter = await prisma.expense.findMany({
    where: { tenantId: tenant.id, bankLast4: '4247', deletedAt: null },
  });
  assert(expensesAfter.length === 3, 'continua com 3 expenses (sem duplicação)');

  // ───── 4) Despesa planejada em REFORMA ─────────────────────
  header('4) Despesa planejada de REFORMA para vincular');
  const plannedReforma = await prisma.expense.create({
    data: {
      tenantId: tenant.id, projectId: reforma.id,
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      titulo: 'Material Leroy Merlin', fornecedor: 'LEROY MERLIN',
      valor: 45000, quantidade: 1, valorTotal: 45000,
      formaPagamento: 'A_VISTA', dataPagamento: new Date('2026-05-12'),
      status: 'PLANEJADO',
    },
  });
  // CashFlowEntry planejada
  await prisma.cashFlowEntry.create({
    data: {
      tenantId: tenant.id, projectId: reforma.id,
      expenseId: plannedReforma.id,
      valor: 45000, tipo: 'DESPESA',
      categoria: 'MATERIAL_CONSTRUCAO',
      formaPagamento: 'A_VISTA',
      data: new Date('2026-05-12'),
      status: 'PLANEJADO',
    },
  });

  // ───── 5) Suggest-links ───────────────────────────────────
  header('5) Suggest-links');
  const suggestions = await svc.suggestLinks(tenant.id, pessoal.id, itau.id);
  assert(suggestions.length === 3, `3 transações com sugestões (got ${suggestions.length})`);
  const leroyImported = suggestions.find((s: any) => /LEROY/i.test(s.expense.titulo ?? ''));
  assert(!!leroyImported, 'transação LEROY do banco está em suggestions');
  assert(leroyImported!.suggestions.length >= 1, `LEROY tem >=1 sugestão (got ${leroyImported!.suggestions.length})`);
  assert(leroyImported!.suggestions[0].expenseId === plannedReforma.id, 'sugestão aponta para despesa planejada da REFORMA');

  // ───── 6) Link cross-project ──────────────────────────────
  header('6) Link cross-project: banco PESSOAL → REFORMA');
  const sourceLeroy = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, projectId: pessoal.id, bankLast4: '4247', fornecedor: { contains: 'LEROY' } },
  });
  assert(!!sourceLeroy, 'expense LEROY do banco encontrada');
  const link = await svc.linkToExpense(tenant.id, pessoal.id, sourceLeroy!.id, plannedReforma.id);
  assert(link.ok === true, 'link.ok = true');

  // Despesa alvo (REFORMA) virou PAGO
  const reformaAfter = await prisma.expense.findUnique({ where: { id: plannedReforma.id } });
  assert(reformaAfter?.status === 'PAGO', 'despesa REFORMA virou PAGO');

  // CashFlowEntry alvo também
  const reformaEntry = await prisma.cashFlowEntry.findFirst({
    where: { expenseId: plannedReforma.id },
  });
  assert(reformaEntry?.status === 'PAGO', 'cashFlowEntry REFORMA virou PAGO');

  // Despesa do banco ganhou linkedExpenseId
  const sourceAfter = await prisma.expense.findUnique({ where: { id: sourceLeroy!.id } });
  assert(sourceAfter?.linkedExpenseId === plannedReforma.id, 'despesa banco linkedExpenseId aponta REFORMA');

  // ───── 7) Unlink ──────────────────────────────────────────
  header('7) Unlink');
  await svc.unlinkExpense(tenant.id, pessoal.id, sourceLeroy!.id);
  const sourceUnlinked = await prisma.expense.findUnique({ where: { id: sourceLeroy!.id } });
  assert(sourceUnlinked?.linkedExpenseId === null, 'após unlink, linkedExpenseId = null');
  // Nota: status do REFORMA permanece PAGO (não revertemos automaticamente)

  // ───── 8) Crédito vira Receipt + CashFlowEntry RECEBIMENTO ──
  header('8) Créditos viram Receipt + CashFlowEntry');
  const salarioExpense = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, fornecedor: { contains: 'SALARIO' } },
  });
  assert(!salarioExpense, 'crédito SALARIO NÃO virou expense (esperado)');

  const salarioReceipt = await prisma.receipt.findFirst({
    where: { tenantId: tenant.id, projectId: pessoal.id, descricao: { contains: 'SALARIO' }, deletedAt: null },
  });
  assert(!!salarioReceipt, 'crédito SALARIO virou Receipt');
  assert(salarioReceipt!.valor === 850000, `Receipt valor = 850000 (got ${salarioReceipt!.valor})`);
  assert(salarioReceipt!.tipo === 'PAGAMENTO', `Receipt tipo PAGAMENTO (got ${salarioReceipt!.tipo})`);
  assert(salarioReceipt!.status === 'EM_CAIXA', 'Receipt EM_CAIXA');
  assert(salarioReceipt!.bankLast4 === '4247', 'Receipt bankLast4 = 4247');

  const salarioEntry = await prisma.cashFlowEntry.findFirst({
    where: { tenantId: tenant.id, receiptId: salarioReceipt!.id },
  });
  assert(!!salarioEntry, 'CashFlowEntry RECEBIMENTO criado');
  assert(salarioEntry!.tipo === 'RECEBIMENTO', 'entry tipo RECEBIMENTO');
  assert(salarioEntry!.status === 'EM_CAIXA', 'entry status EM_CAIXA');
  assert(salarioEntry!.valor === 850000, 'entry valor 850000');

  // Idempotência de receipts: re-import não duplica
  const dupCheck = await prisma.receipt.findMany({
    where: { tenantId: tenant.id, externalId: salarioReceipt!.externalId, deletedAt: null },
  });
  assert(dupCheck.length === 1, `Receipt salário sem duplicação no re-import (got ${dupCheck.length})`);

  // ───── 9) 2a conta — escopo isolado por bankLast4 ────────
  header('9) 2a conta tem expenses isoladas');
  const csv2 = `date,title,amount
2026-05-20,UBER TRIP,-22.50`;
  const r3 = await svc.commitImport(
    tenant.id, pessoal.id, nubank.id, csv2, 'nubank-extrato.csv', 'CSV_GENERIC' as any,
  );
  assert(r3.inserted === 1, '1 inserido na 2a conta');
  const nubankExpenses = await prisma.expense.findMany({
    where: { tenantId: tenant.id, bankLast4: '9999', deletedAt: null },
  });
  assert(nubankExpenses.length === 1, '1 expense na 2a conta');
  assert(nubankExpenses[0].fornecedor?.includes('UBER'), 'expense 2a conta é UBER');

  // ───── 10) Pagamento de fatura de cartão (anti dupla contagem) ──
  header('10) Pagamento de fatura: vincula a card, sem CashFlowEntry');

  // Setup: cria CreditCard + StatementImport simulando fatura de R$ 1234,56 já importada
  const card = await prisma.creditCard.create({
    data: {
      tenantId: tenant.id, projectId: pessoal.id,
      institution: 'Itaú', nickname: 'Itaucard Personnalité', last4: '7777',
    },
  });
  await prisma.creditCardStatementImport.create({
    data: {
      tenantId: tenant.id, cardId: card.id,
      periodLabel: '2026-05', source: 'PDF',
      fileName: 'fatura-personnalite-05-2026.pdf', fileSize: 12345,
      status: 'COMPLETED', inserted: 10, duplicated: 0,
      totalAmountCents: 123456,
    },
  });

  const beforeCFCount = await prisma.cashFlowEntry.count({ where: { tenantId: tenant.id } });

  // Importa um "extrato bancário" com linha de pagamento de fatura
  const csvCard = `date,title,amount
2026-05-15,FATURA PAGA PERSON MULTI,-1234.56
2026-05-16,SUPERMERCADO XPTO,-50.00`;
  const rCard = await svc.commitImport(
    tenant.id, pessoal.id, itau.id, csvCard, 'extrato-pagto-cartao.csv', 'CSV_GENERIC' as any,
  );
  assert(rCard.cardPayments === 1, `1 pagto de fatura detectado (got ${rCard.cardPayments})`);
  assert(rCard.inserted === 1, `1 despesa normal (got ${rCard.inserted})`);

  const pagFatura = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', deletedAt: null },
  });
  assert(!!pagFatura, 'Expense PAGAMENTO_FATURA_CARTAO criada');
  assert(pagFatura!.valorTotal === 123456, `valor R$ 1234,56 (got ${pagFatura!.valorTotal})`);
  assert(pagFatura!.cardLast4 === '7777', `cardLast4 vinculado ao 7777 (got ${pagFatura!.cardLast4})`);
  assert(pagFatura!.bankLast4 === '4247', 'bankLast4 da conta origem');
  assert(pagFatura!.titulo?.includes('Personnalité'), `título referencia cartão (got "${pagFatura!.titulo}")`);

  // Garantia anti-duplicação: pagamento de fatura NÃO gera CashFlowEntry
  const cfForCardPayment = await prisma.cashFlowEntry.findFirst({
    where: { tenantId: tenant.id, expenseId: pagFatura!.id },
  });
  assert(!cfForCardPayment, 'pagamento de fatura NÃO gerou CashFlowEntry (evita dupla contagem)');

  // Validação: somente a despesa "normal" gerou novo CashFlow
  const afterCFCount = await prisma.cashFlowEntry.count({ where: { tenantId: tenant.id } });
  assert(afterCFCount === beforeCFCount + 1, `+1 CashFlowEntry (só do supermercado, got +${afterCFCount - beforeCFCount})`);

  // ───── 11) Pagamento de fatura sem fatura importada → ainda pula o CF ──
  header('11) Pagto de fatura sem match: ainda evita CashFlowEntry');

  // Cria conta+account separada, faz upload de pagto fatura sem nenhuma fatura batendo
  const csvOrfao = `date,title,amount
2026-06-15,DEB AUT CARTAO CRED 9988,-999.00`;
  // remove fatura para garantir que não há match
  await prisma.creditCardStatementImport.deleteMany({
    where: { tenantId: tenant.id, totalAmountCents: 99900 },
  });
  const rOrfao = await svc.commitImport(
    tenant.id, pessoal.id, itau.id, csvOrfao, 'orfao.csv', 'CSV_GENERIC' as any,
  );
  assert(rOrfao.cardPayments === 1, `1 pagto detectado mesmo sem match (got ${rOrfao.cardPayments})`);
  const orfao = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', valorTotal: 99900, deletedAt: null },
  });
  assert(!!orfao, 'Expense de pagto sem match criada');
  // cardLast4 vem do regex (9988) ou fallback (cartão único 7777)
  assert(orfao!.cardLast4 === '9988' || orfao!.cardLast4 === '7777',
    `cardLast4 do hint (9988) ou cartão único (got ${orfao!.cardLast4})`);
  const cfOrfao = await prisma.cashFlowEntry.findFirst({
    where: { tenantId: tenant.id, expenseId: orfao!.id },
  });
  assert(!cfOrfao, 'pagto órfão também sem CashFlowEntry');

  // ───── 12) Link cross-project de RECEBIMENTOS ───────────────
  header('12) Link cross-project recebimentos: banco PESSOAL → REFORMA');
  // Cria um recebimento PREVISTO na REFORMA com valor próximo ao SALARIO importado
  const plannedReformaReceipt = await prisma.receipt.create({
    data: {
      tenantId: tenant.id,
      projectId: reforma.id,
      valor: 850000, // mesmo valor do SALARIO
      data: salarioReceipt!.data,
      tipo: 'PAGAMENTO',
      status: 'PREVISTO',
      descricao: 'Pagamento sócios da empreitada',
    },
  });
  await prisma.cashFlowEntry.create({
    data: {
      tenantId: tenant.id,
      projectId: reforma.id,
      receiptId: plannedReformaReceipt.id,
      valor: 850000,
      tipo: 'RECEBIMENTO',
      categoria: 'PAGAMENTO',
      data: salarioReceipt!.data,
      status: 'PREVISTO',
    },
  });

  const receiptSugs = await svc.suggestReceiptLinks(tenant.id, pessoal.id, itau.id);
  const salarioSug = receiptSugs.find((s: any) => s.receipt.id === salarioReceipt!.id);
  assert(!!salarioSug, 'SALARIO tem entrada em suggestReceiptLinks');
  assert(salarioSug!.suggestions.length >= 1, `SALARIO tem >=1 sugestão (got ${salarioSug!.suggestions.length})`);
  assert(
    salarioSug!.suggestions[0].receiptId === plannedReformaReceipt.id,
    'sugestão aponta para recebimento previsto da REFORMA',
  );

  const recLink = await svc.linkToReceipt(
    tenant.id, pessoal.id, salarioReceipt!.id, plannedReformaReceipt.id,
  );
  assert(recLink.ok === true, 'linkToReceipt.ok = true');

  const reformaRecAfter = await prisma.receipt.findUnique({ where: { id: plannedReformaReceipt.id } });
  assert(reformaRecAfter?.status === 'EM_CAIXA', 'recebimento REFORMA virou EM_CAIXA');

  const reformaRecEntry = await prisma.cashFlowEntry.findFirst({
    where: { receiptId: plannedReformaReceipt.id },
  });
  assert(reformaRecEntry?.status === 'EM_CAIXA', 'cashFlowEntry REFORMA virou EM_CAIXA');

  const sourceRecAfter = await prisma.receipt.findUnique({ where: { id: salarioReceipt!.id } });
  assert(
    sourceRecAfter?.linkedReceiptId === plannedReformaReceipt.id,
    'recebimento banco linkedReceiptId aponta REFORMA',
  );

  // ───── 13) Unlink recebimento ───────────────────────────────
  header('13) Unlink recebimento');
  await svc.unlinkReceipt(tenant.id, pessoal.id, salarioReceipt!.id);
  const sourceRecUnlinked = await prisma.receipt.findUnique({ where: { id: salarioReceipt!.id } });
  assert(sourceRecUnlinked?.linkedReceiptId === null, 'após unlink, linkedReceiptId = null');

  // ───── 14) Validações de erro: receipt em mesmo projeto / já EM_CAIXA ──
  header('14) Erros: receipt mesmo projeto / já em caixa');
  const samePrjReceipt = await prisma.receipt.create({
    data: {
      tenantId: tenant.id, projectId: pessoal.id,
      valor: 1000, data: new Date(), tipo: 'PAGAMENTO', status: 'PREVISTO',
    },
  });
  let threw = false;
  try {
    await svc.linkToReceipt(tenant.id, pessoal.id, salarioReceipt!.id, samePrjReceipt.id);
  } catch { threw = true; }
  assert(threw, 'não permite linkar recebimento no mesmo projeto');

  // Cleanup auxiliar receipt
  await prisma.cashFlowEntry.deleteMany({ where: { receiptId: samePrjReceipt.id } });
  await prisma.receipt.delete({ where: { id: samePrjReceipt.id } });

  // ───── Cleanup ─────────────────────────────────────────────
  header('Cleanup');
  await prisma.$transaction([
    prisma.cashFlowEntry.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.bankStatementImport.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.creditCardStatementImport.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.bankAccount.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.creditCard.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.expense.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.receipt.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.project.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.tenant.deleteMany({ where: { id: tenant.id } }),
  ]);
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
