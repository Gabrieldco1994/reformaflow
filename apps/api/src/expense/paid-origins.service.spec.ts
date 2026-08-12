import { Test, TestingModule } from '@nestjs/testing';
import { PaidOriginsService } from './paid-origins.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PaidOriginsService.findForProject', () => {
  let service: PaidOriginsService;
  let prisma: any;

  const viewer = {
    id: 'u1',
    role: 'ADMIN',
    allowedProjects: [] as string[],
    allowedProjectTypes: [] as string[],
    allowedModules: [] as string[],
  };

  beforeEach(async () => {
    prisma = {
      crossProjectSettlement: { findMany: jest.fn().mockResolvedValue([]) },
      rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      expense: { findMany: jest.fn().mockResolvedValue([]) },
      creditCard: { findMany: jest.fn().mockResolvedValue([]) },
      bankAccount: { findMany: jest.fn().mockResolvedValue([]) },
      cashFlowEntry: {
        update: jest.fn(), updateMany: jest.fn(), create: jest.fn(), createMany: jest.fn(),
        upsert: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(),
      },
      project: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    for (const model of ['expense', 'crossProjectSettlement', 'rateioAllocation', 'creditCard', 'bankAccount'] as const) {
      for (const op of ['update', 'updateMany', 'create', 'createMany', 'upsert', 'delete', 'deleteMany'] as const) {
        (prisma[model] as any)[op] = jest.fn();
      }
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [PaidOriginsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(PaidOriginsService);
  });

  it('conjunto VAZIO: projeto sem settlement/rateio/link retorna { items: [] } e NÃO 404', async () => {
    await expect(service.findForProject('t1', 'proj-reforma', viewer)).resolves.toEqual({ items: [] });
  });

  it('O2: filtra deletedAt:null EXPLICITAMENTE no alvo (relação aninhada — $use não injeta)', async () => {
    await service.findForProject('t1', 'proj-reforma', viewer);
    const w = prisma.crossProjectSettlement.findMany.mock.calls[0][0].where;
    expect(w.tenantId).toBe('t1');
    expect(w.target).toEqual({ projectId: 'proj-reforma', tenantId: 't1', deletedAt: null });
    const wr = prisma.rateioAllocation.findMany.mock.calls[0][0].where;
    expect(wr.target).toEqual({ projectId: 'proj-reforma', tenantId: 't1', deletedAt: null });
  });

  it('O2: a releitura da FONTE filtra tenantId + deletedAt:null explicitamente', async () => {
    prisma.crossProjectSettlement.findMany.mockResolvedValue([
      { targetExpenseId: 'tgt', sourceExpenseId: 'src', parcelaIndex: 0 },
    ]);
    await service.findForProject('t1', 'proj-reforma', viewer);
    const srcCall = prisma.expense.findMany.mock.calls
      .find((c: any) => c[0]?.where?.id?.in?.includes('src'));
    expect(srcCall[0].where).toMatchObject({ tenantId: 't1', deletedAt: null });
  });

  it('O11: sem N+1 — 9 alvos rateados pela MESMA fonte não multiplicam queries', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => ({ targetExpenseId: `t${i}`, sourceExpenseId: 'src-telha' })),
    );
    await service.findForProject('t1', 'proj-reforma', viewer);
    expect(prisma.expense.findMany.mock.calls.length).toBeLessThanOrEqual(2);
    expect(prisma.creditCard.findMany.mock.calls.length).toBeLessThanOrEqual(1);
    expect(prisma.bankAccount.findMany.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('O3: a busca de link reverso cobre APENAS alvos sem settlement/rateio', async () => {
    prisma.crossProjectSettlement.findMany.mockResolvedValue([
      { targetExpenseId: 'tgt-settled', sourceExpenseId: 'src-a', parcelaIndex: 0 },
    ]);
    prisma.rateioAllocation.findMany.mockResolvedValue([
      { targetExpenseId: 'tgt-rateado', sourceExpenseId: 'src-b' },
    ]);
    // + expense.findMany do projeto devolvendo tgt-settled, tgt-rateado, tgt-solto
    prisma.expense.findMany.mockImplementation((args: any) => {
      if (args?.where?.projectId === 'proj-reforma') {
        return Promise.resolve([
          { id: 'tgt-settled' }, { id: 'tgt-rateado' }, { id: 'tgt-solto' },
        ]);
      }
      return Promise.resolve([]);
    });
    await service.findForProject('t1', 'proj-reforma', viewer);
    const linkCall = prisma.expense.findMany.mock.calls
      .find((c: any) => c[0]?.where?.linkedExpenseId?.in);
    expect(linkCall[0].where.linkedExpenseId.in).toEqual(['tgt-solto']);
  });

  it('O1: nenhuma escrita ocorre (read-only absoluto)', async () => {
    await service.findForProject('t1', 'proj-reforma', viewer);
    for (const model of ['expense', 'crossProjectSettlement', 'rateioAllocation',
                         'cashFlowEntry', 'creditCard', 'bankAccount'] as const) {
      for (const op of ['update', 'updateMany', 'create', 'createMany',
                        'upsert', 'delete', 'deleteMany'] as const) {
        expect(prisma[model]?.[op]).not.toHaveBeenCalled();
      }
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('tenant scoping: settlement de OUTRO tenant nunca é consultado', async () => {
    await service.findForProject('t1', 'proj-reforma', viewer);
    for (const call of prisma.crossProjectSettlement.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe('t1');
    }
  });

  it('delega o escopo a resolveAccessibleProjectScope (não reimplementa a regra de acesso)', async () => {
    await service.findForProject('t1', 'proj-reforma',
      { id: 'u1', role: 'USER', allowedProjects: ['p1'], allowedProjectTypes: ['PESSOAL'], allowedModules: ['expenses'] });
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 't1', deletedAt: null }) }),
    );
  });
});
