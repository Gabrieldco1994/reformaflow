import { UsersService } from './users.service';

function userRow(overrides: Partial<any> = {}) {
  return {
    id: 'u1',
    username: 'ana',
    name: 'Ana',
    role: 'USER',
    tenantId: 'tenant-1',
    allowedModules: '[]',
    allowedProjects: '[]',
    allowedProjectTypes: '[]',
    createdByUserId: null,
    lastLoginAt: null,
    lastActivityAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    tenant: { name: 'Tenant 1' },
    ...overrides,
  };
}

describe('UsersService list analytics', () => {
  it('attaches project/expense creation counts per user', async () => {
    const prisma: any = {
      user: { findMany: jest.fn().mockResolvedValue([userRow(), userRow({ id: 'u2', username: 'bruno', name: 'Bruno' })]) },
      project: {
        groupBy: jest.fn().mockResolvedValue([{ createdByUserId: 'u1', _count: { _all: 3 } }]),
      },
      expense: {
        groupBy: jest.fn().mockResolvedValue([{ createdByUserId: 'u1', _count: { _all: 7 } }]),
      },
    };

    const result = await new UsersService(prisma).list('tenant-1');

    expect(result.find((u: any) => u.id === 'u1')?.projectsCreatedCount).toBe(3);
    expect(result.find((u: any) => u.id === 'u1')?.expensesCreatedCount).toBe(7);
    expect(result.find((u: any) => u.id === 'u2')?.projectsCreatedCount).toBe(0);
    expect(result.find((u: any) => u.id === 'u2')?.expensesCreatedCount).toBe(0);
  });

  it('filters soft-deleted and settled expenses, and skips groupBy for empty result sets', async () => {
    const prisma: any = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      project: { groupBy: jest.fn().mockResolvedValue([]) },
      expense: { groupBy: jest.fn().mockResolvedValue([]) },
    };

    await expect(new UsersService(prisma).list('tenant-1')).resolves.toEqual([]);
    expect(prisma.project.groupBy).not.toHaveBeenCalled();
    expect(prisma.expense.groupBy).not.toHaveBeenCalled();

    prisma.user.findMany.mockResolvedValue([userRow()]);
    prisma.project.groupBy.mockResolvedValue([{ createdByUserId: 'u1', _count: { _all: 1 } }]);
    prisma.expense.groupBy.mockResolvedValue([{ createdByUserId: 'u1', _count: { _all: 2 } }]);
    await new UsersService(prisma).list('tenant-1');

    expect(prisma.project.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null, createdByUserId: { in: ['u1'] } }),
      }),
    );
    expect(prisma.expense.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          settledByExpenseId: null,
          createdByUserId: { in: ['u1'] },
        }),
      }),
    );
  });
});
