import { Test, TestingModule } from '@nestjs/testing';
import { ConciliacaoService } from './conciliacao.service';
import { PrismaService } from '../prisma/prisma.service';

function makeTarget(over: Partial<any> = {}) {
  return {
    id: 'tgt', tenantId: 't1', projectId: 'reforma1', tipoDespesa: 'METAL_CERAMICA',
    categoriaMaoDeObra: null, roomId: null, valorTotal: 30000, formaPagamento: 'PARCELADO',
    dataPagamento: null, quantidadeParcela: 3, dataInicioParcela: new Date('2026-04-29'),
    status: 'PLANEJADO', paidParcelas: null, linkedExpenseId: null, deletedAt: null, room: null, ...over,
  };
}
// Mirror = espelho (source). valorTotal é o valor REAL pago da parcela.
function makeMirror(id: string, over: Partial<any> = {}) {
  return {
    id, tenantId: 't1', projectId: 'pessoal1', valorTotal: 11000,
    cardLast4: '1234', bankLast4: null, linkedExpenseId: null, deletedAt: null,
    formaPagamento: 'A_VISTA', quantidadeParcela: null, dataInicioParcela: null,
    dataPagamento: new Date('2026-05-10'), status: 'PAGO', tipoDespesa: 'OUTROS', ...over,
  };
}

