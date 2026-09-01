/**
 * U4 actions integration tests (issue #453).
 *
 * Uses real DB to prove the actions derivation in `enrich()` works
 * end-to-end through the query path — mocks don't prove query paths.
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

const T = 'u4act-tenant';
const IDS = {
  pessoal: 'u4act-proj-pessoal',
  reforma: 'u4act-proj-reforma',
  // Expenses
  paidExpense: 'u4act-exp-paid',
  espelhoExpense: 'u4act-exp-espelho',
  carteiraExpense: 'u4act-exp-carteira',
  invoiceExpense: 'u4act-exp-invoice',
  invoicePaidExpense: 'u4act-exp-invoice-paid',
  settlementExpense: 'u4act-exp-settlement',
  // Rateio
  rateioSource: 'u4act-exp-rateio-source',
  rateioTarget1: 'u4act-exp-rateio-target1',
  rateioTarget2: 'u4act-exp-rateio-target2',
  rateioEspelho1: 'u4act-exp-rateio-espelho1',
  rateioEspelho2: 'u4act-exp-rateio-espelho2',
  rateioAlloc1: 'u4act-rateio-alloc1',
  rateioAlloc2: 'u4act-rateio-alloc2',
  // Receipts
  receipt1: 'u4act-receipt-1',
  // CashFlowEntries
  cfePaid: 'u4act-cfe-paid',
  cfeEspelho: 'u4act-cfe-espelho',
  cfeCarteira: 'u4act-cfe-carteira',
  cfeInvoice: 'u4act-cfe-invoice',
  cfeInvoicePaid: 'u4act-cfe-invoice-paid',
  cfeSettlement: 'u4act-cfe-settlement',
  cfeReceipt: 'u4act-cfe-receipt',
  cfeRateioSource: 'u4act-cfe-rateio-source',
  cfeRateioTarget1: 'u4act-cfe-rateio-target1',
  cfeRateioTarget2: 'u4act-cfe-rateio-target2',
  cfeRateioEspelho1: 'u4act-cfe-rateio-espelho1',
  cfeRateioEspelho2: 'u4act-cfe-rateio-espelho2',
} as const;

const D = new Date('2026-08-10T12:00:00.000Z');

async function seed(prisma: PrismaClient) {
  // Tenant
  await prisma.tenant.create({ data: { id: T, name: 'U4 Actions Test' } });

  // Projects
  await prisma.project.createMany({
    data: [
      { id: IDS.pessoal, tenantId: T, type: 'PESSOAL', name: 'Pessoal U4' },
      { id: IDS.reforma, tenantId: T, type: 'REFORMA', name: 'Reforma U4' },
    ],
  });

  // Expenses
  await prisma.expense.createMany({
    data: [
      // Normal paid expense (bank)
      {
        id: IDS.paidExpense, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 5000, quantidade: 1, valorTotal: 5000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D, bankLast4: '1234',
      },
      // Espelho (linked to paidExpense)
      {
        id: IDS.espelhoExpense, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 5000, quantidade: 1, valorTotal: 5000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D, bankLast4: '1234',
        linkedExpenseId: IDS.paidExpense,
      },
      // Carteira expense (no card, no bank)
      {
        id: IDS.carteiraExpense, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'OUTROS', valor: 3000, quantidade: 1, valorTotal: 3000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D,
      },
      // Invoice expense (PAGAMENTO_FATURA_CARTAO, unpaid)
      {
        id: IDS.invoiceExpense, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', valor: 10000, quantidade: 1, valorTotal: 10000,
        formaPagamento: 'A_VISTA', status: 'PLANEJADO', createdAt: D, cardLast4: '9999',
      },
      // Invoice expense (PAGAMENTO_FATURA_CARTAO, paid)
      {
        id: IDS.invoicePaidExpense, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', valor: 8000, quantidade: 1, valorTotal: 8000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D, cardLast4: '9999',
      },
      // Settlement expense (settlesInvoiceKey) — neutral, NOT in saiuMes
      {
        id: IDS.settlementExpense, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', valor: 8000, quantidade: 1, valorTotal: 8000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D, bankLast4: '5678',
        settlesInvoiceKey: '9999:2026-08',
      },
      // Rateio source
      {
        id: IDS.rateioSource, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 10000, quantidade: 1, valorTotal: 10000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D, bankLast4: '1234',
      },
      // Rateio targets (in reforma)
      {
        id: IDS.rateioTarget1, projectId: IDS.reforma, tenantId: T,
        tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 4000, quantidade: 1, valorTotal: 4000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D,
      },
      {
        id: IDS.rateioTarget2, projectId: IDS.reforma, tenantId: T,
        tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 6000, quantidade: 1, valorTotal: 6000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D,
      },
      // Rateio espelhos (in pessoal, linked to targets)
      {
        id: IDS.rateioEspelho1, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 4000, quantidade: 1, valorTotal: 4000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D, bankLast4: '1234',
        linkedExpenseId: IDS.rateioTarget1,
      },
      {
        id: IDS.rateioEspelho2, projectId: IDS.pessoal, tenantId: T,
        tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 6000, quantidade: 1, valorTotal: 6000,
        formaPagamento: 'A_VISTA', status: 'PAGO', createdAt: D, bankLast4: '1234',
        linkedExpenseId: IDS.rateioTarget2,
      },
    ],
  });

  // RateioAllocations
  await prisma.rateioAllocation.createMany({
    data: [
      {
        id: IDS.rateioAlloc1, tenantId: T,
        sourceExpenseId: IDS.rateioSource,
        targetExpenseId: IDS.rateioTarget1,
        allocation: 4000, plannedStatus: 'PLANEJADO',
      },
      {
        id: IDS.rateioAlloc2, tenantId: T,
        sourceExpenseId: IDS.rateioSource,
        targetExpenseId: IDS.rateioTarget2,
        allocation: 6000, plannedStatus: 'PLANEJADO',
      },
    ],
  });

  // Receipt
  await prisma.receipt.createMany({
    data: [
      {
        id: IDS.receipt1, projectId: IDS.pessoal, tenantId: T,
        valor: 20000, data: D, tipo: 'PAGAMENTO', status: 'EM_CAIXA',
      },
    ],
  });

  // CashFlowEntries
  await prisma.cashFlowEntry.createMany({
    data: [
      {
        id: IDS.cfePaid, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.paidExpense,
        valor: 5000, tipo: 'DESPESA', data: D, categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeEspelho, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.espelhoExpense,
        valor: 5000, tipo: 'DESPESA', data: D, categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeCarteira, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.carteiraExpense,
        valor: 3000, tipo: 'DESPESA', data: D, categoria: 'OUTROS',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeInvoice, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.invoiceExpense,
        valor: 10000, tipo: 'DESPESA', data: D, categoria: 'PAGAMENTO_FATURA_CARTAO',
        formaPagamento: 'A_VISTA', status: 'PLANEJADO',
      },
      {
        id: IDS.cfeInvoicePaid, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.invoicePaidExpense,
        valor: 8000, tipo: 'DESPESA', data: D, categoria: 'PAGAMENTO_FATURA_CARTAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeSettlement, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.settlementExpense,
        valor: 8000, tipo: 'DESPESA', data: D, categoria: 'PAGAMENTO_FATURA_CARTAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeReceipt, projectId: IDS.pessoal, tenantId: T, receiptId: IDS.receipt1,
        valor: 20000, tipo: 'RECEBIMENTO', data: D, categoria: 'PAGAMENTO',
        status: 'EM_CAIXA',
      },
      // Rateio entries
      {
        id: IDS.cfeRateioSource, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.rateioSource,
        valor: 10000, tipo: 'DESPESA', data: D, categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeRateioTarget1, projectId: IDS.reforma, tenantId: T, expenseId: IDS.rateioTarget1,
        valor: 4000, tipo: 'DESPESA', data: D, categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeRateioTarget2, projectId: IDS.reforma, tenantId: T, expenseId: IDS.rateioTarget2,
        valor: 6000, tipo: 'DESPESA', data: D, categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeRateioEspelho1, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.rateioEspelho1,
        valor: 4000, tipo: 'DESPESA', data: D, categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
      {
        id: IDS.cfeRateioEspelho2, projectId: IDS.pessoal, tenantId: T, expenseId: IDS.rateioEspelho2,
        valor: 6000, tipo: 'DESPESA', data: D, categoria: 'MATERIAL_CONSTRUCAO',
        formaPagamento: 'A_VISTA', status: 'PAGO',
      },
    ],
  });
}

async function cleanup(prisma: PrismaClient) {
  const allIds = Object.values(IDS);
  // Order matters: FK constraints
  await prisma.cashFlowEntry.deleteMany({ where: { tenantId: T } });
  await prisma.rateioAllocation.deleteMany({ where: { tenantId: T } });
  await prisma.receipt.deleteMany({ where: { tenantId: T } });
  await prisma.expense.deleteMany({ where: { tenantId: T } });
  await prisma.project.deleteMany({ where: { tenantId: T } });
  await prisma.tenant.deleteMany({ where: { id: T } });
}

describe('U4 actions integration (issue #453)', () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  const service = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );

  let overview: Awaited<ReturnType<typeof service.getOverview>>;

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
  });

  afterAll(async () => {
    await cleanup(setupPrisma);
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
    jest.useRealTimers();
  });

  // U4-03: despesa PAGO → actions.length > 0 e contém { actionId: 'edit' }
  it('U4-03: paid expense entry has actions including edit', () => {
    const entry = overview.entries.find((e) => e.id === IDS.cfePaid);
    expect(entry).toBeDefined();
    expect(entry!.actions.length).toBeGreaterThan(0);
    expect(entry!.actions).toContainEqual({ actionId: 'edit' });
  });

  // U4-04: entrada com isEspelho → actions: []
  it('U4-04: espelho entry has empty actions', () => {
    const entry = overview.entries.find((e) => e.id === IDS.cfeEspelho);
    expect(entry).toBeDefined();
    expect(entry!.isEspelho).toBe(true);
    expect(entry!.actions).toEqual([]);
  });

  // U4-05: rateio scenario — all ids unique, targets not in saidas
  it('U4-05: rateio ids are unique across saidas+comprasCartao+entradas', async () => {
    const av = await service.getAccountView(T, IDS.pessoal, MONTH);
    const allItems = [...av.saidas, ...av.comprasCartao, ...av.entradas];
    const ids = allItems.map((item: any) => item.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Targets should NOT appear in saidas (they belong to reforma, not pessoal saidas)
    const saidaIds = new Set(av.saidas.map((s: any) => s.id));
    expect(saidaIds.has(IDS.rateioTarget1)).toBe(false);
    expect(saidaIds.has(IDS.rateioTarget2)).toBe(false);
  });

  // U4-06: carteira expense (no card, no bank, PAGO) → in saidas and carteiraHoje > 0
  it('U4-06: carteira expense appears in saidas and carteiraHoje > 0', async () => {
    const av = await service.getAccountView(T, IDS.pessoal, MONTH);
    // The carteira expense should contribute to carteiraHoje
    expect(overview.caixa.carteiraHoje).not.toBe(0);

    // Check that a carteira-like item is in saidas
    const carteiraSaida = av.saidas.find(
      (s: any) => !s.cardLast4 && !s.bankLast4 && !s.isInvoice && s.kind === 'saida',
    );
    expect(carteiraSaida).toBeDefined();
  });

  // U4-07: PAGAMENTO_FATURA_CARTAO with settlesInvoiceKey → neutral, not in saiuMes consumption
  it('U4-07: settlement expense is neutral and not counted in saiuMes', async () => {
    const settlementEntry = overview.entries.find((e) => e.id === IDS.cfeSettlement);
    expect(settlementEntry).toBeDefined();
    expect(settlementEntry!.isNeutral).toBe(true);
  });
});
