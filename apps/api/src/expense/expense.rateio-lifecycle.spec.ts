import { BadRequestException } from '@nestjs/common';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { ExpenseService } from './expense.service';

const TENANT_ID = 'tenant-1';
const SOURCE_ID = 'source-1';
const TARGET_IDS = ['target-1', 'target-2', 'target-3'];

function expense(id: string, projectId: string, linkedExpenseId: string | null = null) {
  return {
    id,
    projectId,
    tenantId: TENANT_ID,
    deletedAt: null,
    linkedExpenseId,
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    categoriaMaoDeObra: null,
    roomId: null,
    valor: 10_000,
    quantidade: 1,
    valorTotal: 10_000,
    titulo: id,
    fornecedor: null,
    link: null,
    imageUrl: null,
    formaPagamento: 'PARCELADO',
    dataPagamento: null,
    quantidadeParcela: 2,
    dataInicioParcela: new Date('2026-08-10T00:00:00.000Z'),
    dataCompra: null,
    status: 'PLANEJADO',
    recorrente: false,
    recorrenciaFim: null,
    recurrenceKey: null,
    paidParcelas: '[0]',
    installmentDateOverrides: '{"1":"2026-09-20"}',
    cardLast4: null,
    bankLast4: null,
    accountId: null,
    settlesInvoiceKey: null,
    settledByExpenseId: null,
    createdByUserId: null,
    room: null,
  };
}

type ExpenseRow = ReturnType<typeof expense>;

function makeHarness() {
  const rows = new Map<string, ExpenseRow>([
    [SOURCE_ID, expense(SOURCE_ID, 'pessoal-1', TARGET_IDS[0]!)],
    ...TARGET_IDS.map((id) => [id, expense(id, 'obra-1')] as const),
    ['external-1', expense('external-1', 'other-1')],
  ]);
  const allocations = TARGET_IDS.map((targetExpenseId, index) => ({
    tenantId: TENANT_ID,
    sourceExpenseId: SOURCE_ID,
    targetExpenseId,
    allocation: 10_000,
    plannedStatus: 'PLANEJADO',
    plannedPaid: index === 0 ? '[0]' : null,
    plannedValor: 20_000 + index,
    plannedQuantidade: 1,
    plannedValorTotal: 20_000 + index,
    plannedForma: 'A_VISTA',
    plannedQtdParcela: null,
    plannedDataInicio: null,
    plannedDataPagamento: new Date('2026-10-01T00:00:00.000Z'),
    plannedInstallmentDateOverrides: null,
  }));

  const prisma: any = {
    project: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: where.id,
        tenantId: TENANT_ID,
        type: where.id === 'pessoal-1' ? 'PESSOAL' : 'REFORMA',
      })),
    },
    expense: {
      findFirst: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        [...rows.values()].filter(
          (row) =>
            row.tenantId === where.tenantId &&
            row.linkedExpenseId === where.linkedExpenseId &&
            row.deletedAt === null,
        ),
      ),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 'paid-clone', ...data })),
      update: jest.fn(async ({ where, data }: any) => {
        const current = rows.get(where.id);
        const definedData = Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== undefined),
        );
        const updated = { ...current, ...definedData } as ExpenseRow;
        rows.set(where.id, updated);
        return updated;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (typeof where.id === 'string') {
          const current = rows.get(where.id);
          if (!current || current.deletedAt !== null) return { count: 0 };
          rows.set(where.id, { ...current, ...data });
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    rateioAllocation: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.OR) {
          return (
            allocations.find(
              (row) =>
                row.tenantId === where.tenantId &&
                (row.sourceExpenseId === where.OR[0].sourceExpenseId ||
                  row.targetExpenseId === where.OR[1].targetExpenseId),
            ) ?? null
          );
        }
        return (
          allocations.find(
            (row) =>
              row.tenantId === where.tenantId &&
              (where.sourceExpenseId === undefined ||
                row.sourceExpenseId === where.sourceExpenseId) &&
              (where.targetExpenseId === undefined ||
                row.targetExpenseId === where.targetExpenseId),
          ) ?? null
        );
      }),
      findMany: jest.fn(async ({ where }: any) => {
        if (where.OR) {
          return allocations.filter(
            (row) =>
              row.tenantId === where.tenantId &&
              (row.sourceExpenseId === where.OR[0].sourceExpenseId ||
                row.targetExpenseId === where.OR[1].targetExpenseId),
          );
        }
        return allocations.filter(
          (row) =>
            row.tenantId === where.tenantId &&
            (where.sourceExpenseId === undefined ||
              row.sourceExpenseId === where.sourceExpenseId),
        );
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        allocations.find((row) => row.targetExpenseId === where.targetExpenseId) ?? null,
      ),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    crossProjectSettlement: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    creditCard: { findFirst: jest.fn().mockResolvedValue(null) },
    bankAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    cashFlowEntry: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (work: any) =>
      typeof work === 'function' ? work(prisma) : Promise.all(work),
    ),
  };
  const conciliacao = new ConciliacaoService(prisma);
  const service = new ExpenseService(prisma, conciliacao);
  return { service, prisma, rows, allocations, conciliacao };
}

function participantId(role: 'source' | 'target'): string {
  return role === 'source' ? SOURCE_ID : TARGET_IDS[0]!;
}

