import { Test, TestingModule } from '@nestjs/testing';
import { CashFlowService } from './cash-flow.service';
import { PrismaService } from '../prisma/prisma.service';

type Entry = {
  id: string;
  data: Date;
  createdAt: Date;
  tipo: 'RECEBIMENTO' | 'DESPESA';
  status: 'EM_CAIXA' | 'PAGO' | 'PLANEJADO';
  valor: number;
  expenseId: string | null;
  receiptId: string | null;
  expense?: { titulo: string | null; fornecedor: string | null; linkedExpenseId?: string | null };
};

describe('CashFlowService.findAll — espelho cross-project', () => {
  let service: CashFlowService;
  let prisma: any;
  const tenantId = 't1';
  const projectId = 'p1';

  const entriesBase: Entry[] = [
    {
      id: 'r1',
      data: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      tipo: 'RECEBIMENTO',
      status: 'EM_CAIXA',
      valor: 30000,
      expenseId: null,
      receiptId: 'rec1',
      expense: undefined,
    },
    {
      id: 'd1',
      data: new Date('2026-06-02T00:00:00.000Z'),
      createdAt: new Date('2026-06-02T00:00:00.000Z'),
      tipo: 'DESPESA',
      status: 'PAGO',
      valor: 10000,
      expenseId: 'e1',
      receiptId: null,
      expense: { titulo: 'Despesa local', fornecedor: 'Fornecedor A', linkedExpenseId: null },
    },
    {
      id: 'd2',
      data: new Date('2026-06-03T00:00:00.000Z'),
      createdAt: new Date('2026-06-03T00:00:00.000Z'),
      tipo: 'DESPESA',
      status: 'PAGO',
      valor: 5000,
      expenseId: 'e2',
      receiptId: null,
      expense: { titulo: 'Espelho', fornecedor: 'Fornecedor B', linkedExpenseId: 'target-exp' },
    },
  ];

  beforeEach(async () => {
    prisma = {
      project: { findFirst: jest.fn() },
      cashFlowEntry: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const expenseClause = where.OR?.[1]?.expense;
          const excludesLinked = expenseClause?.linkedExpenseId === null;
          if (!excludesLinked) return Promise.resolve(entriesBase);
          return Promise.resolve(entriesBase.filter((e) => !e.expense?.linkedExpenseId));
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CashFlowService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<CashFlowService>(CashFlowService);
  });

  it('PESSOAL inclui espelho no fluxo e no rollingBalanceRealizado', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL' });

    const res = await service.findAll(tenantId, projectId);

    expect(res).toHaveLength(3);
    expect(res.map((r) => r.id)).toEqual(['r1', 'd1', 'd2']);
    expect(res[2]?.rollingBalanceRealizado).toBe(15000);
    expect(prisma.cashFlowEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { expenseId: null },
            { expense: { deletedAt: null } },
          ],
        }),
      }),
    );
  });

  it('não-PESSOAL mantém regra anterior (exclui linkedExpenseId)', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: projectId, tenantId, type: 'REFORMA' });

    const res = await service.findAll(tenantId, projectId);

    expect(res).toHaveLength(2);
    expect(res.map((r) => r.id)).toEqual(['r1', 'd1']);
    expect(res[1]?.rollingBalanceRealizado).toBe(20000);
    expect(prisma.cashFlowEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { expenseId: null },
            { expense: { deletedAt: null, linkedExpenseId: null } },
          ],
        }),
      }),
    );
  });
});
