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
        findUnique: jest.fn().mockResolvedValue(null),
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
      rateioAllocation: {
        count: jest.fn().mockResolvedValue(0),
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

  describe('rateio (ratearSource / unratearSource)', () => {
    function buildRateioPrisma(opts: {
      source: any;
      targets: Record<string, any>;
      allocations?: any[]; // linhas pré-existentes de rateio_allocations
    }) {
      const allocStore = new Map<string, any>();
      for (const a of opts.allocations ?? []) allocStore.set(a.targetExpenseId, { ...a });
      const p: any = {
        expense: {
          findFirst: jest.fn().mockImplementation(({ where }: any) => {
            if (where.id === opts.source.id) return Promise.resolve(opts.source);
            if (opts.targets[where.id]) return Promise.resolve(opts.targets[where.id]);
            return Promise.resolve(null);
          }),
          update: jest.fn().mockImplementation(({ where, data }: any) => {
            if (where.id === opts.source.id) Object.assign(opts.source, data);
            else if (opts.targets[where.id]) Object.assign(opts.targets[where.id], data);
            return Promise.resolve({});
          }),
        },
        crossProjectSettlement: {
          count: jest.fn().mockResolvedValue(0),
          findMany: jest.fn().mockResolvedValue([]),
        },
        rateioAllocation: {
          findUnique: jest.fn().mockImplementation(({ where }: any) =>
            Promise.resolve(allocStore.get(where.targetExpenseId) ?? null),
          ),
          findMany: jest.fn().mockImplementation(({ where }: any) =>
            Promise.resolve(
              Array.from(allocStore.values()).filter((a) => a.sourceExpenseId === where.sourceExpenseId),
            ),
          ),
          upsert: jest.fn().mockImplementation(({ where, create, update }: any) => {
            const cur = allocStore.get(where.targetExpenseId);
            if (cur) Object.assign(cur, update);
            else allocStore.set(where.targetExpenseId, { ...create });
            return Promise.resolve({});
          }),
          delete: jest.fn().mockImplementation(({ where }: any) => {
            allocStore.delete(where.targetExpenseId);
            return Promise.resolve({});
          }),
        },
        cashFlowEntry: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        _allocStore: allocStore,
      };
      return p;
    }

    const sourceParcelado = (over: any = {}) => ({
      id: 'src',
      tenantId: 't1',
      projectId: 'pessoal1',
      valorTotal: 30000,
      formaPagamento: 'PARCELADO',
      dataPagamento: null,
      quantidadeParcela: 3,
      dataInicioParcela: new Date('2026-04-29'),
      status: 'PLANEJADO',
      paidParcelas: null,
      linkedExpenseId: null,
      ...over,
    });

    it('gera as parcelas do alvo a partir do cronograma da fonte (10k em 3x = 3x 10k)', async () => {
      const prisma = buildRateioPrisma({
        source: sourceParcelado(),
        targets: {
          tgt: makeTarget({ id: 'tgt', formaPagamento: 'A_VISTA', valorTotal: 25000, quantidadeParcela: null }),
        },
      });

      const res = await service.ratearSource(prisma, {
        tenantId: 't1',
        sourceExpenseId: 'src',
        allocations: [{ targetExpenseId: 'tgt', allocation: 30000 }],
      });
      expect(res.targets).toEqual(['tgt']);

      // snapshot do planejado guardado
      const createArg = prisma.rateioAllocation.upsert.mock.calls[0][0].create;
      expect(createArg).toMatchObject({ allocation: 30000, plannedStatus: 'PLANEJADO', sourceExpenseId: 'src' });

      // caixa do alvo = cronograma da FONTE (3x 10000), categoria do ALVO
      const entries = prisma.cashFlowEntry.createMany.mock.calls.at(-1)![0].data;
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({ parcela: '1/3', valor: 10000, status: 'PLANEJADO', categoria: 'Metal & Cerâmica' });
      expect(entries[1]).toMatchObject({ parcela: '2/3', valor: 10000 });
      expect(entries[2]).toMatchObject({ parcela: '3/3', valor: 10000 });
      // datas seguem a fonte
      expect((entries[0].data as Date).toISOString().slice(0, 10)).toBe('2026-04-29');
      expect((entries[1].data as Date).toISOString().slice(0, 10)).toBe('2026-05-29');

      // fonte vira espelho
      expect(opts_src_linked(prisma)).toBe('tgt');

      // NOVO: o REGISTRO do alvo passa a refletir o cronograma da fonte
      // (Parcelado 3x, valorTotal = alocação), e o snapshot guarda o original.
      const tgtUpd = prisma.expense.update.mock.calls
        .map((c: any[]) => c[0])
        .filter((c: any) => c.where.id === 'tgt')
        .at(-1)!;
      expect(tgtUpd.data).toMatchObject({
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 3,
        valorTotal: 30000,
        valor: 30000,
        quantidade: 1,
      });
      expect(createArg).toMatchObject({
        plannedForma: 'A_VISTA',
        plannedValorTotal: 25000,
      });
    });

    it('overwrite→restore: alvo reflete o cronograma da fonte e volta ao original no desfazer', async () => {
      const prisma = buildRateioPrisma({
        source: sourceParcelado({ linkedExpenseId: 'tgt', quantidadeParcela: 10, valorTotal: 100000 }),
        targets: {
          tgt: makeTarget({
            id: 'tgt',
            formaPagamento: 'A_VISTA',
            valorTotal: 25000,
            valor: 25000,
            quantidade: 1,
            quantidadeParcela: null,
            dataInicioParcela: null,
            dataPagamento: new Date('2026-03-01'),
          }),
        },
      });

      await service.ratearSource(prisma, {
        tenantId: 't1',
        sourceExpenseId: 'src',
        allocations: [{ targetExpenseId: 'tgt', allocation: 100000 }],
      });

      // após ratear: alvo = Parcelado 10x, valorTotal = alocação
      expect(prisma._allocStore.get('tgt')).toMatchObject({
        plannedForma: 'A_VISTA',
        plannedValorTotal: 25000,
        plannedDataPagamento: new Date('2026-03-01'),
      });

      // desfaz: restaura o original (A_VISTA, 25000, dataPagamento)
      await service.unratearSource(prisma, { tenantId: 't1', sourceExpenseId: 'src' });
      const restore = prisma.expense.update.mock.calls
        .map((c: any[]) => c[0])
        .filter((c: any) => c.where.id === 'tgt')
        .at(-1)!;
      expect(restore.data).toMatchObject({
        formaPagamento: 'A_VISTA',
        valorTotal: 25000,
        valor: 25000,
        quantidadeParcela: null,
      });
    });

    function opts_src_linked(prisma: any): string | null {
      return prisma._allocStore.size >= 0 ? prisma.expense.update.mock.calls
        .map((c: any[]) => c[0])
        .filter((c: any) => c.where.id === 'src')
        .map((c: any) => c.data.linkedExpenseId)
        .at(-1) ?? null : null;
    }

    it('rateia em 2 planejadas e cada parcela soma o total da fonte', async () => {
      const prisma = buildRateioPrisma({
        source: sourceParcelado({ valorTotal: 100000, quantidadeParcela: 10, status: 'PAGO' }),
        targets: {
          pisos: makeTarget({ id: 'pisos', formaPagamento: 'A_VISTA', valorTotal: 30000, quantidadeParcela: null }),
          louca: makeTarget({ id: 'louca', formaPagamento: 'A_VISTA', valorTotal: 70000, quantidadeParcela: null }),
        },
      });

      await service.ratearSource(prisma, {
        tenantId: 't1',
        sourceExpenseId: 'src',
        allocations: [
          { targetExpenseId: 'pisos', allocation: 32000 },
          { targetExpenseId: 'louca', allocation: 68000 },
        ],
      });

      const calls = prisma.cashFlowEntry.createMany.mock.calls;
      const pisosEntries = calls.find((c: any[]) => c[0].data[0].expenseId === 'pisos')![0].data;
      const loucaEntries = calls.find((c: any[]) => c[0].data[0].expenseId === 'louca')![0].data;
      expect(pisosEntries).toHaveLength(10);
      expect(pisosEntries[0]).toMatchObject({ valor: 3200, status: 'PAGO' }); // fonte PAGO → parcelas pagas
      expect(loucaEntries[0]).toMatchObject({ valor: 6800, status: 'PAGO' });
      // soma da 1ª parcela entre alvos = 1ª parcela da fonte (10000)
      expect(pisosEntries[0].valor + loucaEntries[0].valor).toBe(10000);
    });

    it('rejeita quando a soma das alocações não fecha o total da compra', async () => {
      const prisma = buildRateioPrisma({
        source: sourceParcelado(),
        targets: { tgt: makeTarget({ id: 'tgt' }) },
      });
      await expect(
        service.ratearSource(prisma, {
          tenantId: 't1',
          sourceExpenseId: 'src',
          allocations: [{ targetExpenseId: 'tgt', allocation: 20000 }],
        }),
      ).rejects.toThrow('fechar o total');
    });

    it('rejeita rateio em planejada do MESMO projeto da fonte', async () => {      const prisma = buildRateioPrisma({
        source: sourceParcelado(),
        targets: { tgt: makeTarget({ id: 'tgt', projectId: 'pessoal1' }) },
      });
      await expect(
        service.ratearSource(prisma, {
          tenantId: 't1',
          sourceExpenseId: 'src',
          allocations: [{ targetExpenseId: 'tgt', allocation: 30000 }],
        }),
      ).rejects.toThrow('OUTRO projeto');
    });

    it('mantém o espelho da fonte mesmo quando ela já aponta para o mesmo alvo (re-rateio)', async () => {
      const prisma = buildRateioPrisma({
        source: sourceParcelado({ linkedExpenseId: 'tgt' }),
        targets: {
          tgt: makeTarget({ id: 'tgt', formaPagamento: 'A_VISTA', valorTotal: 25000, quantidadeParcela: null }),
        },
      });

      await service.ratearSource(prisma, {
        tenantId: 't1',
        sourceExpenseId: 'src',
        allocations: [{ targetExpenseId: 'tgt', allocation: 30000 }],
      });

      // update do espelho deve ser emitido incondicionalmente
      const srcLink = prisma.expense.update.mock.calls
        .map((c: any[]) => c[0])
        .filter((c: any) => c.where.id === 'src');
      expect(srcLink.some((c: any) => c.data.linkedExpenseId === 'tgt')).toBe(true);
    });

    it('desfaz o rateio: restaura planejado do alvo e limpa o espelho', async () => {
      const prisma = buildRateioPrisma({
        source: sourceParcelado({ linkedExpenseId: 'tgt' }),
        targets: {
          tgt: makeTarget({ id: 'tgt', formaPagamento: 'A_VISTA', valorTotal: 25000, quantidadeParcela: null, status: 'PAGO', paidParcelas: null }),
        },
        allocations: [
          { targetExpenseId: 'tgt', sourceExpenseId: 'src', tenantId: 't1', allocation: 30000, plannedStatus: 'PLANEJADO', plannedPaid: null },
        ],
      });

      const res = await service.unratearSource(prisma, { tenantId: 't1', sourceExpenseId: 'src' });
      expect(res.targets).toEqual(['tgt']);

      // alvo restaurado ao planejado
      const tgtUpd = prisma.expense.update.mock.calls.find((c: any[]) => c[0].where.id === 'tgt');
      expect(tgtUpd[0].data.status).toBe('PLANEJADO');
      // allocation removida
      expect(prisma.rateioAllocation.delete).toHaveBeenCalled();
      // espelho limpo
      const srcUpd = prisma.expense.update.mock.calls.filter((c: any[]) => c[0].where.id === 'src').at(-1);
      expect(srcUpd[0].data.linkedExpenseId).toBeNull();
      // caixa planejado do alvo (A_VISTA → 1 parcela de 25000)
      const entries = prisma.cashFlowEntry.createMany.mock.calls.at(-1)![0].data;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ valor: 25000, status: 'PLANEJADO' });
    });
  });
});
