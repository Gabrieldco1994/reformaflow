import type { RateioRequester } from '../expense/rateio.types';

export const TEST_OWNER_REQUESTER: RateioRequester = {
  role: 'OWNER',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

function matchesScopedWhere(row: any, where: any): boolean {
  if (!row) return false;
  if (where?.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  if (where?.deletedAt !== undefined && (row.deletedAt ?? null) !== where.deletedAt) {
    return false;
  }
  if (typeof where?.id === 'string' && row.id !== where.id) return false;
  if (Array.isArray(where?.id?.in) && !where.id.in.includes(row.id)) return false;
  if (
    Array.isArray(where?.OR) &&
    !where.OR.some((clause: any) => {
      if (typeof clause.id === 'string') return row.id === clause.id;
      if (Array.isArray(clause.id?.in)) return clause.id.in.includes(row.id);
      if (typeof clause.linkedExpenseId === 'string') {
        return row.linkedExpenseId === clause.linkedExpenseId;
      }
      if (Array.isArray(clause.linkedExpenseId?.in)) {
        return clause.linkedExpenseId.in.includes(row.linkedExpenseId);
      }
      return false;
    })
  ) {
    return false;
  }
  return true;
}

async function includeStoredProject(prisma: any, row: any, args: any): Promise<any> {
  if (!row || (!args?.include?.project && !args?.select?.project) || row.project) {
    return row;
  }
  if (typeof prisma?.project?.findFirst !== 'function') return { ...row, project: null };
  const project = await prisma.project.findFirst({
    where: {
      id: row.projectId,
      tenantId: row.tenantId,
      deletedAt: null,
    },
  });
  return {
    ...row,
    project: project && project.tenantId === row.tenantId ? project : null,
  };
}

/** Adapta somente os includes/filtros que a fixture realmente materializa. */
export function installAclProjectMocks(prisma: any): any {
  const expense = prisma?.expense;
  if (!expense?.findFirst || expense.__aclScopedMock) return prisma;
  expense.__aclScopedMock = true;
  const originalFindFirst = expense.findFirst.bind(expense);
  const originalFindMany = expense.findMany?.bind(expense);

  expense.findFirst = jest.fn(async (args: any) => {
    const row = await originalFindFirst(args);
    if (!matchesScopedWhere(row, args?.where)) return null;
    return includeStoredProject(prisma, row, args);
  });

  expense.findMany = jest.fn(async (args: any) => {
    const fromDelegate = originalFindMany ? ((await originalFindMany(args)) ?? []) : [];
    const rows = fromDelegate.filter((row: any) => matchesScopedWhere(row, args?.where));
    const ids: string[] = [
      ...(args?.where?.id?.in ?? []),
      ...(args?.where?.OR ?? []).flatMap((clause: any) => {
        if (typeof clause.id === 'string') return [clause.id];
        return clause.id?.in ?? [];
      }),
    ];
    const foundIds = new Set(rows.map((row: any) => row.id));
    for (const id of ids) {
      if (foundIds.has(id)) continue;
      const row = await expense.findFirst({
        where: {
          id,
          tenantId: args?.where?.tenantId,
          deletedAt: args?.where?.deletedAt,
        },
      });
      if (matchesScopedWhere(row, { ...args?.where, id })) rows.push(row);
    }
    return Promise.all(rows.map((row: any) => includeStoredProject(prisma, row, args)));
  });
  return prisma;
}

export function withAclRequester<T extends object>(service: T, prisma: any): T {
  installAclProjectMocks(prisma);
  return service;
}
