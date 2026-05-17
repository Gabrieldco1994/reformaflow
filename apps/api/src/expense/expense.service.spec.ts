import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';

type AnyFn = jest.Mock;

interface PrismaMock {
  project: { findFirst: AnyFn };
  expense: {
    findFirst: AnyFn;
    findMany: AnyFn;
    findUnique: AnyFn;
    create: AnyFn;
    update: AnyFn;
  };
  cashFlowEntry: {
    updateMany: AnyFn;
    createMany: AnyFn;
  };
  $transaction: AnyFn;
}

const makePrismaMock = (): PrismaMock => {
  const cashFlowMock = {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const expenseMock = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const mock = {
    project: { findFirst: jest.fn() },
    expense: expenseMock,
    cashFlowEntry: cashFlowMock,
    $transaction: jest.fn(),
  } as PrismaMock;

  // Default $transaction implementation: runs callback with the mock itself.
  mock.$transaction.mockImplementation(async (cb: any) => {
    if (typeof cb === 'function') return cb(mock);
    return Promise.all(cb);
  });

  return mock;
};

describe('ExpenseService', () => {
  let service: ExpenseService;
  let prisma: PrismaMock;
  const tenantId = 'tenant-1';
  const projectId = 'project-1';

  beforeEach(async () => {
    prisma = makePrismaMock();
    prisma.project.findFirst.mockResolvedValue({
      id: projectId,
      tenantId,
      type: 'REFORMA',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ExpenseService>(ExpenseService);
  });

  describe('validação de projeto', () => {
    it('lança NotFound quando o projeto não pertence ao tenant', async () => {
      prisma.project.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.findAll(tenantId, projectId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('converte valor de reais para centavos e calcula valorTotal', async () => {
      const created = { id: 'e1', valor: 10050, quantidade: 2, valorTotal: 20100 };
      prisma.expense.create.mockResolvedValue(created);
      prisma.expense.findUnique.mockResolvedValue({
        ...created,
        projectId,
        tenantId,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        categoriaMaoDeObra: null,
        roomId: null,
        formaPagamento: 'A_VISTA',
        dataPagamento: null,
        quantidadeParcela: null,
        dataInicioParcela: null,
        status: 'PLANEJADO',
        settledByExpenseId: null,
        room: null,
      });

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 100.5,
        quantidade: 2,
        formaPagamento: 'A_VISTA',
        status: 'PLANEJADO',
      } as any);

      expect(prisma.expense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            valor: 10050, // 100.50 * 100
            quantidade: 2,
            valorTotal: 20100,
          }),
        }),
      );
    });

    it('converte dataPagamento string para Date', async () => {
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 50,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        dataPagamento: '2025-01-15',
        status: 'PAGO',
      } as any);

      const arg = prisma.expense.create.mock.calls[0]![0];
      expect(arg.data.dataPagamento).toBeInstanceOf(Date);
      expect(arg.data.dataPagamento.toISOString().slice(0, 10)).toBe('2025-01-15');
    });
  });

  describe('update — undefined vs null em campos de data (regressão)', () => {
    const existing = {
      id: 'e1',
      projectId,
      tenantId,
      valor: 10000,
      quantidade: 1,
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      categoriaMaoDeObra: null,
      roomId: null,
      titulo: null,
      fornecedor: null,
      link: null,
      imageUrl: null,
      formaPagamento: 'A_VISTA',
      dataPagamento: new Date('2025-01-01'),
      quantidadeParcela: null,
      dataInicioParcela: null,
      status: 'PAGO',
      settledByExpenseId: null,
      deletedAt: null,
    };

    beforeEach(() => {
      prisma.expense.findFirst.mockResolvedValue(existing);
      prisma.expense.update.mockImplementation(async ({ data }: any) => ({
        ...existing,
        ...data,
      }));
      prisma.expense.findUnique.mockResolvedValue(null);
    });

    it('quando dataPagamento é null no DTO, salva null (limpa campo)', async () => {
      await service.update(tenantId, projectId, 'e1', {
        dataPagamento: null,
      } as any);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.dataPagamento).toBeNull();
    });

    it('quando dataPagamento é undefined no DTO, preserva (não atualiza)', async () => {
      await service.update(tenantId, projectId, 'e1', {} as any);
      const arg = prisma.expense.update.mock.calls[0]![0];
      // Em update, undefined = "não atualiza" — passamos undefined para o Prisma.
      expect(arg.data.dataPagamento).toBeUndefined();
    });

    it('quando dataPagamento é string ISO, converte para Date', async () => {
      await service.update(tenantId, projectId, 'e1', {
        dataPagamento: '2025-06-30',
      } as any);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.dataPagamento).toBeInstanceOf(Date);
      expect((arg.data.dataPagamento as Date).toISOString().slice(0, 10)).toBe('2025-06-30');
    });

    it('mesmo comportamento para dataInicioParcela: null limpa', async () => {
      await service.update(tenantId, projectId, 'e1', {
        dataInicioParcela: null,
      } as any);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.dataInicioParcela).toBeNull();
    });

    it('mesmo comportamento para dataInicioParcela: undefined preserva', async () => {
      await service.update(tenantId, projectId, 'e1', {} as any);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.dataInicioParcela).toBeUndefined();
    });

    it('lança NotFound quando despesa não existe', async () => {
      prisma.expense.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.update(tenantId, projectId, 'e404', {} as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('recalcula valorTotal quando valor e/ou quantidade mudam', async () => {
      await service.update(tenantId, projectId, 'e1', {
        valor: 75.5,
        quantidade: 4,
      } as any);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.valor).toBe(7550);
      expect(arg.data.quantidade).toBe(4);
      expect(arg.data.valorTotal).toBe(7550 * 4);
    });

    it('preserva valor antigo quando dto.valor é undefined', async () => {
      await service.update(tenantId, projectId, 'e1', {
        quantidade: 5,
      } as any);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.valor).toBe(existing.valor); // mantém valor antigo
      expect(arg.data.quantidade).toBe(5);
      expect(arg.data.valorTotal).toBe(existing.valor * 5);
    });
  });

  describe('payPlanned', () => {
    it('lança BadRequest quando status != PLANEJADO', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1',
        projectId,
        tenantId,
        status: 'PAGO',
        valor: 100,
        quantidade: 1,
        settledByExpenseId: null,
        deletedAt: null,
      });
      await expect(
        service.payPlanned(tenantId, projectId, 'e1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lança BadRequest quando despesa já foi liquidada', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1',
        projectId,
        tenantId,
        status: 'PLANEJADO',
        valor: 100,
        quantidade: 1,
        settledByExpenseId: 'paid-e2', // já liquidada
        deletedAt: null,
      });
      await expect(
        service.payPlanned(tenantId, projectId, 'e1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('remove', () => {
    it('soft-delete da despesa e das entradas do fluxo de caixa', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1',
        projectId,
        tenantId,
        deletedAt: null,
      });
      // $transaction com array de operações
      prisma.$transaction.mockImplementationOnce(async (ops: any) => {
        // Verifica que recebeu um array de 2 operações (cashFlowEntry + expense)
        expect(Array.isArray(ops)).toBe(true);
        expect(ops).toHaveLength(2);
        return [];
      });

      const result = await service.remove(tenantId, projectId, 'e1');
      expect(result).toEqual({ deleted: true });
    });

    it('lança NotFound quando despesa não existe', async () => {
      prisma.expense.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.remove(tenantId, projectId, 'e404'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
