import { RateioRequester } from '../expense/rateio.types';

const ADMIN: RateioRequester = {
  role: 'ADMIN',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

const REQUESTER_INDEX: Record<string, number> = {
  settleTargetParcela: 2,
  unsettleBySource: 2,
  reverseSourceLinks: 2,
  ratearSource: 2,
  unratearSource: 2,
  reverseAllForSource: 2,
  create: 5,
  createRecorrente: 4,
  findCrossProject: 3,
  linkCrossProject: 4,
  unlinkCrossProject: 3,
  conciliarParcela: 4,
  desconciliar: 3,
  ratear: 4,
  ratearMixed: 5,
  desratear: 3,
  update: 4,
  remove: 3,
  commitImport: 10,
  undoImport: 4,
  linkToExpense: 5,
  unlinkExpense: 3,
  linkToReceipt: 4,
  unlinkReceipt: 3,
};

function decorateProject(row: any): any {
  if (!row || !row.projectId || row.project) return row;
  return {
    ...row,
    project: {
      id: row.projectId,
      tenantId: row.tenantId,
      type: row.projectId.toLowerCase().includes('pessoal') ? 'PESSOAL' : 'REFORMA',
    },
  };
}

/** Adapta mocks legados ao include de projeto exigido pelo child ACL. */
export function installAclProjectMocks(prisma: any): any {
  const expense = prisma?.expense;
  if (expense?.findFirst) {
    const originalFindFirst = expense.findFirst.bind(expense);
    expense.findFirst = jest.fn(async (...args: any[]) =>
      decorateProject(await originalFindFirst(...args)),
    );

    if (expense.findMany) {
      const originalFindMany = expense.findMany.bind(expense);
      expense.findMany = jest.fn(async (...args: any[]) => {
        const found = (await originalFindMany(...args)) ?? [];
        if (found.length > 0) return found.map(decorateProject);
        const where = args[0]?.where;
        const ids = [
          ...(where?.id?.in ?? []),
          ...(where?.OR ?? []).flatMap((clause: any) =>
            clause.id?.in ?? (clause.id ? [clause.id] : []),
          ),
        ];
        const rows = await Promise.all(
          [...new Set(ids)].map((id) =>
            expense.findFirst({ where: { id, tenantId: where?.tenantId } }),
          ),
        );
        return rows.filter(Boolean).map(decorateProject);
      });
    } else {
      expense.findMany = jest.fn(async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? [];
        const rows = await Promise.all(
          ids.map((id) => expense.findFirst({ where: { id, tenantId: where.tenantId } })),
        );
        return rows.filter(Boolean).map(decorateProject);
      });
    }
  }
  if (prisma && !prisma.rateioAllocation) prisma.rateioAllocation = {};
  if (prisma?.rateioAllocation && !prisma.rateioAllocation.findMany) {
    prisma.rateioAllocation.findMany = jest.fn().mockResolvedValue([]);
  }
  if (prisma && !prisma.crossProjectSettlement) prisma.crossProjectSettlement = {};
  if (prisma?.crossProjectSettlement && !prisma.crossProjectSettlement.findMany) {
    prisma.crossProjectSettlement.findMany = jest.fn().mockResolvedValue([]);
  }
  return prisma;
}

export function withAclRequester<T extends object>(service: T, prisma: any): T {
  installAclProjectMocks(prisma);
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      const requesterIndex = REQUESTER_INDEX[String(property)];
      if (typeof value !== 'function' || requesterIndex === undefined) return value;
      return (...args: any[]) => {
        while (args.length < requesterIndex) args.push(undefined);
        if (args.length === requesterIndex) args.push(ADMIN);
        return value.apply(target, args);
      };
    },
  });
}
