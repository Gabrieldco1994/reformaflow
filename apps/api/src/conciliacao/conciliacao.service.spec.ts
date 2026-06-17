import { Test, TestingModule } from '@nestjs/testing';
import { ConciliacaoService } from './conciliacao.service';
import { PrismaService } from '../prisma/prisma.service';

function makeTarget(over: Partial<any> = {}) {
  return {
    id: 'tgt',
    tenantId: 't1',
    projectId: 'reforma1',
    tipoDespesa: 'METAL_CERAMICA',
    categoriaMaoDeObra: null,
    roomId: null,
    valorTotal: 30000,
    formaPagamento: 'PARCELADO',
    dataPagamento: null,
    quantidadeParcela: 3,
    dataInicioParcela: new Date('2026-04-29'),
    status: 'PLANEJADO',
    paidParcelas: null,
    linkedExpenseId: null,
    room: null,
    ...over,
  };
}

function makeSource(over: Partial<any> = {}) {
  return {
    id: 'src',
    tenantId: 't1',
    projectId: 'pessoal1',
    cardLast4: '1234',
    linkedExpenseId: null,
    ...over,
  };
}

describe('ConciliacaoService', () => {
  let service: ConciliacaoService;
  let prisma: any;

  function buildPrisma(opts: { target: any; source: any; settlementsByTarget?: any[]; sourceRows?: any[] }) {
    const p: any = {
      expense: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where.id === 'tgt') return Promise.resolve(opts.target);
          if (where.id === 'src') return Promise.resolve(opts.source);
          return Promise.resolve(null);
        }),
        update: jest.fn().mockImplementation(({ where, data }: any) => {
          // Simula persistência: mutações ficam visíveis em findFirst seguintes (regen).
          if (where.id === 'tgt' && opts.target) Object.assign(opts.target, data);
          if (where.id === 'src' && opts.source) Object.assign(opts.source, data);
          return Promise.resolve({});
        }),
      },
      crossProjectSettlement: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          if (where.sourceExpenseId && !where.targetExpenseId) {
            return Promise.resolve(opts.sourceRows ?? []);
          }
          // regen: by targetExpenseId
          return Promise.resolve(opts.settlementsByTarget ?? []);
        }),
      },
      cashFlowEntry: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    return p;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConciliacaoService, { provide: PrismaService, useValue: {} }],
    }).compile();
    service = module.get(ConciliacaoService);
  });

  describe('settleTargetParcela', () => {
    it('liquida parcela 1/3 com valor real, mantendo 2 abertas no planejado', async () => {
      prisma = buildPrisma({
        target: makeTarget(),
        source: makeSource(),
        settlementsByTarget: [{ parcelaIndex: 0, realValor: 11000 }],
      });

      await service.settleTargetParcela(prisma, {
        tenantId: 't1',
        sourceExpenseId: 'src',
        targetExpenseId: 'tgt',
        parcelaIndex: 0,
        realValor: 11000,
      });

      // 1) snapshot do planejado guardado na criação
      const upsertArg = prisma.crossProjectSettlement.upsert.mock.calls[0][0];
      expect(upsertArg.create.plannedValor).toBe(10000);
      expect(upsertArg.create.plannedStatus).toBe('PLANEJADO');
      expect(upsertArg.create.realValor).toBe(11000);
      expect(upsertArg.create.parcelaIndex).toBe(0);

      // 2) alvo: parcela 0 marcada paga, ainda PLANEJADO (2 abertas)
      const targetUpdate = prisma.expense.update.mock.calls.find((c: any[]) => c[0].where.id === 'tgt');
      expect(targetUpdate[0].data.paidParcelas).toBe('[0]');
      expect(targetUpdate[0].data.status).toBe('PLANEJADO');

      // 3) fonte vira espelho do alvo (dedupe)
      const sourceUpdate = prisma.expense.update.mock.calls.find((c: any[]) => c[0].where.id === 'src');
      expect(sourceUpdate[0].data.linkedExpenseId).toBe('tgt');

      // 4) cashflow regenerado: 1/3 real PAGO, 2/3 e 3/3 planejado PLANEJADO
      const entries = prisma.cashFlowEntry.createMany.mock.calls[0][0].data;
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({ parcela: '1/3', valor: 11000, status: 'PAGO' });
      expect(entries[1]).toMatchObject({ parcela: '2/3', valor: 10000, status: 'PLANEJADO' });
      expect(entries[2]).toMatchObject({ parcela: '3/3', valor: 10000, status: 'PLANEJADO' });
    });

    it('liquidar todas as parcelas fecha o alvo (status PAGO, paidParcelas null)', async () => {
      prisma = buildPrisma({
        target: makeTarget({ paidParcelas: '[0,1]' }),
        source: makeSource(),
        settlementsByTarget: [
          { parcelaIndex: 0, realValor: 10000 },
          { parcelaIndex: 1, realValor: 10000 },
          { parcelaIndex: 2, realValor: 10000 },
        ],
      });

      await service.settleTargetParcela(prisma, {
        tenantId: 't1',
        sourceExpenseId: 'src',
        targetExpenseId: 'tgt',
        parcelaIndex: 2,
        realValor: 10000,
      });

      const targetUpdate = prisma.expense.update.mock.calls.find((c: any[]) => c[0].where.id === 'tgt');
      expect(targetUpdate[0].data.status).toBe('PAGO');
      expect(targetUpdate[0].data.paidParcelas).toBeNull();
    });

    it('rejeita alvo no mesmo projeto da fonte', async () => {
      prisma = buildPrisma({
        target: makeTarget({ projectId: 'pessoal1' }),
        source: makeSource({ projectId: 'pessoal1' }),
      });
      await expect(
        service.settleTargetParcela(prisma, {
          tenantId: 't1',
          sourceExpenseId: 'src',
          targetExpenseId: 'tgt',
          parcelaIndex: 0,
          realValor: 11000,
        }),
      ).rejects.toThrow('outro projeto');
    });
  });

  describe('unsettleBySource', () => {
    it('restaura o planejado do alvo e limpa o vínculo da fonte', async () => {
      prisma = buildPrisma({
        target: makeTarget({ paidParcelas: '[0]' }),
        source: makeSource({ linkedExpenseId: 'tgt' }),
        sourceRows: [{ targetExpenseId: 'tgt', parcelaIndex: 0, plannedStatus: 'PLANEJADO', realValor: 11000 }],
        settlementsByTarget: [], // após delete, regen não vê overrides → planejado restaurado
      });

      const res = await service.unsettleBySource(prisma, { tenantId: 't1', sourceExpenseId: 'src' });
      expect(res.targets).toEqual(['tgt']);

      // alvo volta a totalmente planejado
      const targetUpdate = prisma.expense.update.mock.calls.find((c: any[]) => c[0].where.id === 'tgt');
      expect(targetUpdate[0].data.status).toBe('PLANEJADO');
      expect(targetUpdate[0].data.paidParcelas).toBeNull();

      // linhas de liquidação removidas
      expect(prisma.crossProjectSettlement.deleteMany).toHaveBeenCalledWith({
        where: { targetExpenseId: 'tgt', sourceExpenseId: 'src' },
      });

      // fonte desvinculada
      const sourceUpdate = prisma.expense.update.mock.calls.find((c: any[]) => c[0].where.id === 'src');
      expect(sourceUpdate[0].data.linkedExpenseId).toBeNull();

      // cashflow regenerado com valores planejados (sem override real)
      const entries = prisma.cashFlowEntry.createMany.mock.calls[0][0].data;
      expect(entries.every((e: any) => e.valor === 10000 && e.status === 'PLANEJADO')).toBe(true);
    });
  });
});
