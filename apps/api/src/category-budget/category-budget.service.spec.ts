import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CategoryBudgetService } from './category-budget.service';
import { PrismaService } from '../prisma/prisma.service';

describe('CategoryBudgetService', () => {
  let service: CategoryBudgetService;
  let prisma: any;
  const tenantId = 'tenant-1';
  const projectId = 'project-1';

  beforeEach(async () => {
    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: projectId, type: 'PESSOAL' }),
      },
      categoryBudget: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      expense: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CategoryBudgetService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(CategoryBudgetService);
  });

  it('cria meta quando não existe e atualiza quando já existe para tenant/projeto/tipo/mês', async () => {
    prisma.categoryBudget.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'b1' });
    prisma.categoryBudget.create.mockResolvedValue({ id: 'b1', valorLimiteCents: 50000 });
    prisma.categoryBudget.update.mockResolvedValue({ id: 'b1', valorLimiteCents: 65000 });

    await service.upsert(tenantId, projectId, {
      tipoDespesa: 'ALIMENTACAO',
      mes: '2026-06',
      valorLimiteCents: 50000,
    });
    await service.upsert(tenantId, projectId, {
      tipoDespesa: 'ALIMENTACAO',
      mes: '2026-06',
      valorLimiteCents: 65000,
    });

    expect(prisma.categoryBudget.findFirst).toHaveBeenCalledWith({
      where: { tenantId, projectId, tipoDespesa: 'ALIMENTACAO', mes: '2026-06' },
    });
    expect(prisma.categoryBudget.create).toHaveBeenCalledWith({
      data: { tenantId, projectId, tipoDespesa: 'ALIMENTACAO', mes: '2026-06', valorLimiteCents: 50000 },
    });
    expect(prisma.categoryBudget.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { valorLimiteCents: 65000 },
    });
  });

  it('calcula progresso do mês ignorando categorias neutras e respeitando competência', async () => {
    prisma.categoryBudget.findMany.mockResolvedValue([
      { tipoDespesa: 'ALIMENTACAO', valorLimiteCents: 100000, mes: '2026-06' },
      { tipoDespesa: 'TRANSPORTE', valorLimiteCents: 50000, mes: null },
      { tipoDespesa: 'MOVIMENTACAO_INTERNA', valorLimiteCents: 999999, mes: '2026-06' },
    ]);
    prisma.expense.findMany.mockResolvedValue([
      { tipoDespesa: 'ALIMENTACAO', valorTotal: 30000 },
      { tipoDespesa: 'ALIMENTACAO', valorTotal: 50000 },
      { tipoDespesa: 'TRANSPORTE', valorTotal: 60000 },
    ]);

    const result = await service.progress(tenantId, projectId, '2026-06');

    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          projectId,
          settledByExpenseId: null,
          tipoDespesa: { in: ['ALIMENTACAO', 'TRANSPORTE'] },
        }),
      }),
    );
    expect(result).toEqual([
      { tipoDespesa: 'ALIMENTACAO', limiteCents: 100000, gastoCents: 80000, pct: 80 },
      { tipoDespesa: 'TRANSPORTE', limiteCents: 50000, gastoCents: 60000, pct: 120 },
    ]);
  });

  it('bloqueia metas em projetos não PESSOAL', async () => {
    prisma.project.findFirst.mockResolvedValueOnce({ id: projectId, type: 'REFORMA' });

    await expect(
      service.upsert(tenantId, projectId, {
        tipoDespesa: 'ALIMENTACAO',
        mes: '2026-06',
        valorLimiteCents: 1000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
