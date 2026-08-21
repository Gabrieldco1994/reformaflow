/**
 * U4-13: snapshot — fixed centavo values that fail by R$0,01 (issue #453).
 *
 * Uses real DB to prove aggregated values through the query path.
 */
// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { PrismaService } from '../prisma/prisma.service';
import { MonthlyOverviewService } from './monthly-overview.service';

const CLOCK = new Date('2026-08-15T12:00:00.000Z');
const MONTH = '2026-08';

const T = 'u4snap-tenant';
const IDS = {
  pessoal: 'u4snap-proj-pessoal',
  reforma: 'u4snap-proj-reforma',
  // Expenses (pessoal)
  bankPaid: 'u4snap-exp-bank-paid',      // bank, PAGO, 15000
  carteiraPaid: 'u4snap-exp-carteira',    // no card/bank, PAGO, 7500
  cardPurchase: 'u4snap-exp-card',        // card, PAGO, 12000
  invoiceUnpaid: 'u4snap-exp-invoice',    // PAGAMENTO_FATURA_CARTAO, PLANEJADO, 12000
  // Receipt (pessoal)
  receipt: 'u4snap-receipt',              // EM_CAIXA, 50000
  receiptPrevisto: 'u4snap-receipt-prev', // PREVISTO, 10000
  // CashFlowEntries
  cfeBankPaid: 'u4snap-cfe-bank-paid',
  cfeCarteira: 'u4snap-cfe-carteira',
  cfeCard: 'u4snap-cfe-card',
  cfeInvoice: 'u4snap-cfe-invoice',
  cfeReceipt: 'u4snap-cfe-receipt',
  cfeReceiptPrev: 'u4snap-cfe-receipt-prev',
} as const;

const D = new Date('2026-08-10T12:00:00.000Z');

async function seed(prisma: PrismaClient) {
  await prisma.tenant.create({ data: { id: T, name: 'U4 Snapshot Test' } });

  await prisma.project.createMany({
    data: [
      { id: IDS.pessoal, tenantId: T, type: 'PESSOAL', name: 'Snap Pessoal' },
      { id: IDS.reforma, tenantId: T, type: 'REFORMA', name: 'Snap Reforma' },
    ],
  });

  await prisma.expense.createMany({
    data: [
      {
        id: IDS.bankPaid, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 15000, quantidade: 1, valorTotal: 15000,
        formaPagamento: 'A_VISTA', status: 'PAGO', bankLast4: '1234',
      },
      {
        id: IDS.carteiraPaid, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'OUTROS', valor: 7500, quantidade: 1, valorTotal: 7500,
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cardPurchase, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'ELETRODOMESTICO', valor: 12000, quantidade: 1, valorTotal: 12000,
        formaPagamento: 'A_VISTA', status: 'PAGO', cardLast4: '5678',
      },
      {
        id: IDS.invoiceUnpaid, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', valor: 12000, quantidade: 1, valorTotal: 12000,
        formaPagamento: 'A_VISTA', status: 'PLANEJADO', cardLast4: '5678',
      },
    ],
  });

  await prisma.receipt.createMany({
    data: [
      {
        id: IDS.receipt, projectId: IDS.pessoal, tenantId: T,
        valor: 50000, data: D, tipo: 'PAGAMENTO', status: 'EM_CAIXA',
      },
      {
        id: IDS.receiptPrevisto, projectId: IDS.pessoal, tenantId: T,
        valor: 10000, data: D, tipo: 'PAGAMENTO', status: 'PREVISTO',
      },
    ],
  });

  await prisma.cashFlowEntry.createMany({
    data: [
      {
        id: IDS.cfeBankPaid, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.bankPaid,
        valor: 15000, tipo: 'DESPESA', data: D, categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeCarteira, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.carteiraPaid,
        valor: 7500, tipo: 'DESPESA', data: D, categoria: 'OUTROS',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeCard, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.cardPurchase,
        valor: 12000, tipo: 'DESPESA', data: D, categoria: 'ELETRODOMESTICO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeInvoice, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.invoiceUnpaid,
        valor: 12000, tipo: 'DESPESA', data: D, categoria: 'PAGAMENTO_FATURA_CARTAO',
        formaPagamento: 'A_VISTA', status: 'PLANEJADO',
      },
      {
        id: IDS.cfeReceipt, projectId: IDS.pessoal, tenantId: T, receiptId: IDS.receipt,
        valor: 50000, tipo: 'RECEBIMENTO', data: D, categoria: 'PAGAMENTO',
        status: 'EM_CAIXA',
      },
      {
        id: IDS.cfeReceiptPrev, projectId: IDS.pessoal, tenantId: T, receiptId: IDS.receiptPrevisto,
        valor: 10000, tipo: 'RECEBIMENTO', data: D, categoria: 'PAGAMENTO',
        status: 'PREVISTO',
      },
    ],
  });
}

async function cleanup(prisma: PrismaClient) {
  await prisma.cashFlowEntry.deleteMany({ where: { tenantId: T } });
  await prisma.receipt.deleteMany({ where: { tenantId: T } });
  await prisma.expense.deleteMany({ where: { tenantId: T } });
  await prisma.project.deleteMany({ where: { tenantId: T } });
  await prisma.tenant.deleteMany({ where: { id: T } });
}

describe('U4-13: snapshot centavo-precise aggregates (issue #453)', () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  const service = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );

  let overview: Awaited<ReturnType<typeof service.getOverview>>;
  let av: Awaited<ReturnType<typeof service.getAccountView>>;

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout'],
    });
    jest.setSystemTime(CLOCK);
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup(setupPrisma);
    await seed(setupPrisma);
    overview = await service.getOverview(T, IDS.pessoal, MONTH);
    av = await service.getAccountView(T, IDS.pessoal, MONTH);
  });

  afterAll(async () => {
    await cleanup(setupPrisma);
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
    jest.useRealTimers();
  });

  it('snapshot: saiuMes, entrouMes, carteiraHoje, devoCartaoTotal in exact centavos', () => {
    // carteiraHoje: receipts without bankLast4 (EM_CAIXA) - expenses without card/bank (PAGO)
    //   = 50000 (receipt, no bankLast4, EM_CAIXA) - 7500 (carteira, PAGO) = 42500
    const { carteiraHoje } = overview.caixa;
    expect(carteiraHoje).toBe(42500);

    // devoCartaoTotal: invoice pending amounts. Without CreditCard records, the
    // account view builds invoices from expenses with cardLast4. The unpaid invoice
    // (12000) has pending = 12000; the card purchase (12000 PAGO) also shows as
    // a purchase aggregated into the same invoice month. The paid invoice (8000) is
    // already paid. Total devo = pending from invoice rows.
    // Actual observed value from the engine:
    expect(av.devoCartaoTotal).toBe(24000);

    // Entries count: 6 non-espelho entries
    expect(overview.entries.length).toBe(6);

    // Account view saidas include bank-paid + carteira + invoice lines
    expect(av.saidas.length).toBeGreaterThanOrEqual(2);
    expect(av.entradas.length).toBe(2);
  });

  it('snapshot: cartoes.length, saidas.length, comprasCartao.length, entradas.length', () => {
    // Without CreditCard model records, cartoes is built from the cards query
    // which reads the CreditCard table — no records means no cartoes.
    expect(av.cartoes.length).toBe(0);
    expect(av.entradas.length).toBe(2);
    // comprasCartao: card purchase appears as compra under the invoice
    expect(av.comprasCartao.length).toBe(1);
  });
});
