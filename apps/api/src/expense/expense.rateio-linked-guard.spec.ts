import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';

const tenantId = 'tenant-1';
const projectId = 'pessoal-1';
const sourceId = 'cmr9mq9l50001cuy6mhhex5nu';

const makePrismaMock = (rateioCount: number) => ({
  project: { findFirst: jest.fn().mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL' }) },
  expense: {
    findFirst: jest.fn().mockResolvedValue({
      id: sourceId, projectId, tenantId, deletedAt: null,
      valorTotal: 1_277_100, linkedExpenseId: 'tgt-b',
      formaPagamento: 'PARCELADO', quantidadeParcela: 10, status: 'PAGO',
    }),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ id: sourceId }),
    updateMany: jest.fn(),
    findUnique: jest.fn().mockResolvedValue(null),
  },
  rateioAllocation: { count: jest.fn().mockResolvedValue(rateioCount), findUnique: jest.fn().mockResolvedValue(null) },
  crossProjectSettlement: { count: jest.fn().mockResolvedValue(0) },
  creditCard: { findFirst: jest.fn().mockResolvedValue(null) },
  bankAccount: { findFirst: jest.fn().mockResolvedValue(null) },
  cashFlowEntry: { updateMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(async (cb: any) => (typeof cb === 'function' ? cb : Promise.all(cb))),
});

async function build(rateioCount: number) {
  const prisma = makePrismaMock(rateioCount);
  const module: TestingModule = await Test.createTestingModule({
    providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return { service: module.get(ExpenseService), prisma };
}

describe('I1 — fonte rateada não pode perder o espelho (linkedExpenseId)', () => {
  it('PATCH com linkedExpenseId=null numa fonte COM rateio é rejeitado e não escreve nada', async () => {
    const { service, prisma } = await build(9);
    await expect(
      service.update(tenantId, projectId, sourceId, { linkedExpenseId: null } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.update).not.toHaveBeenCalled();  // dupla contagem de R$ 12.771 evitada
  });

  it('DELETE /:id/link numa fonte COM rateio é rejeitado e não escreve nada', async () => {
    const { service, prisma } = await build(9);
    await expect(
      service.unlinkCrossProject(tenantId, projectId, sourceId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it('fronteira 0 alocações: desvincular continua permitido (guarda não vaza)', async () => {
    const { service, prisma } = await build(0);
    await service.unlinkCrossProject(tenantId, projectId, sourceId);
    expect(prisma.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { linkedExpenseId: null } }),
    );
  });

  it('fronteira 1 alocação já bloqueia (guarda é > 0, não > 1)', async () => {
    const { service } = await build(1);
    await expect(
      service.unlinkCrossProject(tenantId, projectId, sourceId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('editar uma fonte rateada SEM tocar no vínculo continua funcionando', async () => {
    // Mutação clássica: guardar em `dto.linkedExpenseId !== undefined` vs `=== null`.
    // Se a guarda disparar com `undefined`, toda edição de compra rateada quebra.
    const { service, prisma } = await build(9);
    await service.update(tenantId, projectId, sourceId, { titulo: 'Compras TelhaNorte' } as any);
    expect(prisma.expense.update).toHaveBeenCalledTimes(1);
  });

  it('reapontar o vínculo para outro alvo também é bloqueado numa fonte rateada', async () => {
    const { service, prisma } = await build(9);
    await expect(
      service.update(tenantId, projectId, sourceId, { linkedExpenseId: 'outro-alvo' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });
});
