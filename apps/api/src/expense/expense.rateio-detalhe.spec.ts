import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';

const tenantId = 'tenant-1';
const projectId = 'pessoal-1';
const sourceId = 'cmr9mq9l50001cuy6mhhex5nu'; // compra real: Compras TelhaNorte
const TOTAL = 1_277_100;                       // R$ 12.771,00 em centavos

// Datas FIXAS (nada de new Date()) — createdAt idêntico nos dois primeiros para
// provar que o desempate por targetExpenseId é o que garante a ordem.
const T0 = new Date('2026-01-10T12:00:00.000Z');
const T1 = new Date('2026-01-10T12:00:01.000Z');

const REFORMA = { id: 'reforma-1', name: 'Reforma Ap 62', type: 'REFORMA' };

const alloc = (over: Record<string, unknown> = {}) => ({
  tenantId,
  sourceExpenseId: sourceId,
  targetExpenseId: 'tgt-b',
  allocation: 500_000,
  plannedValorTotal: 620_000,
  createdAt: T0,
  target: {
    id: 'tgt-b',
    titulo: 'Porcelanato sala',
    fornecedor: 'TelhaNorte',
    status: 'PAGO',
    deletedAt: null,
    projectId: REFORMA.id,
    project: REFORMA,
  },
  ...over,
});

const makePrismaMock = () => ({
  project: { findFirst: jest.fn().mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL' }) },
  expense: {
    findFirst: jest.fn().mockResolvedValue({
      id: sourceId, projectId, tenantId, deletedAt: null, valorTotal: TOTAL,
    }),
    update: jest.fn(), updateMany: jest.fn(), create: jest.fn(),
  },
  rateioAllocation: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), update: jest.fn(),
  },
  cashFlowEntry: { updateMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(),
});

