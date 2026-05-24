/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Teste end-to-end do fluxo de cartões de crédito.
 *
 * Cobre:
 *   1) Múltiplos cartões (Itaú + Nubank) no projeto PESSOAL
 *   2) Import fatura mês 1: gera Expense + cashFlowEntries (atual PAGO + parcelas futuras PLANEJADO)
 *   3) Import fatura mês 2: faz SETTLEMENT da parcela planejada (não duplica)
 *   4) Idempotência: re-importar o mesmo arquivo não cria duplicatas
 *   5) Link cross-project: parcela "Leroy Merlin" do cartão vincula a despesa planejada da REFORMA
 *      - Despesa alvo (REFORMA) vira PAGO
 *      - Despesa importada (PESSOAL) ganha linkedExpenseId
 *      - Monthly-overview NÃO conta em dobro
 *   6) Visão consolidada mensal continua somando despesas dos 2 cartões corretamente
 *
 * Execução isolada num tenant temporário (criado e removido ao final).
 */
import { PrismaClient } from '@prisma/client';
import { CreditCardService } from '../credit-card.service';
import { MonthlyOverviewService } from '../../monthly-overview/monthly-overview.service';

const prisma = new PrismaClient();
let failures = 0;
let passed = 0;

function assert(cond: any, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); return; }
  failures++; console.error(`  ✗ ${msg}`);
}

function header(t: string) { console.log(`\n── ${t}`); }

