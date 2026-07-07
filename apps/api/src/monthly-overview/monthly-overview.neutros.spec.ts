import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

describe('MonthlyOverviewService.getNeutros', () => {
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
      receipt: { findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CardInvoiceSettlementService,
          useValue: { settleInvoice: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<MonthlyOverviewService>(MonthlyOverviewService);
  });

  const exp = (over: any) => ({
    id: 'e', tipoDespesa: 'OUTROS', titulo: null, fornecedor: null,
    valor: 0, valorTotal: 0, quantidade: 1, formaPagamento: 'A_VISTA',
    quantidadeParcela: null, dataPagamento: new Date('2026-03-10T00:00:00.000Z'),
    dataInicioParcela: null, dataCompra: null, createdAt: new Date('2026-03-10T00:00:00.000Z'),
    status: 'PAGO', cardLast4: null, bankLast4: '3636', ...over,
  });
  const rec = (over: any) => ({
    id: 'r', tipo: 'SALARIO', descricao: null, valor: 0,
    data: new Date('2026-04-01T00:00:00.000Z'), status: 'EM_CAIXA', bankLast4: '3636', ...over,
  });

  it('retorna só neutros (consumo-neutro nas despesas, neutro nas receitas) do ano', async () => {
    prisma.expense.findMany.mockResolvedValue([
      exp({ id: 'ap', tipoDespesa: 'INVESTIMENTOS', titulo: 'Aporte CDB', valorTotal: 200000 }),
      exp({ id: 'fat', tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', titulo: 'Fatura', valorTotal: 50000 }),
      exp({ id: 'mercado', tipoDespesa: 'ALIMENTACAO', titulo: 'Mercado', valorTotal: 9000 }), // NÃO neutro
      exp({ id: 'outroano', tipoDespesa: 'INVESTIMENTOS', valorTotal: 999, dataPagamento: new Date('2025-03-10T00:00:00.000Z') }),
    ]);
    prisma.receipt.findMany.mockResolvedValue([
      rec({ id: 'resg', tipo: 'RESGATE', descricao: 'Resgate', valor: 300000 }),
      rec({ id: 'transf', tipo: 'TRANSFERENCIA_PROPRIA', descricao: 'PIX próprio', valor: 100000 }),
      rec({ id: 'sal', tipo: 'SALARIO', descricao: 'Salário', valor: 500000 }), // NÃO neutro
    ]);

    const res = await service.getNeutros(tenantId, projectId, 2026);

    const ids = res.itens.map((i) => i.id).sort();
    expect(ids).toEqual(['ap', 'fat', 'resg', 'transf']);
    expect(res.itens.some((i) => i.id === 'mercado')).toBe(false);
    expect(res.itens.some((i) => i.id === 'sal')).toBe(false);
    expect(res.itens.some((i) => i.id === 'outroano')).toBe(false);

    expect(res.totalSaidas).toBe(250000); // 200000 + 50000
    expect(res.totalEntradas).toBe(400000); // 300000 + 100000
    expect(res.totalLiquido).toBe(150000);
  });

  it('afetaCaixa: settlement (fatura) = false; aporte/resgate = true', async () => {
    prisma.expense.findMany.mockResolvedValue([
      exp({ id: 'ap', tipoDespesa: 'INVESTIMENTOS', valorTotal: 100 }),
      exp({ id: 'fat', tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', valorTotal: 100 }),
      exp({ id: 'mov', tipoDespesa: 'MOVIMENTACAO_INTERNA', valorTotal: 100 }),
    ]);
    prisma.receipt.findMany.mockResolvedValue([
      rec({ id: 'resg', tipo: 'RESGATE', valor: 100 }),
    ]);

    const res = await service.getNeutros(tenantId, projectId, 2026);
    const byId = Object.fromEntries(res.itens.map((i) => [i.id, i.afetaCaixa]));
    expect(byId['ap']).toBe(true); // aporte continua no caixa
    expect(byId['resg']).toBe(true); // resgate é crédito real
    expect(byId['fat']).toBe(false); // settlement não gera cashflow
    expect(byId['mov']).toBe(false); // movimentação interna idem
  });
});
