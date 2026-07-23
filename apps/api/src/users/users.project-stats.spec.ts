import { UsersService } from './users.service';

const CONTENT_MODELS = [
  'expense', 'receipt', 'recurringBill', 'creditCard', 'bankAccount',
  'carInfo', 'plant', 'floorPlan', 'financing', 'reminder', 'maintenanceLog',
  'scheduleTask', 'pendencia', 'priceMonitorItem', 'categoryBudget', 'cashFlowEntry',
];

function makePrisma(over: Record<string, any> = {}): any {
  const prisma: any = {
    project: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  for (const m of CONTENT_MODELS) {
    prisma[m] = { groupBy: jest.fn().mockResolvedValue([]) };
  }
  return Object.assign(prisma, over);
}

describe('UsersService.getProjectStats', () => {
  it('groups active projects by type, sorted desc', async () => {
    const prisma = makePrisma();
    prisma.project.groupBy.mockResolvedValue([
      { type: 'CASA', _count: { _all: 2 } },
      { type: 'PESSOAL', _count: { _all: 5 } },
    ]);

    const { byType } = await new UsersService(prisma).getProjectStats();

    expect(byType).toEqual([
      { type: 'PESSOAL', count: 5 },
      { type: 'CASA', count: 2 },
    ]);
    expect(prisma.project.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });

  it('counts projects that created content today, excluding soft-deleted', async () => {
    const prisma = makePrisma();
    prisma.expense.groupBy.mockResolvedValue([{ projectId: 'p1' }, { projectId: 'p2' }]);
    prisma.receipt.groupBy.mockResolvedValue([{ projectId: 'p2' }, { projectId: 'p3' }]);
    // p3 é apagado -> some do findMany (where deletedAt null) e não deve contar
    prisma.project.findMany.mockResolvedValue([{ type: 'PESSOAL' }, { type: 'CASA' }]);

    const stats = await new UsersService(prisma).getProjectStats();

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2', 'p3'] }, deletedAt: null },
      select: { type: true },
    });
    expect(stats.contentTodayTotal).toBe(2);
    expect(stats.contentTodayByType).toEqual(
      expect.arrayContaining([
        { type: 'PESSOAL', count: 1 },
        { type: 'CASA', count: 1 },
      ]),
    );
  });

  it('does not hit findMany when nothing was created today', async () => {
    const prisma = makePrisma();
    const stats = await new UsersService(prisma).getProjectStats();
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    expect(stats.contentTodayTotal).toBe(0);
    expect(stats.contentTodayByType).toEqual([]);
  });

  it('filters content by the São Paulo (UTC-3) "today" window', async () => {
    const prisma = makePrisma();
    const now = new Date('2026-07-23T01:45:00.000Z'); // 22:45 em SP, ainda dia 22

    await new UsersService(prisma).getProjectStats(now);

    expect(prisma.expense.groupBy).toHaveBeenCalledWith({
      by: ['projectId'],
      where: {
        createdAt: {
          gte: new Date('2026-07-22T03:00:00.000Z'),
          lt: new Date('2026-07-23T03:00:00.000Z'),
        },
      },
    });
  });
});