describe('ConciliacaoService — hardening cross-parcela', () => {
  let service: ConciliacaoService;

  // Harness com STORE de settlements para exercitar idempotência entre chamadas.
  function buildPrisma(opts: { target: any; mirrors: Record<string, any>; rateioCount?: number; rateioTargetCount?: number }) {
    const settlementStore = new Map<string, any>(); // key: `${targetId}|${parcelaIndex}`
    const p: any = {
      expense: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where.id === opts.target.id) return Promise.resolve(opts.target.deletedAt ? null : opts.target);
          const m = opts.mirrors[where.id];
          return Promise.resolve(m && !m.deletedAt ? m : m ?? null);
        }),
        update: jest.fn().mockImplementation(({ where, data }: any) => {
          if (where.id === opts.target.id) Object.assign(opts.target, data);
          else if (opts.mirrors[where.id]) Object.assign(opts.mirrors[where.id], data);
          return Promise.resolve({});
        }),
      },
      crossProjectSettlement: {
        findUnique: jest.fn().mockImplementation(({ where }: any) => {
          const k = `${where.targetExpenseId_parcelaIndex.targetExpenseId}|${where.targetExpenseId_parcelaIndex.parcelaIndex}`;
          return Promise.resolve(settlementStore.get(k) ?? null);
        }),
        upsert: jest.fn().mockImplementation(({ where, create, update }: any) => {
          const k = `${where.targetExpenseId_parcelaIndex.targetExpenseId}|${where.targetExpenseId_parcelaIndex.parcelaIndex}`;
          const cur = settlementStore.get(k);
          if (cur) Object.assign(cur, update); else settlementStore.set(k, { ...create });
          return Promise.resolve({});
        }),
        findMany: jest.fn().mockImplementation(() =>
          Promise.resolve(Array.from(settlementStore.values()))),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      rateioAllocation: {
        count: jest.fn().mockImplementation(({ where }: any) => {
          if (where?.sourceExpenseId) return Promise.resolve(opts.rateioCount ?? 0);
          if (where?.targetExpenseId) return Promise.resolve(opts.rateioTargetCount ?? 0);
          return Promise.resolve(0);
        }),
      },
      cashFlowEntry: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      _settlements: settlementStore,
    };
    return p;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConciliacaoService, { provide: PrismaService, useValue: {} }],
    }).compile();
    service = module.get(ConciliacaoService);
  });

  it('P1/P2: 2ª quitação da MESMA parcela com outra source desativa o espelho antigo (1 ativo)', async () => {
    const prisma = buildPrisma({
      target: makeTarget(),
      mirrors: { mA: makeMirror('mA'), mB: makeMirror('mB') },
    });
    await service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mA', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 });
    await service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mB', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 });

    // Espelho antigo (mA) foi desativado: soft-delete + link limpo → não conta mais no caixa.
    expect(opts_mA_deleted(prisma)).toBe(true);
    expect(prisma.mirrors ?? true).toBeTruthy();
    const mAUpdates = prisma.expense.update.mock.calls.map((c: any[]) => c[0]).filter((c: any) => c.where.id === 'mA');
    expect(mAUpdates.some((c: any) => c.data.deletedAt != null)).toBe(true);
    expect(mAUpdates.some((c: any) => c.data.linkedExpenseId === null)).toBe(true);

    // Settlement aponta p/ mB e só há 1 espelho ativo (mB).
    const rows: any[] = Array.from(prisma._settlements.values());
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceExpenseId).toBe('mB');
    const mBUpdates = prisma.expense.update.mock.calls.map((c: any[]) => c[0]).filter((c: any) => c.where.id === 'mB');
    expect(mBUpdates.some((c: any) => c.data.linkedExpenseId === 'tgt')).toBe(true);
  });

  function opts_mA_deleted(prisma: any): boolean {
    return prisma.expense.update.mock.calls
      .map((c: any[]) => c[0]).some((c: any) => c.where.id === 'mA' && c.data.deletedAt != null);
  }

  it('P1/P2: duplo clique com a MESMA source é idempotente (0 novos espelhos, só update realValor)', async () => {
    const prisma = buildPrisma({ target: makeTarget(), mirrors: { mA: makeMirror('mA') } });
    await service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mA', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 });
    await service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mA', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 });

    // Nenhum espelho soft-deletado; 1 settlement.
    const deletes = prisma.expense.update.mock.calls.map((c: any[]) => c[0]).filter((c: any) => c.data.deletedAt != null);
    expect(deletes).toHaveLength(0);
    expect(Array.from(prisma._settlements.values())).toHaveLength(1);
  });

  it('P5: rejeita target NEUTRO', async () => {
    const prisma = buildPrisma({ target: makeTarget({ tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' }), mirrors: { mA: makeMirror('mA') } });
    await expect(
      service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mA', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 }),
    ).rejects.toThrow(/neutr/i);
  });

  it('E5: rejeita quando a source já está rateada (mutex rateio×settle)', async () => {
    const prisma = buildPrisma({ target: makeTarget(), mirrors: { mA: makeMirror('mA') }, rateioCount: 1 });
    await expect(
      service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mA', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 }),
    ).rejects.toThrow(/rate/i);
  });

  it('E5 (simétrico): rejeita quando o ALVO já é destino de rateio', async () => {
    const prisma = buildPrisma({ target: makeTarget(), mirrors: { mA: makeMirror('mA') }, rateioTargetCount: 1 });
    await expect(
      service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mA', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 }),
    ).rejects.toThrow(/rate/i);
  });

  it('P5 (fonte): rejeita espelho NEUTRO (não contaria no caixa → money-vanish)', async () => {
    const prisma = buildPrisma({ target: makeTarget(), mirrors: { mA: makeMirror('mA', { tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' }) } });
    await expect(
      service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mA', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 }),
    ).rejects.toThrow(/neutr/i);
  });

  it('Issue 2: re-settle soft-deleta o cashFlowEntry do espelho órfão (sem entrada órfã)', async () => {
    const prisma = buildPrisma({
      target: makeTarget(),
      mirrors: { mA: makeMirror('mA'), mB: makeMirror('mB') },
    });
    await service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mA', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 });
    await service.settleTargetParcela(prisma, { tenantId: 't1', sourceExpenseId: 'mB', targetExpenseId: 'tgt', parcelaIndex: 0, realValor: 11000 });

    // O cashFlowEntry do espelho antigo (mA) foi soft-deletado junto do expense.
    const entryCleanups = prisma.cashFlowEntry.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .filter((c: any) => c.where.expenseId === 'mA' && c.data.deletedAt != null);
    expect(entryCleanups.length).toBeGreaterThan(0);
  });

  it('P6: desconciliar SOFT-DELETA o espelho (Σ espelhos == Σ parcelas quitadas = 0)', async () => {
    const prisma = buildPrisma({ target: makeTarget({ paidParcelas: '[0]' }), mirrors: { mA: makeMirror('mA', { linkedExpenseId: 'tgt' }) } });
    prisma._settlements.set('tgt|0', { targetExpenseId: 'tgt', sourceExpenseId: 'mA', parcelaIndex: 0, plannedStatus: 'PLANEJADO', realValor: 11000, tenantId: 't1' });
    // findMany por sourceExpenseId usado por unsettleBySource
    prisma.crossProjectSettlement.findMany = jest.fn().mockResolvedValue([
      { targetExpenseId: 'tgt', sourceExpenseId: 'mA', parcelaIndex: 0, plannedStatus: 'PLANEJADO', realValor: 11000 },
    ]);

    await service.unsettleBySource(prisma, { tenantId: 't1', sourceExpenseId: 'mA' });

    const mAUpdates = prisma.expense.update.mock.calls.map((c: any[]) => c[0]).filter((c: any) => c.where.id === 'mA');
    expect(mAUpdates.some((c: any) => c.data.deletedAt != null)).toBe(true);   // espelho apagado
    expect(mAUpdates.some((c: any) => c.data.linkedExpenseId === null)).toBe(true);
    // Issue 2: cashFlowEntry do espelho também soft-deletado (sem órfã).
    expect(
      prisma.cashFlowEntry.updateMany.mock.calls
        .map((c: any[]) => c[0])
        .some((c: any) => c.where.expenseId === 'mA' && c.data.deletedAt != null),
    ).toBe(true);
    // target restaurado ao planejado
    const tgtUpd = prisma.expense.update.mock.calls.map((c: any[]) => c[0]).filter((c: any) => c.where.id === 'tgt').at(-1);
    expect(tgtUpd.data.status).toBe('PLANEJADO');
    expect(tgtUpd.data.paidParcelas).toBeNull();
  });
});