describe('ExpenseService — ciclo de vida de participantes de rateio (#428)', () => {
  it('remove a fonte em uma transação, restaura os três alvos e soft-deleta só fonte e caixa da fonte', async () => {
    const { service, prisma, rows, conciliacao } = makeHarness();
    const unratear = jest.spyOn(conciliacao, 'unratearSource');

    await expect(service.remove(TENANT_ID, 'pessoal-1', SOURCE_ID)).resolves.toEqual({
      deleted: true,
      count: 1,
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(unratear).toHaveBeenCalledWith(prisma, {
      tenantId: TENANT_ID,
      sourceExpenseId: SOURCE_ID,
    });
    expect(prisma.rateioAllocation.delete).toHaveBeenCalledTimes(3);
    TARGET_IDS.forEach((id, index) => {
      expect(rows.get(id)).toEqual(
        expect.objectContaining({
          deletedAt: null,
          valorTotal: 20_000 + index,
          status: 'PLANEJADO',
        }),
      );
    });
    expect(rows.get(SOURCE_ID)?.deletedAt).toBeInstanceOf(Date);
    expect(prisma.cashFlowEntry.updateMany).toHaveBeenCalledWith({
      where: { expenseId: SOURCE_ID, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it.each([TARGET_IDS[0], TARGET_IDS[2]])(
    'rejeita remover o alvo %s sem qualquer escrita',
    async (targetId) => {
      const { service, prisma } = makeHarness();

      await expect(service.remove(TENANT_ID, 'obra-1', targetId!)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(prisma.expense.update).not.toHaveBeenCalled();
      expect(prisma.expense.updateMany).not.toHaveBeenCalled();
      expect(prisma.cashFlowEntry.updateMany).not.toHaveBeenCalled();
      expect(prisma.rateioAllocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_ID }) }),
      );
    },
  );

  it.each(['source', 'target'] as const)(
    'permite metadados no %s e atualiza somente a linha selecionada',
    async (role) => {
      const { service, prisma } = makeHarness();
      const id = participantId(role);

      await service.update(TENANT_ID, role === 'source' ? 'pessoal-1' : 'obra-1', id, {
        titulo: 'Telhas revisadas',
        fornecedor: 'Telha Norte',
        link: 'https://example.test/telhas',
        imageUrl: 'https://example.test/telhas.jpg',
        roomId: 'room-2',
        categoriaMaoDeObra: 'EMPREITEIRO',
        tipoDespesa: 'OUTROS',
        dataCompra: '2026-08-12',
      } as never);

      const touchedExpenseIds = prisma.expense.update.mock.calls.map(
        ([args]: any[]) => args.where.id,
      );
      expect(new Set(touchedExpenseIds)).toEqual(new Set([id]));
    },
  );

  it.each(['source', 'target'] as const)(
    'aceita payload financeiro completo inalterado no %s sem limpar pagamentos ou overrides',
    async (role) => {
      const { service, prisma } = makeHarness();
      const id = participantId(role);
      const linkedExpenseId = role === 'source' ? TARGET_IDS[0] : null;

      await service.update(TENANT_ID, role === 'source' ? 'pessoal-1' : 'obra-1', id, {
        valor: 100,
        quantidade: 1,
        status: 'PLANEJADO',
        formaPagamento: 'PARCELADO',
        dataPagamento: null,
        quantidadeParcela: 2,
        dataInicioParcela: '2026-08-10',
        recorrente: false,
        recorrenciaFim: null,
        linkedExpenseId,
      } as never);

      const ownWrite = prisma.expense.update.mock.calls.find(
        ([args]: any[]) => args.where.id === id,
      )![0].data;
      expect(ownWrite.paidParcelas).toBeUndefined();
      expect(ownWrite.installmentDateOverrides).toBeUndefined();
    },
  );

  it.each([
    ['valor', { valor: 101 }],
    ['status', { status: 'PAGO' }],
    ['cronograma', { quantidadeParcela: 3 }],
    ['recorrência', { recorrente: true }],
    ['vínculo', { linkedExpenseId: 'external-1' }],
  ])('rejeita mudança efetiva de %s na fonte e no alvo sem escrita', async (_label, dto) => {
    for (const role of ['source', 'target'] as const) {
      const { service, prisma } = makeHarness();
      await expect(
        service.update(
          TENANT_ID,
          role === 'source' ? 'pessoal-1' : 'obra-1',
          participantId(role),
          dto as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.expense.update).not.toHaveBeenCalled();
      expect(prisma.expense.create).not.toHaveBeenCalled();
    }
  });

  it.each(['source', 'target'] as const)(
    'rejeita setParcelaStatus no %s sem escrita',
    async (role) => {
      const { service, prisma } = makeHarness();
      await expect(
        service.setParcelaStatus(
          TENANT_ID,
          role === 'source' ? 'pessoal-1' : 'obra-1',
          participantId(role),
          1,
          true,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.expense.update).not.toHaveBeenCalled();
    },
  );

  it.each(['source', 'target'] as const)(
    'rejeita payPlanned no %s sem escrita',
    async (role) => {
      const { service, prisma } = makeHarness();
      await expect(
        service.payPlanned(
          TENANT_ID,
          role === 'source' ? 'pessoal-1' : 'obra-1',
          participantId(role),
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.expense.update).not.toHaveBeenCalled();
      expect(prisma.expense.create).not.toHaveBeenCalled();
      expect(prisma.rateioAllocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_ID }) }),
      );
    },
  );
});
