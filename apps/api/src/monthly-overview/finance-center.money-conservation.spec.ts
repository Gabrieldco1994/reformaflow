/**
 * B1a (#448) — money-conservation regression lock + RED de identidade aditiva,
 * usando a fixture COMPARTILHADA `finance-center.fixture` (#446), não uma nova
 * fixture gigante.
 *
 * Duas metades neste arquivo:
 *
 *  1) REGRESSION LOCK (deve continuar PASSANDO depois do B1a — aditivo, não
 *     deve mudar um único centavo nem o formato das chaves internas já
 *     existentes): caixa §10, Carteira, DRE/rateio (Σ alocações == valorTotal
 *     da fonte), fatura por cartão e `settlesInvoiceKey`/chave interna de
 *     fatura. Espelha (não duplica) `finance-center.fixture.integration.spec.ts`
 *     — aqui a ênfase é centavo-a-centavo, não o contrato inteiro de ACL.
 *
 *  2) RED (issue #448 B1a): a MESMA fatura, com o MESMO valor exato, também
 *     precisa emitir `cardId`/`fingerprint` aditivos — hoje ausentes.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { MonthlyOverviewService } from './monthly-overview.service';
import {
  cleanupFinanceCenterFixture,
  FINANCE_CENTER_CLOCK,
  FINANCE_CENTER_IDS,
  FINANCE_CENTER_MONTH,
  persistFinanceCenterFixture,
} from './__fixtures__/finance-center.fixture';

const IDS = FINANCE_CENTER_IDS;
const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

describe('finance-center — money-conservation (centavo exato) + identidade aditiva (#448 B1a)', () => {
  let monthly: MonthlyOverviewService;

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout'],
    });
    jest.setSystemTime(FINANCE_CENTER_CLOCK);
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await persistFinanceCenterFixture(setupPrisma);
    monthly = new MonthlyOverviewService(prisma, new CardInvoiceSettlementService(prisma));
  });

  afterAll(async () => {
    await cleanupFinanceCenterFixture(setupPrisma);
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
    jest.useRealTimers();
  });

  // ── 1) Regression lock — deve continuar passando após o B1a ────────────

  it('[lock] caixa §10 é exato: saldo inicial + crédito banco − pagamento fatura C1', async () => {
    const caixa = await monthly.getCaixaConta(IDS.tenantA, IDS.projects.pessoal);
    expect(caixa.saldoInicial).toBe(1_000_000);
    expect(caixa.hoje).toBe(983_928);
    expect(1_000_000 + 83_978 - 100_050).toBe(983_928);
  });

  it('[lock] rateio: Σ allocationCents dos alvos ATIVOS fecha exatamente o valorTotal da fonte (sobra=0)', async () => {
    const allocations = await setupPrisma.rateioAllocation.findMany({
      where: { tenantId: IDS.tenantA, sourceExpenseId: IDS.expenses.rateioSource },
      select: { allocation: true },
    });
    const source = await setupPrisma.expense.findUniqueOrThrow({
      where: { id: IDS.expenses.rateioSource },
      select: { valorTotal: true },
    });
    const somaAlocacoes = allocations.reduce((acc, a) => acc + a.allocation, 0);
    expect(allocations.map((a) => a.allocation).sort((a, b) => a - b)).toEqual([12_007, 18_022]);
    expect(somaAlocacoes).toBe(30_029);
    expect(somaAlocacoes).toBe(source.valorTotal);
  });

  it('[lock] espelho cross-project (CrossProjectSettlement): realValor == plannedValor == valorTotal da fonte/alvo (90_040)', async () => {
    const settlement = await setupPrisma.crossProjectSettlement.findUniqueOrThrow({
      where: { id: IDS.mirrorSettlement },
    });
    expect(settlement.realValor).toBe(90_040);
    expect(settlement.plannedValor).toBe(90_040);
    const source = await setupPrisma.expense.findUniqueOrThrow({ where: { id: IDS.expenses.mirrorSource } });
    const target = await setupPrisma.expense.findUniqueOrThrow({ where: { id: IDS.expenses.mirrorTarget } });
    expect(source.valorTotal).toBe(90_040);
    expect(target.valorTotal).toBe(90_040);
  });

  it('[lock] faturas por cartão emitem os totais exatos (C1 paga, C2 paga, C3 a pagar) — legado cardLast4 intocado', async () => {
    const view: any = await monthly.getAccountView(IDS.tenantA, IDS.projects.pessoal, FINANCE_CENTER_MONTH, { role: 'ADMIN' });
    const invoices = view.saidas.filter((s: any) => s.isInvoice);
    const byLast4 = new Map(invoices.map((i: any) => [i.cardLast4, i]));

    expect((byLast4.get('1111') as any).valor).toBe(100_050);
    expect((byLast4.get('1111') as any).status).toBe('PAGO');
    expect((byLast4.get('2222') as any).valor).toBe(10_010);
    expect((byLast4.get('2222') as any).status).toBe('PAGO');
    expect((byLast4.get('3333') as any).valor).toBe(7_003);
    expect((byLast4.get('3333') as any).status).toBe('PLANEJADO');
  });

  it('[lock] settlesInvoiceKey mantém o formato literal "{cardLast4}:{dueMonth}" (cartão paga cartão)', async () => {
    const cardPaysCard = await setupPrisma.expense.findUniqueOrThrow({
      where: { id: IDS.expenses.cardPaysCard },
      select: { settlesInvoiceKey: true },
    });
    expect(cardPaysCard.settlesInvoiceKey).toBe('2222:2026-08');
  });

  // ── 2) RED (#448 B1a): a MESMA fatura também expõe cardId/fingerprint ──

  it('[RED] a fatura de C1 (100_050, exata) TAMBÉM expõe cardId aditivo igual ao ID real do cartão', async () => {
    const view: any = await monthly.getAccountView(IDS.tenantA, IDS.projects.pessoal, FINANCE_CENTER_MONTH, { role: 'ADMIN' });
    const c1Invoice = view.saidas.find((s: any) => s.isInvoice && s.cardLast4 === '1111');
    expect(c1Invoice.valor).toBe(100_050); // valor não muda (money-conservation)
    expect(c1Invoice.cardId).toBe(IDS.cards.c1); // aditivo — ainda ausente hoje
  });

  it('[RED] fingerprint da fatura de C1 é exatamente `${cardId}:${dueMonth}`, nunca `${cardLast4}:${dueMonth}`', async () => {
    const view: any = await monthly.getAccountView(IDS.tenantA, IDS.projects.pessoal, FINANCE_CENTER_MONTH, { role: 'ADMIN' });
    const c1Invoice = view.saidas.find((s: any) => s.isInvoice && s.cardLast4 === '1111');
    expect(c1Invoice.fingerprint).toBe(`${IDS.cards.c1}:${FINANCE_CENTER_MONTH}`);
    expect(c1Invoice.fingerprint).not.toBe(`1111:${FINANCE_CENTER_MONTH}`);
  });
});
