import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';

type AnyFn = jest.Mock;

interface PrismaMock {
  project: { findFirst: AnyFn };
  expense: {
    findFirst: AnyFn;
    findMany: AnyFn;
    findUnique: AnyFn;
    create: AnyFn;
    update: AnyFn;
    updateMany: AnyFn;
  };
  creditCard: { findFirst: AnyFn };
  bankAccount: { findFirst: AnyFn };
  cashFlowEntry: {
    updateMany: AnyFn;
    createMany: AnyFn;
  };
  crossProjectSettlement: {
    upsert: AnyFn;
    deleteMany: AnyFn;
    findMany: AnyFn;
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
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const mock = {
    project: { findFirst: jest.fn() },
    expense: expenseMock,
    creditCard: { findFirst: jest.fn() },
    bankAccount: { findFirst: jest.fn() },
    cashFlowEntry: cashFlowMock,
    crossProjectSettlement: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
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
        ConciliacaoService,
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

  describe('parcelamento — datas geradas em UTC (regressão de timezone)', () => {
    it('PARCELADO mensal: 01/07 +1 = 01/08 (não 31/07) mesmo em local time BRT', async () => {
      // Repro: setMonth em local time com TZ=America/Sao_Paulo move 01/07Z → 31/07Z.
      // Bug original reportado: parcelas de 01/07/2026 em 3x apareciam em 01/07, 31/07, 31/08.
      // Esperado: 01/07, 01/08, 01/09.
      const expense = {
        id: 'e-parc',
        projectId,
        tenantId,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        categoriaMaoDeObra: null,
        roomId: null,
        valorTotal: 30000,
        formaPagamento: 'PARCELADO',
        dataPagamento: null,
        quantidadeParcela: 3,
        dataInicioParcela: new Date('2026-07-01T00:00:00.000Z'),
        status: 'PLANEJADO',
        settledByExpenseId: null,
        room: null,
      };
      prisma.expense.findUnique.mockResolvedValue(expense);

      let createdEntries: any[] = [];
      prisma.cashFlowEntry.createMany.mockImplementation(async ({ data }: any) => {
        createdEntries = data;
        return { count: data.length };
      });

      await (service as any).regenerateCashFlow('e-parc');

      const datas = createdEntries.map((e) => e.data.toISOString().slice(0, 10));
      expect(datas).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
    });

    it('PARCELADO começando em 31/05: clampa 30/06 (junho não tem 31) e segue 31/07', async () => {
      // Antes do clamp, setUTCMonth(31/05 → +1) overflowava pra 01/07.
      const expense = {
        id: 'e-31',
        projectId,
        tenantId,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        categoriaMaoDeObra: null,
        roomId: null,
        valorTotal: 30000,
        formaPagamento: 'PARCELADO',
        dataPagamento: null,
        quantidadeParcela: 3,
        dataInicioParcela: new Date('2026-05-31T00:00:00.000Z'),
        status: 'PLANEJADO',
        settledByExpenseId: null,
        room: null,
      };
      prisma.expense.findUnique.mockResolvedValue(expense);

      let createdEntries: any[] = [];
      prisma.cashFlowEntry.createMany.mockImplementation(async ({ data }: any) => {
        createdEntries = data;
        return { count: data.length };
      });

      await (service as any).regenerateCashFlow('e-31');

      const datas = createdEntries.map((e) => e.data.toISOString().slice(0, 10));
      expect(datas).toEqual(['2026-05-31', '2026-06-30', '2026-07-31']);
    });

    it('QUINZENAL: 18/05 + 7*15d = 31/08 (não 30/08) mesmo em local time BRT', async () => {
      const expense = {
        id: 'e-q',
        projectId,
        tenantId,
        tipoDespesa: 'MAO_DE_OBRA',
        categoriaMaoDeObra: 'EMPREITEIRO',
        roomId: null,
        valorTotal: 80000,
        formaPagamento: 'QUINZENAL',
        dataPagamento: null,
        quantidadeParcela: 9,
        dataInicioParcela: new Date('2026-05-18T00:00:00.000Z'),
        status: 'PLANEJADO',
        settledByExpenseId: null,
        room: null,
      };
      prisma.expense.findUnique.mockResolvedValue(expense);

      let createdEntries: any[] = [];
      prisma.cashFlowEntry.createMany.mockImplementation(async ({ data }: any) => {
        createdEntries = data;
        return { count: data.length };
      });

      await (service as any).regenerateCashFlow('e-q');

      const datas = createdEntries.map((e) => e.data.toISOString().slice(0, 10));
      expect(datas).toEqual([
        '2026-05-18', '2026-06-02', '2026-06-17',
        '2026-07-02', '2026-07-17', '2026-08-01',
        '2026-08-16', '2026-08-31', '2026-09-15',
      ]);
    });
  });

  describe('setParcelaStatus — pagamento por parcela (quinzenal)', () => {
    const baseQuinzenal = {
      id: 'e-q',
      projectId,
      tenantId,
      tipoDespesa: 'MAO_DE_OBRA',
      categoriaMaoDeObra: 'EMPREITEIRO',
      roomId: null,
      valorTotal: 80000,
      formaPagamento: 'QUINZENAL',
      dataPagamento: null,
      quantidadeParcela: 4,
      dataInicioParcela: new Date('2026-05-18T00:00:00.000Z'),
      status: 'PLANEJADO',
      paidParcelas: null,
      settledByExpenseId: null,
      room: null,
    };

    it('marca apenas a parcela 0 como paga, mantendo as demais planejadas', async () => {
      prisma.expense.findFirst.mockResolvedValue({ ...baseQuinzenal });
      let updateArg: any;
      prisma.expense.update.mockImplementation(async (arg: any) => {
        updateArg = arg;
        return { ...baseQuinzenal, ...arg.data, room: null };
      });
      let createdEntries: any[] = [];
      prisma.cashFlowEntry.createMany.mockImplementation(async ({ data }: any) => {
        createdEntries = data;
        return { count: data.length };
      });

      await service.setParcelaStatus(tenantId, projectId, 'e-q', 0, true);

      // Persiste paidParcelas=[0] e mantém status agregado PLANEJADO
      expect(updateArg.data.status).toBe('PLANEJADO');
      expect(updateArg.data.paidParcelas).toBe('[0]');
      // Fluxo de caixa: só a 1ª parcela PAGO
      const statuses = createdEntries.map((e) => e.status);
      expect(statuses).toEqual(['PAGO', 'PLANEJADO', 'PLANEJADO', 'PLANEJADO']);
    });

    it('quando todas as parcelas ficam pagas, status vira PAGO e paidParcelas é limpo', async () => {
      prisma.expense.findFirst.mockResolvedValue({ ...baseQuinzenal, paidParcelas: '[0,1,2]' });
      let updateArg: any;
      prisma.expense.update.mockImplementation(async (arg: any) => {
        updateArg = arg;
        return { ...baseQuinzenal, ...arg.data, room: null };
      });
      let createdEntries: any[] = [];
      prisma.cashFlowEntry.createMany.mockImplementation(async ({ data }: any) => {
        createdEntries = data;
        return { count: data.length };
      });

      await service.setParcelaStatus(tenantId, projectId, 'e-q', 3, true);

      expect(updateArg.data.status).toBe('PAGO');
      expect(updateArg.data.paidParcelas).toBeNull();
      expect(createdEntries.map((e) => e.status)).toEqual(['PAGO', 'PAGO', 'PAGO', 'PAGO']);
    });

    it('desmarcar uma parcela de despesa PAGA volta para PLANEJADO com as demais pagas', async () => {
      prisma.expense.findFirst.mockResolvedValue({ ...baseQuinzenal, status: 'PAGO', paidParcelas: null });
      let updateArg: any;
      prisma.expense.update.mockImplementation(async (arg: any) => {
        updateArg = arg;
        return { ...baseQuinzenal, ...arg.data, room: null };
      });
      let createdEntries: any[] = [];
      prisma.cashFlowEntry.createMany.mockImplementation(async ({ data }: any) => {
        createdEntries = data;
        return { count: data.length };
      });

      await service.setParcelaStatus(tenantId, projectId, 'e-q', 1, false);

      expect(updateArg.data.status).toBe('PLANEJADO');
      expect(updateArg.data.paidParcelas).toBe('[0,2,3]');
      expect(createdEntries.map((e) => e.status)).toEqual(['PAGO', 'PLANEJADO', 'PAGO', 'PAGO']);
    });

    it('rejeita índice de parcela fora do range', async () => {
      prisma.expense.findFirst.mockResolvedValue({ ...baseQuinzenal });
      await expect(
        service.setParcelaStatus(tenantId, projectId, 'e-q', 9, true),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejeita despesa não parcelada (A_VISTA)', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        ...baseQuinzenal,
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
      });
      await expect(
        service.setParcelaStatus(tenantId, projectId, 'e-q', 0, true),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('payPlanned — bloqueio com parcelas pagas', () => {
    it('rejeita liquidação total quando há parcelas pagas individualmente', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e-q',
        projectId,
        tenantId,
        formaPagamento: 'QUINZENAL',
        quantidadeParcela: 4,
        valor: 20000,
        quantidade: 1,
        status: 'PLANEJADO',
        paidParcelas: '[0]',
        settledByExpenseId: null,
      });
      await expect(
        service.payPlanned(tenantId, projectId, 'e-q', {} as any),
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
        // Verifica que recebeu um array de operações (cashFlowEntry + expense + clearLinks)
        expect(Array.isArray(ops)).toBe(true);
        expect(ops.length).toBeGreaterThanOrEqual(2);
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

  describe('resolveLinks — vínculos manuais (cartão / conta / cross-project)', () => {
    it('create com creditCardId resolve cardLast4 automaticamente', async () => {
      prisma.creditCard.findFirst.mockResolvedValue({ last4: '1234' });
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 100,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        creditCardId: 'card-99',
      } as any);

      const arg = prisma.expense.create.mock.calls[0]![0];
      expect(arg.data.cardLast4).toBe('1234');
      expect(prisma.creditCard.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'card-99', tenantId }),
        }),
      );
    });

    it('create com bankAccountId resolve bankLast4 automaticamente', async () => {
      prisma.bankAccount.findFirst.mockResolvedValue({ last4: '7890' });
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 100,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        bankAccountId: 'acc-1',
      } as any);

      const arg = prisma.expense.create.mock.calls[0]![0];
      expect(arg.data.bankLast4).toBe('7890');
    });

    it('create com linkedExpenseId de outro projeto é aceito', async () => {
      prisma.expense.findFirst.mockResolvedValue({ projectId: 'other-project' });
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 100,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        linkedExpenseId: 'target-1',
      } as any);

      const arg = prisma.expense.create.mock.calls[0]![0];
      expect(arg.data.linkedExpenseId).toBe('target-1');
    });

