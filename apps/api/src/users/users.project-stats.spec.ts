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
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  for (const m of CONTENT_MODELS) {
    prisma[m] = { groupBy: jest.fn().mockResolvedValue([]) };
  }
  return Object.assign(prisma, over);
}

describe('UsersService.getProjectStats', () => {
  it('groups active projects by type (sorted desc) with per-user breakdown', async () => {
    const prisma = makePrisma();
    prisma.project.groupBy.mockResolvedValue([
      { type: 'CASA', createdByUserId: 'u1', _count: { _all: 2 } },
      { type: 'PESSOAL', createdByUserId: 'u1', _count: { _all: 3 } },
      { type: 'PESSOAL', createdByUserId: 'u2', _count: { _all: 2 } },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Ana' },
      { id: 'u2', name: 'Bruno' },
    ]);

    const { byType } = await new UsersService(prisma).getProjectStats();

    expect(byType.map((r: any) => [r.type, r.count])).toEqual([
      ['PESSOAL', 5],
      ['CASA', 2],
    ]);
    const pessoal = byType.find((r: any) => r.type === 'PESSOAL');
    expect(pessoal?.users).toEqual([
      { userId: 'u1', name: 'Ana', count: 3 },
      { userId: 'u2', name: 'Bruno', count: 2 },
    ]);
    expect(prisma.project.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['type', 'createdByUserId'],
        where: { deletedAt: null },
      }),
    );
  });

  it('labels projects with no owner as "Sem dono"', async () => {
    const prisma = makePrisma();
    prisma.project.groupBy.mockResolvedValue([
      { type: 'CARRO', createdByUserId: null, _count: { _all: 1 } },
    ]);

    const { byType } = await new UsersService(prisma).getProjectStats();

    expect(byType[0].users).toEqual([{ userId: null, name: 'Sem dono', count: 1 }]);
  });

  it('counts projects that created content today with owners, excluding soft-deleted', async () => {
    const prisma = makePrisma();
    prisma.expense.groupBy.mockResolvedValue([{ projectId: 'p1' }, { projectId: 'p2' }]);
    prisma.receipt.groupBy.mockResolvedValue([{ projectId: 'p2' }, { projectId: 'p3' }]);
    // p3 é apagado -> some do findMany (where deletedAt null) e não deve contar
    prisma.project.findMany.mockResolvedValue([
      { type: 'PESSOAL', createdByUserId: 'u1' },
      { type: 'CASA', createdByUserId: 'u2' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Ana' },
      { id: 'u2', name: 'Bruno' },
    ]);

    const stats = await new UsersService(prisma).getProjectStats();

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2', 'p3'] }, deletedAt: null },
      select: { type: true, createdByUserId: true },
    });
    expect(stats.contentTodayTotal).toBe(2);
    expect(stats.contentTodayByType).toEqual(
      expect.arrayContaining([
        { type: 'PESSOAL', count: 1, users: [{ userId: 'u1', name: 'Ana', count: 1 }] },
        { type: 'CASA', count: 1, users: [{ userId: 'u2', name: 'Bruno', count: 1 }] },
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

  it('counts total expenses by project type (cross-tenant, no time window)', async () => {
    const prisma = makePrisma();
    // A janela "hoje" e o total de despesas compartilham expense.groupBy; o
    // mock ramifica pela presença de _count (só a query de total pede _count).
    prisma.expense.groupBy.mockImplementation((args: any) =>
      Promise.resolve(
        args?._count
          ? [
              { projectId: 'p1', _count: { _all: 5 } },
              { projectId: 'p2', _count: { _all: 3 } },
              { projectId: 'pDel', _count: { _all: 9 } }, // projeto apagado -> excluído
            ]
          : [],
      ),
    );
    prisma.project.findMany.mockResolvedValue([
      { id: 'p1', type: 'PESSOAL', createdByUserId: 'u1' },
      { id: 'p2', type: 'PESSOAL', createdByUserId: 'u2' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Ana' },
      { id: 'u2', name: 'Bruno' },
    ]);

    const stats = await new UsersService(prisma).getProjectStats();

    expect(prisma.expense.groupBy).toHaveBeenCalledWith({
      by: ['projectId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    expect(stats.expensesTotal).toBe(8); // 5 + 3, pDel excluído
    expect(stats.expensesByType).toEqual([
      {
        type: 'PESSOAL',
        count: 8,
        users: [
          { userId: 'u1', name: 'Ana', count: 5 },
          { userId: 'u2', name: 'Bruno', count: 3 },
        ],
      },
    ]);
  });

  it('also counts expenses by type restricted to today (filtro "Hoje" do card)', async () => {
    const prisma = makePrisma();
    // Ramifica pela presença de where.createdAt: só a query "hoje" filtra por data.
    prisma.expense.groupBy.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.createdAt
          ? [{ projectId: 'p1', _count: { _all: 2 } }]
          : args?._count
            ? [
                { projectId: 'p1', _count: { _all: 5 } },
                { projectId: 'p2', _count: { _all: 3 } },
              ]
            : [],
      ),
    );
    prisma.project.findMany.mockResolvedValue([
      { id: 'p1', type: 'PESSOAL', createdByUserId: 'u1' },
      { id: 'p2', type: 'CASA', createdByUserId: 'u2' },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Ana' }]);

    const stats = await new UsersService(prisma).getProjectStats();

    expect(stats.expensesTotal).toBe(8); // sempre: 5 + 3
    expect(stats.expensesTodayTotal).toBe(2); // hoje: só p1
    expect(stats.expensesTodayByType).toEqual([
      { type: 'PESSOAL', count: 2, users: [{ userId: 'u1', name: 'Ana', count: 2 }] },
    ]);
  });
});
