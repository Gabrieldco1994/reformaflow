import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

/**
 * Fase 1 §3.2 — enriquecimento aditivo do endpoint:
 * - cada entry expõe `cardLast4` (origem cartão) para derivar o mês de caixa;
 * - a resposta inclui `cards[]` com closingDay/dueDay/last4/nickname.
 * É puramente aditivo: não altera meses/caixa existentes.
 */
describe('MonthlyOverviewService.getOverview — enriquecimento de cartão', () => {
  let service: MonthlyOverviewService;
  let prisma: any;
  const tenantId = 'tenant-1';
  const PESSOAL = 'pessoal-1';

  beforeEach(async () => {
    prisma = {
      project: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: PESSOAL, tenantId, type: 'PESSOAL', deletedAt: null }),
        findMany: jest.fn().mockResolvedValue([{ id: PESSOAL, type: 'PESSOAL', name: 'Pessoal' }]),
      },
      cashFlowEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'cfe-card',
            projectId: PESSOAL,
            tipo: 'DESPESA',
            status: 'PAGO',
            valor: 10000,
            data: new Date('2026-01-15T00:00:00Z'),
            categoria: 'COMPRAS_VAREJO',
            subcategoria: 'Loja X',
            formaPagamento: 'CARTAO',
            receiptId: null,
            budgetAllocationId: null,
            expenseId: 'e-card',
            expense: { linkedExpenseId: null, cardLast4: '1234' },
          },
        ]),
      },
      creditCard: {
        findMany: jest.fn().mockResolvedValue([
          { last4: '1234', nickname: 'Nubank', closingDay: 28, dueDay: 7 },
        ]),
      },
      bankAccount: { findMany: jest.fn().mockResolvedValue([]) },
      expense: { findMany: jest.fn().mockResolvedValue([]) },
      receipt: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: CardInvoiceSettlementService, useValue: { settleInvoice: jest.fn().mockResolvedValue({ settledExpenses: 0, settledParcelas: 0 }) } },
      ],
    }).compile();
    service = module.get<MonthlyOverviewService>(MonthlyOverviewService);
  });

  it('expõe cardLast4 em cada entry de origem cartão', async () => {
    const res: any = await service.getOverview(tenantId, PESSOAL);
    const entry = res.entries.find((e: any) => e.id === 'cfe-card');
    expect(entry.cardLast4).toBe('1234');
  });

  it('expõe parcela por entry (para trilha de comprometimento/tooltip)', async () => {
    const res: any = await service.getOverview(tenantId, PESSOAL);
    const entry = res.entries.find((e: any) => e.id === 'cfe-card');
    expect(entry.parcela ?? null).toBe(null);
  });

  it('inclui cards[] com closingDay/dueDay/last4/nickname', async () => {
    const res: any = await service.getOverview(tenantId, PESSOAL);
    expect(res.cards).toContainEqual({
      last4: '1234',
      nickname: 'Nubank',
      closingDay: 28,
      dueDay: 7,
    });
  });

  it('expõe categoriaCodigo (código bruto) por entry para detecção de neutras', async () => {
    const res: any = await service.getOverview(tenantId, PESSOAL);
    const entry = res.entries.find((e: any) => e.id === 'cfe-card');
    expect(entry.categoriaCodigo).toBe('COMPRAS_VAREJO');
  });
});