    it('create rejeita linkedExpenseId do MESMO projeto', async () => {
      prisma.expense.findFirst.mockResolvedValue({ projectId }); // mesmo projeto
      await expect(
        service.create(tenantId, projectId, {
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 100,
          quantidade: 1,
          formaPagamento: 'A_VISTA',
          status: 'PAGO',
          linkedExpenseId: 'self',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create rejeita creditCardId inválido', async () => {
      prisma.creditCard.findFirst.mockResolvedValue(null);
      await expect(
        service.create(tenantId, projectId, {
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 100,
          quantidade: 1,
          formaPagamento: 'A_VISTA',
          status: 'PAGO',
          creditCardId: 'card-fake',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update com creditCardId="" limpa cardLast4', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1', projectId, tenantId, valor: 1000, quantidade: 1, deletedAt: null,
      });
      prisma.expense.update.mockImplementation(async ({ data }: any) => data);

      await service.update(tenantId, projectId, 'e1', { creditCardId: '' } as any);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.cardLast4).toBeNull();
    });
  });

  describe('findCrossProject', () => {
    it('retorna apenas despesas de OUTROS projetos do mesmo tenant', async () => {
      prisma.expense.findMany.mockResolvedValue([
        { id: 'x1', projectId: 'other-1', titulo: 'Mármore', valorTotal: 5000 },
      ]);
      await service.findCrossProject(tenantId, projectId, {});
      const arg = prisma.expense.findMany.mock.calls[0]![0];
      expect(arg.where.tenantId).toBe(tenantId);
      expect(arg.where.NOT).toEqual({ projectId });
    });

    it('aplica busca textual (title / fornecedor) e limit', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      await service.findCrossProject(tenantId, projectId, { search: 'polo', limit: 50 });
      const arg = prisma.expense.findMany.mock.calls[0]![0];
      expect(arg.where.OR).toEqual([
        { titulo: { contains: 'polo' } },
        { fornecedor: { contains: 'polo' } },
      ]);
      expect(arg.take).toBe(50);
    });

    it('limit é clampado entre 1 e 2000', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      await service.findCrossProject(tenantId, projectId, { limit: 9999 });
      const arg = prisma.expense.findMany.mock.calls[0]![0];
      expect(arg.take).toBe(2000);
    });
  });

  describe('linkCrossProject / unlinkCrossProject', () => {
    it('link rejeita quando alvo está no MESMO projeto', async () => {
      prisma.expense.findFirst
        .mockResolvedValueOnce({ id: 'src', projectId, tenantId, deletedAt: null })
        .mockResolvedValueOnce({ projectId }); // mesmo projeto

      await expect(
        service.linkCrossProject(tenantId, projectId, 'src', 'target'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('link salva linkedExpenseId quando alvo é de outro projeto', async () => {
      prisma.expense.findFirst
        .mockResolvedValueOnce({ id: 'src', projectId, tenantId, deletedAt: null })
        .mockResolvedValueOnce({ projectId: 'other-project' });
      prisma.expense.update.mockResolvedValue({ id: 'src', linkedExpenseId: 'target' });

      await service.linkCrossProject(tenantId, projectId, 'src', 'target');
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.linkedExpenseId).toBe('target');
    });

    it('unlink seta linkedExpenseId=null', async () => {
      prisma.expense.findFirst.mockResolvedValueOnce({ id: 'src', projectId, tenantId, deletedAt: null });
      prisma.expense.update.mockResolvedValue({ id: 'src', linkedExpenseId: null });

      await service.unlinkCrossProject(tenantId, projectId, 'src');
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.linkedExpenseId).toBeNull();
    });

    it('link lança NotFound se a despesa de origem não existe', async () => {
      prisma.expense.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.linkCrossProject(tenantId, projectId, 'ghost', 'target'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