describe('ExpenseService.getRateio — leitura canônica do rateio (issue #423)', () => {
  let service: ExpenseService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ExpenseService);
  });

  it('enumera TODAS as alocações — não apenas o alvo apontado por linkedExpenseId', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([
      alloc({ targetExpenseId: 'tgt-b', allocation: 500_000, createdAt: T0,
              target: { ...alloc().target, id: 'tgt-b' } }),
      alloc({ targetExpenseId: 'tgt-a', allocation: 477_100, plannedValorTotal: null, createdAt: T0,
              target: { id: 'tgt-a', titulo: null, fornecedor: 'TelhaNorte', status: 'PLANEJADO',
                        deletedAt: null, projectId: REFORMA.id, project: REFORMA } }),
      alloc({ targetExpenseId: 'tgt-c', allocation: 300_000, createdAt: T1,
              target: { id: 'tgt-c', titulo: 'Rejunte', fornecedor: null, status: 'PAGO',
                        deletedAt: null, projectId: REFORMA.id, project: REFORMA } }),
    ]);

    const res = await service.getRateio(tenantId, projectId, sourceId);

    expect(res.rateado).toBe(true);
    expect(res.items).toHaveLength(3);                     // mutação: retornar só o 1º alvo
    expect(res.items.map((i) => i.targetExpenseId)).toEqual(['tgt-a', 'tgt-b', 'tgt-c']);
    expect(res.totalSourceCents).toBe(TOTAL);
    expect(res.rateadoCents).toBe(1_277_100);              // 500000+477100+300000 exato
    expect(res.sobraCents).toBe(0);
    expect(res.removedTargetsCount).toBe(0);
    expect(res.sourceExpenseId).toBe(sourceId);
  });

  it('preserva o contrato tipado de cada item (título cru, projeto, snapshot, status)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc()]);
    const [item] = (await service.getRateio(tenantId, projectId, sourceId)).items;
    expect(item).toEqual({
      targetExpenseId: 'tgt-b',
      titulo: 'Porcelanato sala',
      fornecedor: 'TelhaNorte',
      projectId: 'reforma-1',
      projectName: 'Reforma Ap 62',
      projectType: 'REFORMA',
      allocationCents: 500_000,
      plannedValorTotalCents: 620_000,
      status: 'PAGO',
    });
  });

  it('plannedValorTotal ausente (rateio legado) permanece null — nunca vira 0', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc({ plannedValorTotal: null })]);
    const [item] = (await service.getRateio(tenantId, projectId, sourceId)).items;
    expect(item.plannedValorTotalCents).toBeNull();        // mutação: `?? 0`
  });

  it('ordena de forma determinística com desempate TOTAL por targetExpenseId', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([]);
    await service.getRateio(tenantId, projectId, sourceId);
    expect(prisma.rateioAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { targetExpenseId: 'asc' }], // mutação: remover o desempate
      }),
    );
  });

  it('escopa por tenantId E sourceExpenseId na própria alocação (I5)', async () => {
    await service.getRateio(tenantId, projectId, sourceId);
    expect(prisma.rateioAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, sourceExpenseId: sourceId } }),
    );
  });

  it('exclui alvo soft-deletado dos itens, conta em removedTargetsCount e expõe a sobra', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([
      alloc({ targetExpenseId: 'tgt-a', allocation: 1_000_000, createdAt: T0,
              target: { id: 'tgt-a', titulo: 'Vivo', fornecedor: null, status: 'PAGO',
                        deletedAt: null, projectId: REFORMA.id, project: REFORMA } }),
      alloc({ targetExpenseId: 'tgt-z', allocation: 277_100, createdAt: T1,
              target: { id: 'tgt-z', titulo: 'Apagado', fornecedor: null, status: 'PAGO',
                        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
                        projectId: REFORMA.id, project: REFORMA } }),
    ]);

    const res = await service.getRateio(tenantId, projectId, sourceId);

    expect(res.items.map((i) => i.targetExpenseId)).toEqual(['tgt-a']); // I4: $use NÃO filtra o include
    expect(res.removedTargetsCount).toBe(1);
    expect(res.rateadoCents).toBe(1_000_000);
    expect(res.sobraCents).toBe(277_100);                  // divergência EXPOSTA, não absorvida
    expect(res.rateado).toBe(true);                        // ainda há alocação
  });

  it('N=0 alocações: rateado=false, lista vazia, sobra = total (fronteira)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([]);
    const res = await service.getRateio(tenantId, projectId, sourceId);
    expect(res).toEqual({
      sourceExpenseId: sourceId, rateado: false, totalSourceCents: TOTAL,
      rateadoCents: 0, sobraCents: TOTAL, removedTargetsCount: 0, items: [],
    });
  });

  it('N=1 alocação já é rateio (fronteira 0→1)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc({ allocation: TOTAL })]);
    const res = await service.getRateio(tenantId, projectId, sourceId);
    expect(res.rateado).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.sobraCents).toBe(0);
  });

  it('404 quando a fonte não pertence ao projeto/tenant, sem consultar alocações', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    await expect(service.getRateio(tenantId, projectId, sourceId)).rejects.toThrow(NotFoundException);
    expect(prisma.rateioAllocation.findMany).not.toHaveBeenCalled();
    expect(prisma.expense.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: sourceId, projectId, tenantId, deletedAt: null } }),
    );
  });

  it('é estritamente somente-leitura (I7): nenhuma escrita, nenhuma transação', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc()]);
    await service.getRateio(tenantId, projectId, sourceId);
    expect(prisma.expense.update).not.toHaveBeenCalled();
    expect(prisma.expense.updateMany).not.toHaveBeenCalled();
    expect(prisma.rateioAllocation.upsert).not.toHaveBeenCalled();
    expect(prisma.rateioAllocation.delete).not.toHaveBeenCalled();
    expect(prisma.rateioAllocation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.cashFlowEntry.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('faz UMA única query de alocações (snapshot atômico — sem leitura rasgada §3A)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc()]);
    await service.getRateio(tenantId, projectId, sourceId);
    expect(prisma.rateioAllocation.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.expense.findFirst).toHaveBeenCalledTimes(1); // só a fonte; alvos vêm no include
  });
});
