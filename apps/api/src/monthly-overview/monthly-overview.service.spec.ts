import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

/**
 * Regressão do vínculo cross-project (espelhos): o PESSOAL é o controlador universal
 * do caixa. Um espelho (despesa PESSOAL vinculada a outro projeto) PRECISA aparecer
 * em `entries` (com isEspelho=true) para contar nos KPIs PESSOAL-only, mas NÃO pode
 * ser contado nas linhas consolidadas (o registro do projeto-alvo é o canônico).
 */
describe('MonthlyOverviewService.getOverview — espelhos cross-project', () => {
  let service: MonthlyOverviewService;
  let prisma: any;
  const tenantId = 'tenant-1';
  const PESSOAL = 'pessoal-1';
  const REFORMA = 'reforma-1';

  beforeEach(async () => {
    prisma = {
      project: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: PESSOAL, tenantId, type: 'PESSOAL', deletedAt: null }),
        findMany: jest.fn().mockResolvedValue([
          { id: PESSOAL, type: 'PESSOAL', name: 'Pessoal' },
          { id: REFORMA, type: 'REFORMA', name: 'Reforma' },
        ]),
      },
      cashFlowEntry: { findMany: jest.fn() },
      creditCard: { findMany: jest.fn().mockResolvedValue([]) },
      // §10 computeCaixaConta (pode existir no working tree concorrente) — mocks neutros.
      bankAccount: { findMany: jest.fn().mockResolvedValue([]) },
      bankStatementImport: { findMany: jest.fn().mockResolvedValue([]) },
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

  const baseEntry = (over: Record<string, unknown>) => ({
    tipo: 'DESPESA',
    status: 'PAGO',
    valor: 10000,
    data: new Date('2026-03-15T00:00:00Z'),
    categoria: null,
    subcategoria: null,
    formaPagamento: 'PIX',
    receiptId: null,
    budgetAllocationId: null,
    ...over,
  });

  it('usa o mês solicitado na projeção sem alterar mesAtual', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T12:00:00'));
    prisma.cashFlowEntry.findMany.mockResolvedValue([]);
    const accountView = {
      caixaHoje: 100, entrouMes: 200, saiuMes: 50, faltaPagarMes: 25,
      recebimentosPrevistosMes: 75, sobraPrevista: 300,
    };
    const getAccountView = jest.spyOn(service, 'getAccountView').mockResolvedValue(accountView as any);

    const res = await service.getOverview(tenantId, PESSOAL, '2026-03');

    expect(getAccountView).toHaveBeenCalledWith(tenantId, PESSOAL, '2026-03');
    expect(res.projecao).toEqual({ mes: '2026-03', status: 'ok', ...accountView });
    expect(res.mesAtual).toBe('2026-07');
    jest.useRealTimers();
  });

  it('mantém fallback explícito quando a Visão Conta falha', async () => {
    prisma.cashFlowEntry.findMany.mockResolvedValue([]);
    jest.spyOn(service, 'getAccountView').mockRejectedValue(new Error('account view unavailable'));

    const res = await service.getOverview(tenantId, PESSOAL, '2026-03');

    expect(res.projecao).toEqual({ mes: '2026-03', status: 'degraded' });
  });

  it('marca isEspelho corretamente e mantém o espelho em entries', async () => {
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      baseEntry({ id: 'cfe-esp', projectId: PESSOAL, expenseId: 'e-esp', expense: { linkedExpenseId: 'e-target' } }),
      baseEntry({ id: 'cfe-tgt', projectId: REFORMA, expenseId: 'e-target', expense: { linkedExpenseId: null } }),
    ]);

    const res = await service.getOverview(tenantId, PESSOAL);

    const esp = res.entries.find((e) => e.id === 'cfe-esp');
    const tgt = res.entries.find((e) => e.id === 'cfe-tgt');
    expect(esp?.isEspelho).toBe(true);
    expect(tgt?.isEspelho).toBe(false);
  });

  it('NÃO conta o espelho nas linhas consolidadas (alvo do projeto é o canônico → sem dobra)', async () => {
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      baseEntry({ id: 'cfe-esp', projectId: PESSOAL, expenseId: 'e-esp', expense: { linkedExpenseId: 'e-target' } }),
      baseEntry({ id: 'cfe-tgt', projectId: REFORMA, expenseId: 'e-target', expense: { linkedExpenseId: null } }),
    ]);

    const res = await service.getOverview(tenantId, PESSOAL);

    // R$ 100,00 aparece UMA vez no consolidado (alvo), não R$ 200,00.
    const totalDespesasConsolidado = res.meses.reduce((s, r) => s + r.totalDespesas, 0);
    expect(totalDespesasConsolidado).toBe(10000);
  });

  it('despesa PESSOAL normal (sem vínculo) entra no consolidado com isEspelho=false', async () => {
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      baseEntry({ id: 'cfe-own', projectId: PESSOAL, expenseId: 'e-own', expense: { linkedExpenseId: null } }),
    ]);

    const res = await service.getOverview(tenantId, PESSOAL);

    expect(res.entries.find((e) => e.id === 'cfe-own')?.isEspelho).toBe(false);
    const totalDespesasConsolidado = res.meses.reduce((s, r) => s + r.totalDespesas, 0);
    expect(totalDespesasConsolidado).toBe(10000);
  });

  it('expõe isNeutral confiável derivado de expense.tipoDespesa (independe de categoria label)', async () => {
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      baseEntry({
        id: 'cfe-neutro-cartao',
        projectId: PESSOAL,
        expenseId: 'e-n',
        categoria: 'Outros', // label ambíguo — NÃO deve influenciar a detecção de neutro
        expense: { linkedExpenseId: null, cardLast4: '7259', bankLast4: null, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' },
      }),
      baseEntry({
        id: 'cfe-comum',
        projectId: PESSOAL,
        expenseId: 'e-c',
        expense: { linkedExpenseId: null, cardLast4: '7259', bankLast4: null, tipoDespesa: 'ALIMENTACAO' },
      }),
      baseEntry({ id: 'cfe-receb', projectId: PESSOAL, tipo: 'RECEBIMENTO', expenseId: null, expense: null }),
    ]);

    const res = await service.getOverview(tenantId, PESSOAL);

    const neutro = res.entries.find((e) => e.id === 'cfe-neutro-cartao');
    expect(neutro?.isNeutral).toBe(true);
    expect(neutro?.tipoDespesaCodigo).toBe('PAGAMENTO_FATURA_CARTAO');
    expect(neutro?.cardLast4).toBe('7259');
    expect(neutro?.bankLast4).toBeNull();

    expect(res.entries.find((e) => e.id === 'cfe-comum')?.isNeutral).toBe(false);
    expect(res.entries.find((e) => e.id === 'cfe-receb')?.isNeutral).toBe(false);
  });
});
