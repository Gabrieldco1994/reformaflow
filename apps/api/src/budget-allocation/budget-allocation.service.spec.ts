import { Test, TestingModule } from '@nestjs/testing';
import { BudgetAllocationService } from './budget-allocation.service';
import { PrismaService } from '../prisma/prisma.service';

type AnyFn = jest.Mock;

interface PrismaMock {
  project: { findFirst: AnyFn };
  receipt: { findMany: AnyFn };
  budgetAllocation: { findMany: AnyFn };
  expense: { findMany: AnyFn };
}

const makePrismaMock = (): PrismaMock => ({
  project: { findFirst: jest.fn() },
  receipt: { findMany: jest.fn().mockResolvedValue([]) },
  budgetAllocation: { findMany: jest.fn().mockResolvedValue([]) },
  expense: { findMany: jest.fn().mockResolvedValue([]) },
});

describe('BudgetAllocationService.calculateAvailableBudget', () => {
  let service: BudgetAllocationService;
  let prisma: PrismaMock;
  const tenantId = 'tenant-1';
  const projectId = 'pessoal-1';

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [BudgetAllocationService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<BudgetAllocationService>(BudgetAllocationService);
  });

  it('desconta despesas pagas e planejadas (e alocações) do disponível', async () => {
    prisma.receipt.findMany.mockResolvedValue([{ valor: 1000000 }]); // R$ 10.000 em caixa
    prisma.budgetAllocation.findMany.mockResolvedValue([{ valor: 200000 }]); // R$ 2.000 alocados
    prisma.expense.findMany.mockResolvedValue([
      { valorTotal: 150000, tipoDespesa: 'MATERIAL_CONSTRUCAO' }, // R$ 1.500 (planejada/paga)
      { valorTotal: 50000, tipoDespesa: 'MAO_DE_OBRA' }, // R$ 500
    ]);

    const available = await service.calculateAvailableBudget(projectId, tenantId);

    // 10.000 - 2.000 - (1.500 + 500) = 6.000
    expect(available).toBe(600000);
  });

  it('ignora tipos de despesa neutros (transferência / pagto de fatura)', async () => {
    prisma.receipt.findMany.mockResolvedValue([{ valor: 500000 }]);
    prisma.expense.findMany.mockResolvedValue([
      { valorTotal: 100000, tipoDespesa: 'MOVIMENTACAO_INTERNA' },
      { valorTotal: 100000, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' },
    ]);

    const available = await service.calculateAvailableBudget(projectId, tenantId);

    // Despesas neutras não descontam → disponível = 5.000
    expect(available).toBe(500000);
  });

  it('nunca retorna valor negativo', async () => {
    prisma.receipt.findMany.mockResolvedValue([{ valor: 100000 }]);
    prisma.expense.findMany.mockResolvedValue([
      { valorTotal: 500000, tipoDespesa: 'MATERIAL_CONSTRUCAO' },
    ]);

    const available = await service.calculateAvailableBudget(projectId, tenantId);
    expect(available).toBe(0);
  });

  it('filtra despesas por settledByExpenseId/linkedExpenseId nulos (evita dupla contagem)', async () => {
    prisma.receipt.findMany.mockResolvedValue([{ valor: 1000000 }]);
    await service.calculateAvailableBudget(projectId, tenantId);

    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId,
          tenantId,
          deletedAt: null,
          settledByExpenseId: null,
          linkedExpenseId: null,
        }),
      }),
    );
  });
});
