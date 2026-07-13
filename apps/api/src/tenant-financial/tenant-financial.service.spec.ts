import { Test, TestingModule } from '@nestjs/testing';
import { TenantFinancialService } from './tenant-financial.service';
import { PrismaService } from '../prisma/prisma.service';
import { MonthlyOverviewService } from '../monthly-overview/monthly-overview.service';

const TENANT = 'tenant-1';
const NOW = new Date('2026-05-15T12:00:00Z');

function makePrismaMock() {
  return {
    project: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    receipt: { findMany: jest.fn() },
    cashFlowEntry: { findMany: jest.fn() },
    expense: { findMany: jest.fn() },
  };
}

describe('TenantFinancialService', () => {
  let service: TenantFinancialService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let monthly: { getCaixaConta: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = makePrismaMock();
    monthly = { getCaixaConta: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TenantFinancialService,
        { provide: PrismaService, useValue: prisma },
        { provide: MonthlyOverviewService, useValue: monthly },
      ],
    }).compile();
    service = moduleRef.get(TenantFinancialService);
  });

  afterEach(() => jest.useRealTimers());

  describe('getOverview — caixa vem do §10 (motor único), não Σ receipts', () => {
    const PESSOAL = 'pessoal-1';
    const CAIXA_10 = 6_342_735; // §10 do PESSOAL (mock do motor canônico)

    it('caixaTotal === §10; saldoProjetado deriva do §10 (não de Σ receipts EM_CAIXA)', async () => {
      monthly.getCaixaConta.mockResolvedValue({
        hoje: CAIXA_10, saldoInicial: 1_428_597, temSaldoInicial: true, porMes: [],
      });
      prisma.project.findMany.mockResolvedValue([
        { id: PESSOAL, name: 'Pessoal', type: 'PESSOAL' },
        { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' },
        { id: 'casa-1', name: 'Casa', type: 'CASA' },
      ]);
      // Σ receipts EM_CAIXA = 150_000 de propósito (valor ANTIGO de caixaTotal):
      // se alguém reintroduzir a soma de receipts, o assert §10 pega a regressão.
      prisma.receipt.findMany.mockResolvedValue([
        { valor: 100_000, status: 'EM_CAIXA', data: new Date('2026-04-01') },
        { valor: 50_000, status: 'EM_CAIXA', data: new Date('2026-03-01') },
        { valor: 200_000, status: 'PREVISTO', data: new Date('2026-06-01') },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([
        { valor: 30_000, tipo: 'DESPESA', status: 'PAGO', data: new Date('2026-05-10') },
        { valor: 20_000, tipo: 'DESPESA', status: 'PAGO', data: new Date('2026-01-15') },
        { valor: 15_000, tipo: 'DESPESA', status: 'PAGO', data: new Date('2025-12-15') },
        { valor: 25_000, tipo: 'DESPESA', status: 'PLANEJADO', data: new Date('2026-05-20') },
        { valor: 40_000, tipo: 'DESPESA', status: 'PLANEJADO', data: new Date('2026-07-10') },
        { valor: 99_999, tipo: 'DESPESA', status: 'PLANEJADO', data: new Date('2026-12-31') },
        { valor: 60_000, tipo: 'RECEBIMENTO', status: 'PREVISTO', data: new Date('2026-05-25') },
        { valor: 70_000, tipo: 'RECEBIMENTO', status: 'PAGO', data: new Date('2026-05-25') },
      ]);

      const r = await service.getOverview(TENANT, null);

      expect(r.caixaTotal).toBe(CAIXA_10); // §10, não 150_000
      expect(monthly.getCaixaConta).toHaveBeenCalledWith(TENANT, PESSOAL);
      expect(r.totalProjetos).toBe(3);
      expect(r.pagoMesAtual).toBe(30_000);
      expect(r.pagoYTD).toBe(50_000); // 30k + 20k
      expect(r.pagoTotal).toBe(65_000); // 30k + 20k + 15k
      expect(r.previsao30d).toBe(25_000);
      expect(r.previsao90d).toBe(65_000); // 25k + 40k
      expect(r.recebimento30d).toBe(60_000);
      expect(r.recebimento90d).toBe(60_000);
      expect(r.saldoProjetado30d).toBe(CAIXA_10 + 60_000 - 25_000);
      expect(r.saldoProjetado90d).toBe(CAIXA_10 + 60_000 - 65_000);
      // Contrato "motor único, não Σreceipts": getOverview NÃO consulta receipts.
      // Se alguém reintroduzir a query de receipts (comportamento antigo), isto pega.
      expect(prisma.receipt.findMany).not.toHaveBeenCalled();
    });

    it('sem projeto PESSOAL no escopo → caixaTotal e saldoProjetado null; §10 não é chamado', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.receipt.findMany.mockResolvedValue([
        { valor: 999_999, status: 'EM_CAIXA', data: new Date('2026-04-01') },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([]);

      const r = await service.getOverview(TENANT, null);

      expect(r.caixaTotal).toBeNull();
      expect(r.saldoProjetado30d).toBeNull();
      expect(r.saldoProjetado90d).toBeNull();
      expect(r.totalProjetos).toBe(1);
      expect(monthly.getCaixaConta).not.toHaveBeenCalled();
    });

    it('múltiplos PESSOAL no escopo → caixaTotal soma o §10 de TODOS (consolidado, sem omitir conta)', async () => {
      // /financeiro é a visão CONSOLIDADA: com 2 projetos PESSOAL o caixa é a SOMA
      // dos §10, nunca só o mais antigo (senão a 2ª conta some do total). Blinda a
      // regressão de "find(primeiro PESSOAL)" que omitia silenciosamente contas.
      monthly.getCaixaConta.mockImplementation((_t: string, projectId: string) =>
        Promise.resolve({
          hoje: projectId === 'pessoal-1' ? 6_342_735 : 1_000_000,
          saldoInicial: 0,
          temSaldoInicial: true,
          porMes: [],
        }),
      );
      prisma.project.findMany.mockResolvedValue([
        { id: 'pessoal-1', name: 'Pessoal A', type: 'PESSOAL' },
        { id: 'pessoal-2', name: 'Pessoal B', type: 'PESSOAL' },
        { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([]);

      const r = await service.getOverview(TENANT, null);

      expect(r.caixaTotal).toBe(6_342_735 + 1_000_000);
      expect(r.saldoProjetado30d).toBe(6_342_735 + 1_000_000); // base consolidada, sem deltas
      expect(monthly.getCaixaConta).toHaveBeenCalledWith(TENANT, 'pessoal-1');
      expect(monthly.getCaixaConta).toHaveBeenCalledWith(TENANT, 'pessoal-2');
      expect(monthly.getCaixaConta).toHaveBeenCalledTimes(2);
    });
  });

  describe('getOverview — escopo (o filtro de projetos precisa chegar às queries)', () => {
    it('escopo inclui PESSOAL → caixaTotal === §10; where escopado nas duas queries', async () => {
      const scope = ['pessoal-1', 'reforma-1'];
      monthly.getCaixaConta.mockResolvedValue({
        hoje: 6_342_735, saldoInicial: 0, temSaldoInicial: true, porMes: [],
      });
      prisma.project.findMany.mockResolvedValue([
        { id: 'pessoal-1', name: 'Pessoal', type: 'PESSOAL' },
        { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([]);

      const r = await service.getOverview(TENANT, scope);

      expect(r.caixaTotal).toBe(6_342_735);
      expect(monthly.getCaixaConta).toHaveBeenCalledWith(TENANT, 'pessoal-1');
      // Sem o escopo nas queries, o /financeiro filtrado vazaria outros projetos.
      expect(prisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: scope } }) }),
      );
      expect(prisma.cashFlowEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ projectId: { in: scope } }) }),
      );
    });

    it('escopo exclui PESSOAL → caixaTotal/saldoProjetado null; §10 não chamado; where escopado', async () => {
      const scope = ['reforma-1'];
      prisma.project.findMany.mockResolvedValue([
        { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([]);

      const r = await service.getOverview(TENANT, scope);

      expect(r.caixaTotal).toBeNull();
      expect(r.saldoProjetado30d).toBeNull();
      expect(r.saldoProjetado90d).toBeNull();
      expect(monthly.getCaixaConta).not.toHaveBeenCalled();
      expect(prisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: scope } }) }),
      );
      expect(prisma.cashFlowEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ projectId: { in: scope } }) }),
      );
    });
  });

  describe('getByProject', () => {
    it('agrega gasto, planejado e recebimento por projeto', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'p1', name: 'Reforma', type: 'REFORMA' },
        { id: 'p2', name: 'Casa', type: 'CASA' },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([
        { projectId: 'p1', tipo: 'DESPESA', status: 'PAGO', valor: 1000 },
        { projectId: 'p1', tipo: 'DESPESA', status: 'PAGO', valor: 500 },
        { projectId: 'p1', tipo: 'DESPESA', status: 'PLANEJADO', valor: 300 },
        { projectId: 'p2', tipo: 'DESPESA', status: 'PAGO', valor: 200 },
        { projectId: 'p2', tipo: 'DESPESA', status: 'PLANEJADO', valor: 100 },
      ]);
      prisma.receipt.findMany.mockResolvedValue([
        { projectId: 'p1', status: 'EM_CAIXA', valor: 2000 },
        { projectId: 'p1', status: 'PREVISTO', valor: 500 },
        { projectId: 'p2', status: 'EM_CAIXA', valor: 0 },
      ]);

      const r = await service.getByProject(TENANT, null);
      const p1 = r.find((x) => x.projectId === 'p1')!;
      const p2 = r.find((x) => x.projectId === 'p2')!;
      expect(p1.gastoTotal).toBe(1500);
      expect(p1.planejadoRestante).toBe(300);
      expect(p1.recebimentoTotal).toBe(2000);
      expect(p1.recebimentoPrevisto).toBe(500);
      expect(p1.saldo).toBe(500); // 2000 - 1500
      expect(p1.progresso).toBeCloseTo(1500 / 1800, 4);
      expect(p2.gastoTotal).toBe(200);
      expect(p2.planejadoRestante).toBe(100);
    });

    it('retorna lista vazia quando não há projetos', async () => {
      prisma.project.findMany.mockResolvedValue([]);
      const r = await service.getByProject(TENANT, null);
      expect(r).toEqual([]);
    });

    it('progresso=0 quando nada foi gasto nem planejado', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'p1', name: 'Vazio', type: 'PESSOAL' },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([]);
      prisma.receipt.findMany.mockResolvedValue([]);
      const r = await service.getByProject(TENANT, null);
      expect(r[0].progresso).toBe(0);
    });
  });

  describe('getCashFlow', () => {
    it('pré-popula 12 meses e agrega valores por mês + saldo acumulado', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'p1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([
        { projectId: 'p1', tipo: 'DESPESA', status: 'PAGO', valor: 100, data: new Date('2026-05-10') },
        { projectId: 'p1', tipo: 'DESPESA', status: 'PLANEJADO', valor: 50, data: new Date('2026-05-25') },
        { projectId: 'p1', tipo: 'RECEBIMENTO', status: 'EM_CAIXA', valor: 200, data: new Date('2026-04-01') },
        { projectId: 'p1', tipo: 'RECEBIMENTO', status: 'PREVISTO', valor: 80, data: new Date('2026-05-30') },
      ]);

      const r = await service.getCashFlow(TENANT, 12, null);
      expect(r.length).toBe(12); // 12 meses pré-populados
      const may = r.find((p) => p.mes === '2026-05')!;
      const apr = r.find((p) => p.mes === '2026-04')!;
      expect(may.pago).toBe(100);
      expect(may.planejado).toBe(50);
      expect(may.recebido).toBe(0);
      expect(may.previsto).toBe(80);
      expect(may.byProject['p1']).toEqual({ pago: 100, planejado: 50 });
      expect(apr.recebido).toBe(200);
      // Saldo acumulado: depende da ordem; verifica que monotonia respeita receita-despesa
      expect(apr.saldoAcumulado).toBe(200);
      expect(may.saldoAcumulado).toBe(200 - 100);
    });

    it('ignora entries de projetos deletados (não no set de projetos)', async () => {
      prisma.project.findMany.mockResolvedValue([{ id: 'p1', name: 'Ok', type: 'PESSOAL' }]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([
        { projectId: 'pX-deletado', tipo: 'DESPESA', status: 'PAGO', valor: 9999, data: new Date('2026-05-01') },
      ]);
      const r = await service.getCashFlow(TENANT, 3, null);
      const may = r.find((p) => p.mes === '2026-05')!;
      expect(may.pago).toBe(0);
    });
  });

  describe('getByCategory', () => {
    it('agrupa por tipoDespesa e ordena desc', async () => {
      prisma.expense.findMany.mockResolvedValue([
        { tipoDespesa: 'MARMORE', valorTotal: 5000 },
        { tipoDespesa: 'MARMORE', valorTotal: 3000 },
        { tipoDespesa: 'ELETRODOMESTICO', valorTotal: 10000 },
        { tipoDespesa: 'PINTURA', valorTotal: 200 },
      ]);
      const r = await service.getByCategory(TENANT, null);
      expect(r[0].key).toBe('ELETRODOMESTICO');
      expect(r[0].total).toBe(10000);
      expect(r[1].key).toBe('MARMORE');
      expect(r[1].total).toBe(8000);
    });
  });

  describe('getUpcoming', () => {
    it('retorna apenas entries PLANEJADO/PREVISTO no range, com projectName preenchido', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'p1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([
        {
          projectId: 'p1',
          tipo: 'DESPESA',
          status: 'PLANEJADO',
          valor: 500,
          data: new Date('2026-05-20'),
          categoria: 'MARMORE',
          expense: { titulo: 'Bancada', fornecedor: 'X' },
          receipt: null,
        },
        {
          projectId: 'p1',
          tipo: 'RECEBIMENTO',
          status: 'PREVISTO',
          valor: 1000,
          data: new Date('2026-05-25'),
          categoria: 'PAGAMENTO',
          expense: null,
          receipt: { descricao: 'Pagamento cliente', tipo: 'PAGAMENTO' },
        },
      ]);
      const r = await service.getUpcoming(TENANT, 30, null);
      expect(r).toHaveLength(2);
      expect(r[0].descricao).toBe('Bancada');
      expect(r[0].projectName).toBe('Reforma');
      expect(r[1].descricao).toBe('Pagamento cliente');
    });

    it('filtra projetos órfãos (projectId desconhecido)', async () => {
      prisma.project.findMany.mockResolvedValue([{ id: 'p1', name: 'X', type: 'PESSOAL' }]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([
        {
          projectId: 'pZ',
          tipo: 'DESPESA',
          status: 'PLANEJADO',
          valor: 100,
          data: new Date('2026-05-20'),
          categoria: 'X',
          expense: null,
          receipt: null,
        },
      ]);
      const r = await service.getUpcoming(TENANT, 30, null);
      expect(r).toEqual([]);
    });
  });

  describe('getTopSuppliers', () => {
    it('agrupa por fornecedor (case-insensitive) e ordena desc', async () => {
      prisma.expense.findMany.mockResolvedValue([
        { fornecedor: 'Polo Marmores', valorTotal: 2000, projectId: 'p1', project: { name: 'Reforma' } },
        { fornecedor: 'POLO MARMORES', valorTotal: 3000, projectId: 'p2', project: { name: 'Casa' } },
        { fornecedor: 'Outro', valorTotal: 500, projectId: 'p1', project: { name: 'Reforma' } },
      ]);
      const r = await service.getTopSuppliers(TENANT, 10, null);
      expect(r[0].total).toBe(5000);
      expect(r[0].count).toBe(2);
      expect(r[0].projetos).toHaveLength(2);
      expect(r[1].fornecedor).toBe('Outro');
    });

    it('respeita limit', async () => {
      prisma.expense.findMany.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          fornecedor: `F${i}`,
          valorTotal: 1000 - i,
          projectId: 'p1',
          project: { name: 'X' },
        })),
      );
      const r = await service.getTopSuppliers(TENANT, 5, null);
      expect(r).toHaveLength(5);
    });

    it('ignora fornecedor vazio', async () => {
      prisma.expense.findMany.mockResolvedValue([
        { fornecedor: '  ', valorTotal: 100, projectId: 'p1', project: { name: 'X' } },
        { fornecedor: 'Real', valorTotal: 200, projectId: 'p1', project: { name: 'X' } },
      ]);
      const r = await service.getTopSuppliers(TENANT, 10, null);
      expect(r).toHaveLength(1);
      expect(r[0].fornecedor).toBe('Real');
    });
  });
});