async function main() {
  const cardSvc = new CreditCardService(prisma as any);
  const monthlySvc = new MonthlyOverviewService(prisma as any);

  // ───── Setup tenant + projetos ─────────────────────────────
  const tenant = await prisma.tenant.create({ data: { name: 'test-cards-' + Date.now() } });
  const pessoal = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'PESSOAL', name: 'Pessoal' },
  });
  const reforma = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'REFORMA', name: 'Reforma Cozinha' },
  });
  const casa = await prisma.project.create({
    data: { tenantId: tenant.id, type: 'CASA', name: 'Casa' },
  });

  console.log(`Tenant: ${tenant.id}`);

  // ───── 1) Cria 2 cartões ───────────────────────────────────
  header('1) Múltiplos cartões');
  const itau = await cardSvc.createCard(tenant.id, pessoal.id, {
    institution: 'ITAU', brand: 'Visa', nickname: 'Itaú Click', last4: '1234',
    limitTotalCents: 1000000,
  } as any);
  const nubank = await cardSvc.createCard(tenant.id, pessoal.id, {
    institution: 'NUBANK', brand: 'Mastercard', nickname: 'Nubank Platinum', last4: '5678',
    limitTotalCents: 1500000,
  } as any);
  const cards = await cardSvc.listCards(tenant.id, pessoal.id);
  assert(cards.length === 2, 'lista 2 cartões');
  assert(cards.find((c: any) => c.last4 === '1234') && cards.find((c: any) => c.last4 === '5678'), 'last4 corretos');

  // ───── 2) Import fatura mês 1 do Itaú ──────────────────────
  header('2) Import fatura mês 1 Itaú (parcelada + à vista)');
  const itauMes1Csv = `data;descricao;valor
12/05/2026;LEROY MERLIN PARC 1/3;R$ 300,00
13/05/2026;IFOOD ESTABELECIMENTO;R$ 89,90
14/05/2026;NETFLIX PARC 2/12;R$ 55,90
`;
  const r1 = await cardSvc.commitImport(
    tenant.id, pessoal.id, itau.id, itauMes1Csv, 'itau-fatura-05.csv', 'AUTO' as any,
  );
  assert(r1.inserted === 3, `Itaú mês 1: 3 inseridos (got ${r1.inserted})`);
  assert(r1.settled === 0, 'mês 1: nenhuma settled (não há série existente)');

  // Validações: Leroy 1/3 deve criar 1 expense + 3 cashFlowEntries (1 PAGO + 2 PLANEJADO)
  const leroyExpense = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, cardLast4: '1234', fornecedor: { contains: 'LEROY' } },
  });
  assert(!!leroyExpense, 'Leroy expense criada');
  assert(leroyExpense?.formaPagamento === 'PARCELADO', 'Leroy formaPagamento=PARCELADO');
  assert(leroyExpense?.quantidadeParcela === 3, 'Leroy quantidadeParcela=3');
  assert(!!leroyExpense?.seriesKey, 'Leroy seriesKey definido');

  const leroyEntries = await prisma.cashFlowEntry.findMany({
    where: { expenseId: leroyExpense!.id }, orderBy: { data: 'asc' },
  });
  assert(leroyEntries.length === 3, `Leroy 3 entries (got ${leroyEntries.length})`);
  assert(leroyEntries[0].status === 'PAGO' && leroyEntries[0].parcela === '1/3', 'parcela 1/3 PAGO');
  assert(leroyEntries[1].status === 'PLANEJADO' && leroyEntries[1].parcela === '2/3', 'parcela 2/3 PLANEJADO');
  assert(leroyEntries[2].status === 'PLANEJADO' && leroyEntries[2].parcela === '3/3', 'parcela 3/3 PLANEJADO');

  // À vista deve ter 1 entry só
  const ifoodEntries = await prisma.cashFlowEntry.findMany({
    where: { expense: { fornecedor: { contains: 'IFOOD' } } },
  });
  assert(ifoodEntries.length === 1 && ifoodEntries[0].status === 'PAGO', 'iFood 1 entry PAGO');

  // ───── 3) Import fatura mês 1 do Nubank ────────────────────
  header('3) Import fatura mês 1 Nubank');
  const nubankMes1Csv = `date,title,amount
2026-05-15,UBER TRIP,32.40
2026-05-16,SPOTIFY BRASIL,21.90
`;
  const r2 = await cardSvc.commitImport(
    tenant.id, pessoal.id, nubank.id, nubankMes1Csv, 'nubank.csv', 'AUTO' as any,
  );
  assert(r2.inserted === 2, `Nubank mês 1: 2 inseridos (got ${r2.inserted})`);
  assert(r2.source === 'CSV_NUBANK', 'fonte Nubank detectada');

  // Cartões diferentes: cada Expense tem cardLast4 correto
  const allExpenses = await prisma.expense.findMany({
    where: { tenantId: tenant.id, projectId: pessoal.id, deletedAt: null },
  });
  const itauExps = allExpenses.filter((e) => e.cardLast4 === '1234');
  const nubankExps = allExpenses.filter((e) => e.cardLast4 === '5678');
  assert(itauExps.length === 3, `Itaú 3 expenses (got ${itauExps.length})`);
  assert(nubankExps.length === 2, `Nubank 2 expenses (got ${nubankExps.length})`);

  // ───── 4) Idempotência: re-importar mesma fatura não duplica ─
  header('4) Idempotência');
  const r2dup = await cardSvc.commitImport(
    tenant.id, pessoal.id, itau.id, itauMes1Csv, 'itau-fatura-05.csv', 'AUTO' as any,
  );
  assert(r2dup.inserted === 0, `re-import: 0 inseridos (got ${r2dup.inserted})`);
  assert(r2dup.duplicated === 3, `re-import: 3 duplicated (got ${r2dup.duplicated})`);

  const totalExpensesAfterDup = await prisma.expense.count({
    where: { tenantId: tenant.id, projectId: pessoal.id, deletedAt: null },
  });
  assert(totalExpensesAfterDup === 5, `total expenses ainda 5 (got ${totalExpensesAfterDup})`);

  // ───── 5) Import fatura mês 2 do Itaú: deve fazer SETTLEMENT ─
  header('5) Settlement automático (mês 2 Itaú)');
  const itauMes2Csv = `data;descricao;valor
13/06/2026;LEROY MERLIN PARC 2/3;R$ 300,00
14/06/2026;NETFLIX PARC 3/12;R$ 55,90
15/06/2026;DROGARIA SAO PAULO;R$ 45,00
`;
  const r3 = await cardSvc.commitImport(
    tenant.id, pessoal.id, itau.id, itauMes2Csv, 'itau-fatura-06.csv', 'AUTO' as any,
  );
  assert(r3.settled === 2, `mês 2: 2 settled (Leroy 2/3 + Netflix 3/12) — got ${r3.settled}`);
  assert(r3.inserted === 1, `mês 2: 1 nova (Drogaria) — got ${r3.inserted}`);

  // Verifica que a parcela 2/3 do Leroy virou PAGO
  const leroyAfter = await prisma.cashFlowEntry.findMany({
    where: { expenseId: leroyExpense!.id }, orderBy: { data: 'asc' },
  });
  assert(leroyAfter.length === 3, 'ainda 3 entries (sem duplicação)');
  assert(leroyAfter[1].status === 'PAGO' && leroyAfter[1].parcela === '2/3', 'parcela 2/3 virou PAGO');
  assert(leroyAfter[2].status === 'PLANEJADO' && leroyAfter[2].parcela === '3/3', 'parcela 3/3 segue PLANEJADO');

  // ───── 6) Link cross-project: parcela 3/3 do Leroy → REFORMA ─
  header('6) Link cross-project (Leroy parcela 3/3 → Reforma)');

  // Cria uma despesa PLANEJADA em REFORMA que será o alvo do link
  const reformaPlanned = await prisma.expense.create({
    data: {
      tenantId: tenant.id,
      projectId: reforma.id,
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      titulo: 'Material parede cozinha',
      fornecedor: 'Leroy Merlin',
      valor: 30000, quantidade: 1, valorTotal: 30000,
      formaPagamento: 'A_VISTA',
      dataInicioParcela: leroyAfter[2].data,
      status: 'PLANEJADO',
    },
  });
  await prisma.cashFlowEntry.create({
    data: {
      tenantId: tenant.id,
      projectId: reforma.id,
      expenseId: reformaPlanned.id,
      valor: 30000, tipo: 'DESPESA',
      data: leroyAfter[2].data,
      categoria: 'MATERIAL_CONSTRUCAO',
      formaPagamento: 'A_VISTA',
      status: 'PLANEJADO',
    },
  });

  const linkResult = await cardSvc.linkToExpense(tenant.id, pessoal.id, leroyExpense!.id, reformaPlanned.id);
  assert(linkResult.ok === true, 'link executado');

  // Validações pós-link
  const reformaAfter = await prisma.expense.findUnique({ where: { id: reformaPlanned.id } });
  assert(reformaAfter?.status === 'PAGO', 'despesa REFORMA virou PAGO');

  const reformaEntriesAfter = await prisma.cashFlowEntry.findMany({
    where: { expenseId: reformaPlanned.id },
  });
  assert(reformaEntriesAfter[0].status === 'PAGO', 'cashFlow REFORMA virou PAGO');

  const leroyLinked = await prisma.expense.findUnique({ where: { id: leroyExpense!.id } });
  assert(leroyLinked?.linkedExpenseId === reformaPlanned.id, 'Leroy importada linkada ao alvo');

  // ───── 7) Monthly overview: não conta em dobro ─────────────
  header('7) Monthly Overview — sem dupla contagem');
  const overview = await monthlySvc.getOverview(tenant.id, pessoal.id);

  // mai/26: PESSOAL = iFood (8990) + Netflix 2/12 (5590) + Uber (3240) + Spotify (2190) = 20010
  //         (Leroy 1/3 está fora porque o source ficou com linkedExpenseId)
  const may26 = overview.meses.find((m: any) => m.mes === '2026-05');
  assert(!!may26, 'mai/26 existe na visão');
  const pessoalMay = may26?.porOrigem?.PESSOAL?.despesas ?? 0;
  assert(pessoalMay === 20010, `mai/26 PESSOAL despesas = R$ 200,10 (got ${pessoalMay})`);

  // REFORMA em mai/26 = 0 (despesa planejada vinculada está em jul/26)
  const reformaMay = may26?.porOrigem?.REFORMA?.despesas ?? 0;
  assert(reformaMay === 0, `mai/26 REFORMA = 0 (got ${reformaMay})`);

  // No mês onde a parcela 3/3 do Leroy estava planejada (jul/26):
  // - REFORMA deve mostrar R$ 300 (a despesa linkada, agora PAGO)
  // - PESSOAL deve mostrar apenas Netflix 4/12 (R$ 55,90) — Leroy 3/3 sumiu pelo linkedExpenseId
  const linkedDate = leroyAfter[2].data;
  const linkedMonth = `${linkedDate.getUTCFullYear()}-${String(linkedDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const linkedMonthRow = overview.meses.find((m: any) => m.mes === linkedMonth);
  assert(!!linkedMonthRow, `mês ${linkedMonth} existe`);
  const reformaLinkedMonth = linkedMonthRow?.porOrigem?.REFORMA?.despesas ?? 0;
  assert(reformaLinkedMonth === 30000, `${linkedMonth} REFORMA = R$ 300 (got ${reformaLinkedMonth})`);
  const pessoalLinkedMonth = linkedMonthRow?.porOrigem?.PESSOAL?.despesas ?? 0;
  // Netflix 4/12 (5590) — Leroy 3/3 está linkado, não conta
  assert(pessoalLinkedMonth === 5590, `${linkedMonth} PESSOAL = R$ 55,90 — Netflix 4/12 sem Leroy (got ${pessoalLinkedMonth})`);

  // ───── 8) Por projeto: dashboard REFORMA enxerga a despesa paga ─
  header('8) Despesa aparece no dashboard do projeto REFORMA');
  const reformaCashFlow = await prisma.cashFlowEntry.findMany({
    where: { tenantId: tenant.id, projectId: reforma.id, deletedAt: null },
  });
  assert(reformaCashFlow.length === 1, 'REFORMA tem 1 entry');
  assert(reformaCashFlow[0].status === 'PAGO' && reformaCashFlow[0].valor === 30000, 'REFORMA entry PAGO R$ 300');

  // ───── 9) Unlink: reverte o flag ───────────────────────────
  header('9) Unlink');
  await cardSvc.unlinkExpense(tenant.id, pessoal.id, leroyExpense!.id);
  const leroyUnlinked = await prisma.expense.findUnique({ where: { id: leroyExpense!.id } });
  assert(leroyUnlinked?.linkedExpenseId === null, 'unlink: linkedExpenseId null');

  // Após unlink, monthly-overview do mês corrente volta a contar
  const overview2 = await monthlySvc.getOverview(tenant.id, pessoal.id);
  const may26b = overview2.meses.find((m: any) => m.mes === '2026-05');
  const pessoalMayAfterUnlink = may26b?.porOrigem?.PESSOAL?.despesas ?? 0;
  // Volta a incluir Leroy 1/3 (30000) → 20010 + 30000 = 50010
  assert(pessoalMayAfterUnlink === 50010, `pós-unlink mai/26 PESSOAL = R$ 500,10 (got ${pessoalMayAfterUnlink})`);

  // ───── 10) Suggest-links ────────────────────────────────────
  header('10) Suggest-links (após unlink)');
  // Cria nova planejada em CASA para virar candidato
  await prisma.expense.create({
    data: {
      tenantId: tenant.id, projectId: casa.id, tipoDespesa: 'MORADIA',
      titulo: 'IFOOD janta', fornecedor: 'iFood',
      valor: 8990, quantidade: 1, valorTotal: 8990,
      formaPagamento: 'A_VISTA',
      dataInicioParcela: new Date(Date.UTC(2026, 4, 13)),
      status: 'PLANEJADO',
    },
  });
  const suggestions = await cardSvc.suggestLinks(tenant.id, pessoal.id, itau.id);
  const ifoodSuggestion = suggestions.find((s: any) => s.expense.fornecedor?.includes('IFOOD'));
  assert(!!ifoodSuggestion && ifoodSuggestion.suggestions.length > 0, 'sugestão iFood → CASA encontrada');

  // ───── 11) Collision-test: 2 cartões com mesma compra parcelada ─
  header('11) seriesKey isolada por cartão (sem cross-card settlement)');
  // Itaú importa "AMAZON PARC 1/2" R$ 200 em ago/26
  const itauAmazonCsv = `data;descricao;valor
