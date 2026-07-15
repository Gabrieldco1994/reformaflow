import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

describe('MonthlyOverviewService timezone boundaries', () => {
  let service: MonthlyOverviewService;
  let prisma: any;

  const tenantId = 'tenant-1';
  const projectId = 'pessoal-1';

  beforeEach(async () => {
    prisma = {
      project: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL', deletedAt: null }),
      },
      expense: { findMany: jest.fn() },
      receipt: { findMany: jest.fn().mockResolvedValue([]) },
      creditCard: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'card-1', last4: '1111', nickname: 'Nubank', closingDay: 10, dueDay: 20 },
        ]),
      },
      bankAccount: { findMany: jest.fn().mockResolvedValue([]) },
      crossProjectSettlement: { findMany: jest.fn().mockResolvedValue([]) },
      rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      invoiceAdjustment: { findMany: jest.fn().mockResolvedValue([]) },
      bankStatementImport: { findMany: jest.fn().mockResolvedValue([]) },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: CardInvoiceSettlementService, useValue: { settleInvoice: jest.fn() } },
      ],
    }).compile();

    service = module.get<MonthlyOverviewService>(MonthlyOverviewService);
  });

  function makeExpense(createdAtIso: string, valor = 12345) {
    return {
      id: `exp-${createdAtIso}`,
      tenantId,
      projectId,
      tipoDespesa: 'OUTROS',
      titulo: 'Compra',
      fornecedor: 'Loja',
      valor,
      valorTotal: valor,
      formaPagamento: 'A_VISTA',
      dataPagamento: null,
      dataInicioParcela: null,
      dataCompra: null,
      createdAt: new Date(createdAtIso),
      quantidadeParcela: null,
      status: 'PAGO',
      cardLast4: '1111',
      bankLast4: null,
      settlesInvoiceKey: null,
    };
  }

  it('usa dia-calendário BRT no fallback createdAt: 23:59 BRT em closingDay-1 cai na fatura do mês corrente', async () => {
    prisma.expense.findMany.mockResolvedValue([
      makeExpense('2026-06-10T02:59:00.000Z'), // 09/06 23:59 BRT
    ]);
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      {
        id: 'cfe-1',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 12345,
        data: new Date('2026-06-09T00:00:00.000Z'),
        status: 'PAGO',
        categoria: 'OUTROS',
        subcategoria: null,
        formaPagamento: 'CARTAO_CREDITO',
        parcela: null,
        expense: {
          id: 'exp-a',
          tipoDespesa: 'OUTROS',
          titulo: 'Compra',
          fornecedor: 'Loja',
          cardLast4: '1111',
          bankLast4: null,
          linkedExpenseId: null,
          settlesInvoiceKey: null,
        },
        receipt: null,
      },
    ]);

    const jun: any = await service.getAccountView(tenantId, projectId, '2026-06');
    const jul: any = await service.getAccountView(tenantId, projectId, '2026-07');

    expect(jun.cartoes.find((c: any) => c.last4 === '1111')?.faturaAtual).toBe(12345);
    expect(jul.cartoes.find((c: any) => c.last4 === '1111')?.faturaAtual ?? 0).toBe(0);
  });

  it('usa dia-calendário BRT no fallback createdAt: 23:59 BRT no closingDay cai na próxima fatura', async () => {
    prisma.expense.findMany.mockResolvedValue([
      makeExpense('2026-06-11T02:59:00.000Z'), // 10/06 23:59 BRT
    ]);
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      {
        id: 'cfe-2',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 12345,
        data: new Date('2026-06-10T00:00:00.000Z'),
        status: 'PAGO',
        categoria: 'OUTROS',
        subcategoria: null,
        formaPagamento: 'CARTAO_CREDITO',
        parcela: null,
        expense: {
          id: 'exp-b',
          tipoDespesa: 'OUTROS',
          titulo: 'Compra',
          fornecedor: 'Loja',
          cardLast4: '1111',
          bankLast4: null,
          linkedExpenseId: null,
          settlesInvoiceKey: null,
        },
        receipt: null,
      },
    ]);

    const jun: any = await service.getAccountView(tenantId, projectId, '2026-06');
    const jul: any = await service.getAccountView(tenantId, projectId, '2026-07');

    expect(jun.cartoes.find((c: any) => c.last4 === '1111')?.faturaAtual ?? 0).toBe(0);
    expect(jul.cartoes.find((c: any) => c.last4 === '1111')?.faturaAtual).toBe(12345);
  });
});
