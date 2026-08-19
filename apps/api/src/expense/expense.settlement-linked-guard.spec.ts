import { TEST_OWNER_REQUESTER } from '../test-utils/acl-requester-test-helper';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { withAclRequester } from '../test-utils/acl-requester-test-helper';

const tenantId = 'tenant-1';
const projectId = 'pessoal-1';
const sourceId = 'cmr9mq9l50001cuy6mhhex5nv';

const sourceRow = {
  id: sourceId, projectId, tenantId, deletedAt: null,
  valorTotal: 11_000, linkedExpenseId: 'tgt-settlement',
  formaPagamento: 'A_VISTA', quantidadeParcela: null, status: 'PAGO',
};
const makePrismaMock = (settlementCount: number) => ({
  project: { findFirst: jest.fn().mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL' }) },
  expense: {
    findFirst: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === sourceId ? sourceRow : { id: where.id, projectId: 'obra-1', tenantId, deletedAt: null },
    ),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ id: sourceId }),
    updateMany: jest.fn(),
    findUnique: jest.fn().mockResolvedValue(null),
  },
  rateioAllocation: {
    count: jest.fn().mockResolvedValue(0),
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
  },
  crossProjectSettlement: {
    count: jest.fn().mockResolvedValue(settlementCount),
    findMany: jest.fn().mockResolvedValue(
      settlementCount > 0
        ? [{ tenantId, sourceExpenseId: sourceId, targetExpenseId: 'tgt-settlement' }]
        : [],
    ),
  },
  creditCard: { findFirst: jest.fn().mockResolvedValue(null) },
  bankAccount: { findFirst: jest.fn().mockResolvedValue(null) },
  cashFlowEntry: { updateMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(async (cb: any) => (typeof cb === 'function' ? cb : Promise.all(cb))),
});

async function build(settlementCount: number) {
  const prisma = makePrismaMock(settlementCount);
  const module: TestingModule = await Test.createTestingModule({
    providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return { service: withAclRequester(module.get(ExpenseService), prisma), prisma };
}

describe('Guarda de participação em CrossProjectSettlement (conciliação por parcela)', () => {
  it('PATCH com linkedExpenseId=null numa fonte COM settlement ativo é rejeitado e não escreve nada', async () => {
    const { service, prisma } = await build(1);
    await expect(
      service.update(tenantId, projectId, sourceId, { linkedExpenseId: null } as any, TEST_OWNER_REQUESTER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it('DELETE /:id/link numa fonte COM settlement ativo é rejeitado e não escreve nada', async () => {
    const { service, prisma } = await build(1);
    await expect(
      service.unlinkCrossProject(tenantId, projectId, sourceId, TEST_OWNER_REQUESTER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it('fronteira 0 settlements: desvincular continua permitido (guarda não vaza)', async () => {
    const { service, prisma } = await build(0);
    await service.unlinkCrossProject(tenantId, projectId, sourceId, TEST_OWNER_REQUESTER);
    expect(prisma.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { linkedExpenseId: null } }),
    );
  });

  it('fronteira 1 settlement já bloqueia (guarda é > 0, não > 1)', async () => {
    const { service } = await build(1);
    await expect(
      service.unlinkCrossProject(tenantId, projectId, sourceId, TEST_OWNER_REQUESTER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('editar uma fonte com settlement ativo SEM tocar no vínculo (metadados) continua funcionando', async () => {
    const { service, prisma } = await build(1);
    await service.update(tenantId, projectId, sourceId, { titulo: 'Fatura Itaú maio' } as any, TEST_OWNER_REQUESTER);
    expect(prisma.expense.update).toHaveBeenCalledTimes(1);
  });

  it('outros metadados (fornecedor/roomId/categoriaMaoDeObra/dataCompra) permanecem permitidos numa fonte com settlement ativo', async () => {
    const { service, prisma } = await build(1);
    await service.update(tenantId, projectId, sourceId, {
      fornecedor: 'Leroy Merlin',
      roomId: 'room-2',
      categoriaMaoDeObra: 'EMPREITEIRO',
      dataCompra: '2026-05-05',
    } as any, TEST_OWNER_REQUESTER);
    expect(prisma.expense.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['valor', { valor: 999 }],
    ['quantidade', { quantidade: 2 }],
    ['formaPagamento', { formaPagamento: 'PARCELADO' }],
    ['status', { status: 'PLANEJADO' }],
  ])('rejeita mudança efetiva de %s numa fonte com settlement ativo', async (_label, dto) => {
    const { service, prisma } = await build(1);
    await expect(
      service.update(tenantId, projectId, sourceId, dto as any, TEST_OWNER_REQUESTER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it('reapontar o vínculo para outro alvo também é bloqueado numa fonte com settlement ativo', async () => {
    const { service, prisma } = await build(1);
    await expect(
      service.update(tenantId, projectId, sourceId, { linkedExpenseId: 'outro-alvo' } as any, TEST_OWNER_REQUESTER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it('linkCrossProject reapontando para outro alvo numa fonte com settlement ativo é bloqueado e não escreve nada', async () => {
    const { service, prisma } = await build(1);
    // fixture: source.linkedExpenseId = 'tgt-settlement' — 'outro-alvo' é uma mudança real
    await expect(
      service.linkCrossProject(tenantId, projectId, sourceId, 'outro-alvo', TEST_OWNER_REQUESTER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it('linkCrossProject idempotente (mesmo alvo já vinculado) numa fonte com settlement ativo é permitido', async () => {
    const { service, prisma } = await build(1);
    await service.linkCrossProject(tenantId, projectId, sourceId, 'tgt-settlement', TEST_OWNER_REQUESTER);
    expect(prisma.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { linkedExpenseId: 'tgt-settlement' } }),
    );
  });

  it('tenant-scoped: a guarda consulta crossProjectSettlement filtrando pelo tenantId do requester', async () => {
    const { service, prisma } = await build(0);
    await service.update(tenantId, projectId, sourceId, {
      linkedExpenseId: 'tgt-settlement',
      titulo: 'Fatura Itaú maio',
    } as any, TEST_OWNER_REQUESTER);
    expect(prisma.expense.update).toHaveBeenCalledTimes(1);
    expect(prisma.crossProjectSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId }) }),
    );
  });
});