05/08/2026;AMAZON BR PARC 1/2;R$ 200,00
`;
  await cardSvc.commitImport(tenant.id, pessoal.id, itau.id, itauAmazonCsv, 'itau-08.csv', 'AUTO' as any);
  // Nubank importa "AMAZON PARC 1/2" R$ 200 em ago/26 — mesma descrição/valor mas cartão diferente
  const nubankAmazonCsv = `date,title,amount
2026-08-06,AMAZON BR PARC 1/2,200.00
`;
  const rNuAmazon = await cardSvc.commitImport(tenant.id, pessoal.id, nubank.id, nubankAmazonCsv, 'nu-08.csv', 'AUTO' as any);
  assert(rNuAmazon.inserted === 1, `Nubank insere AMAZON própria (got inserted=${rNuAmazon.inserted})`);
  assert(rNuAmazon.settled === 0, `Nubank NÃO settle o Itaú (got settled=${rNuAmazon.settled})`);
  const itauAmazon = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, fornecedor: { contains: 'AMAZON' }, cardLast4: '1234' },
  });
  const nubankAmazon = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, fornecedor: { contains: 'AMAZON' }, cardLast4: '5678' },
  });
  assert(!!itauAmazon && !!nubankAmazon, 'duas expenses Amazon (uma por cartão)');
  assert(itauAmazon!.id !== nubankAmazon!.id, 'IDs diferentes (não dedupe entre cartões)');

  // Itaú importa parcela 2/2: deve settle SÓ a do Itaú
  const itauAmazon2Csv = `data;descricao;valor
05/09/2026;AMAZON BR PARC 2/2;R$ 200,00
`;
  const rItauAmazon2 = await cardSvc.commitImport(tenant.id, pessoal.id, itau.id, itauAmazon2Csv, 'itau-09.csv', 'AUTO' as any);
  assert(rItauAmazon2.settled === 1, `Itaú parcela 2/2 settle (got settled=${rItauAmazon2.settled})`);
  const nubankAmazonAfter = await prisma.cashFlowEntry.findMany({
    where: { expenseId: nubankAmazon!.id }, orderBy: { data: 'asc' },
  });
  assert(
    nubankAmazonAfter[1]?.status === 'PLANEJADO',
    `Nubank parcela 2/2 ainda PLANEJADO (got ${nubankAmazonAfter[1]?.status})`,
  );

  // ───── 12) Validação valor divergente: não settle ─────────────
  header('12) Settlement não acontece se valor diverge >5%');
  // Importa parcela 2/2 do Nubank mas com valor R$ 250 (25% acima)
  const nubankAmazonWrongCsv = `date,title,amount
2026-09-06,AMAZON BR PARC 2/2,250.00
`;
  const rWrong = await cardSvc.commitImport(tenant.id, pessoal.id, nubank.id, nubankAmazonWrongCsv, 'nu-09.csv', 'AUTO' as any);
  // Valor diverge → não settle, cria nova expense
  assert(rWrong.settled === 0, `valor divergente não settle (got settled=${rWrong.settled})`);
  assert(rWrong.inserted === 1, `valor divergente cria nova (got inserted=${rWrong.inserted})`);

  // ───── 13) Link em despesa já paga é rejeitado ─────────────────
  header('13) linkToExpense rejeita target PAGO');
  // Cria expense PAGA em CASA e tenta linkar
  const casaPaga = await prisma.expense.create({
    data: {
      tenantId: tenant.id, projectId: casa.id, tipoDespesa: 'MORADIA',
      titulo: 'Já pago', fornecedor: 'Test',
      valor: 5000, quantidade: 1, valorTotal: 5000,
      formaPagamento: 'A_VISTA',
      dataPagamento: new Date(Date.UTC(2026, 4, 20)),
      status: 'PAGO',
    },
  });
  const ifoodSource = await prisma.expense.findFirst({
    where: { tenantId: tenant.id, fornecedor: { contains: 'IFOOD' }, cardLast4: '1234' },
  });
  let rejected = false;
  try {
    await cardSvc.linkToExpense(tenant.id, pessoal.id, ifoodSource!.id, casaPaga.id);
  } catch (e: any) {
    rejected = e?.message?.includes('já está paga');
  }
  assert(rejected, 'link rejeitado quando target já PAGO');

  // ───── 14) Cash-flow do projeto não conta linked ──────────────
  header('14) Cash-flow respeita linkedExpenseId');
  // Re-linka algo para validar cash-flow
  const reformaPlanned2 = await prisma.expense.create({
    data: {
      tenantId: tenant.id, projectId: reforma.id, tipoDespesa: 'MATERIAL_CONSTRUCAO',
      titulo: 'IFOOD reforma', fornecedor: 'iFood',
      valor: 8990, quantidade: 1, valorTotal: 8990,
      formaPagamento: 'A_VISTA',
      dataInicioParcela: new Date(Date.UTC(2026, 4, 13)),
      status: 'PLANEJADO',
    },
  });
  await prisma.cashFlowEntry.create({
    data: {
      tenantId: tenant.id, projectId: reforma.id, expenseId: reformaPlanned2.id,
      valor: 8990, tipo: 'DESPESA',
      data: new Date(Date.UTC(2026, 4, 13)),
      categoria: 'MATERIAL_CONSTRUCAO', formaPagamento: 'A_VISTA', status: 'PLANEJADO',
    },
  });
  await cardSvc.linkToExpense(tenant.id, pessoal.id, ifoodSource!.id, reformaPlanned2.id);

  // Cash-flow do PESSOAL não deve incluir o iFood do Itaú (linked)
  const pessoalEntries = await prisma.cashFlowEntry.findMany({
    where: {
      projectId: pessoal.id, deletedAt: null,
      OR: [{ expenseId: null }, { expense: { deletedAt: null, linkedExpenseId: null } }],
    },
  });
  const hasIfood = pessoalEntries.some((e) => e.expenseId === ifoodSource!.id);
  assert(!hasIfood, 'cash-flow PESSOAL não inclui iFood linkado');


  // ───── Cleanup ──────────────────────────────────────────────
  header('Cleanup');
  await prisma.$transaction([
    prisma.cashFlowEntry.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.creditCardStatementImport.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.creditCard.deleteMany({ where: { tenantId: tenant.id } }),
    prisma.expense.deleteMany({ where: { tenantId: tenant.id } }),
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
