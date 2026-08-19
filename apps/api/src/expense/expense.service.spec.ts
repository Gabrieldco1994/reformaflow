import { TEST_OWNER_REQUESTER } from '../test-utils/acl-requester-test-helper';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { withAclRequester } from '../test-utils/acl-requester-test-helper';

type AnyFn = jest.Mock;

interface PrismaMock {
  project: { findFirst: AnyFn; findMany: AnyFn };
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
    count: AnyFn;
  };
  rateioAllocation: {
    findFirst: AnyFn;
    findUnique: AnyFn;
    findMany: AnyFn;
    upsert: AnyFn;
    delete: AnyFn;
    count: AnyFn;
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
    findMany: jest.fn().mockResolvedValue([]),
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
      count: jest.fn().mockResolvedValue(0),
    },
    rateioAllocation: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
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
      deletedAt: null,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        ConciliacaoService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = withAclRequester(module.get<ExpenseService>(ExpenseService), {});
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
      } as any, null, undefined, TEST_OWNER_REQUESTER);

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

    it('stamps createdByUserId when provided', async () => {
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 50,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      } as any, 'user-42');

      expect(prisma.expense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdByUserId: 'user-42' }),
        }),
      );
    });

    it('defaults createdByUserId to null when omitted', async () => {
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 50,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      } as any);

      expect(prisma.expense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdByUserId: null }),
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

    it('persiste dataCompra (competência) quando informada; null quando ausente', async () => {
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 50,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        dataPagamento: '2026-08-05',
        dataCompra: '2026-06-17',
        status: 'PAGO',
      } as any);

      const arg = prisma.expense.create.mock.calls[0]![0];
      expect(arg.data.dataCompra).toBeInstanceOf(Date);
      expect(arg.data.dataCompra.toISOString().slice(0, 10)).toBe('2026-06-17');

      prisma.expense.create.mockClear();
      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 50,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      } as any);
      const arg2 = prisma.expense.create.mock.calls[0]![0];
      expect(arg2.data.dataCompra).toBeNull();
    });

    it('removes the expense if cash-flow generation fails', async () => {
      const created = { id: 'e1', linkedExpenseId: 'existing-expense' };
      prisma.expense.create.mockResolvedValue(created);
      prisma.expense.findUnique.mockResolvedValue({
        ...created,
        projectId,
        tenantId,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        categoriaMaoDeObra: null,
        roomId: null,
        valorTotal: 5000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-07-22'),
        quantidadeParcela: null,
        dataInicioParcela: null,
        status: 'PAGO',
        settledByExpenseId: null,
        room: null,
      });
      prisma.$transaction.mockRejectedValueOnce(new Error('cash flow failed'));
      prisma.expense.findFirst.mockResolvedValue(created);
      prisma.expense.findMany.mockResolvedValue([]);

      await expect(
        service.create(tenantId, projectId, {
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 50,
          quantidade: 1,
          formaPagamento: 'A_VISTA',
          status: 'PAGO',
        } as any, null, undefined, TEST_OWNER_REQUESTER),
      ).rejects.toThrow('cash flow failed');

      expect(prisma.expense.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'e1',
            tenantId,
            projectId,
          }),
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('creates expense with origin="none" when accountId and creditCardId are null', async () => {
      const created = { id: 'e1', valor: 5000, quantidade: 1, valorTotal: 5000 };
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
        origin: 'none',
        accountId: null,
      });

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 50,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PLANEJADO',
        creditCardId: undefined,
        bankAccountId: undefined,
      } as any, null, undefined, TEST_OWNER_REQUESTER);

      expect(prisma.expense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            origin: 'none',
            accountId: undefined,
            cardLast4: undefined,
            bankLast4: undefined,
          }),
        }),
      );
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
      } as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.dataPagamento).toBeNull();
    });

    it('quando dataPagamento é undefined no DTO, preserva (não atualiza)', async () => {
      await service.update(tenantId, projectId, 'e1', {} as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      // Em update, undefined = "não atualiza" — passamos undefined para o Prisma.
      expect(arg.data.dataPagamento).toBeUndefined();
    });

    it('quando dataPagamento é string ISO, converte para Date', async () => {
      await service.update(tenantId, projectId, 'e1', {
        dataPagamento: '2025-06-30',
      } as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.dataPagamento).toBeInstanceOf(Date);
      expect((arg.data.dataPagamento as Date).toISOString().slice(0, 10)).toBe('2025-06-30');
    });

    it('mesmo comportamento para dataInicioParcela: null limpa', async () => {
      await service.update(tenantId, projectId, 'e1', {
        dataInicioParcela: null,
      } as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.dataInicioParcela).toBeNull();
    });

    it('mesmo comportamento para dataInicioParcela: undefined preserva', async () => {
      await service.update(tenantId, projectId, 'e1', {} as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.dataInicioParcela).toBeUndefined();
    });

    it('lança NotFound quando despesa não existe', async () => {
      prisma.expense.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.update(tenantId, projectId, 'e404', {} as any, TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('recalcula valorTotal quando valor e/ou quantidade mudam', async () => {
      await service.update(tenantId, projectId, 'e1', {
        valor: 75.5,
        quantidade: 4,
      } as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.valor).toBe(7550);
      expect(arg.data.quantidade).toBe(4);
      expect(arg.data.valorTotal).toBe(7550 * 4);
    });

    it('preserva valor antigo quando dto.valor é undefined', async () => {
      await service.update(tenantId, projectId, 'e1', {
        quantidade: 5,
      } as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.valor).toBe(existing.valor); // mantém valor antigo
      expect(arg.data.quantidade).toBe(5);
      expect(arg.data.valorTotal).toBe(existing.valor * 5);
    });
  });

  describe('update — sincronização do par vinculado (canônico↔espelho)', () => {
    it('editar o espelho propaga data/valor para o canônico', async () => {
      // update() existing = espelho 'mir'; sync source = 'mir'; sync target = 'canon'
      const linkedRows = [
        {
          id: 'mir',
          projectId,
          tenantId,
          deletedAt: null,
          linkedExpenseId: 'canon',
          project: { id: projectId, tenantId, type: 'REFORMA', deletedAt: null },
        },
        {
          id: 'canon',
          projectId,
          tenantId,
          deletedAt: null,
          linkedExpenseId: null,
          project: { id: projectId, tenantId, type: 'REFORMA', deletedAt: null },
        },
      ];
      prisma.expense.findFirst
        .mockResolvedValueOnce({
          id: 'mir', projectId, tenantId, deletedAt: null, valor: 10000, quantidade: 1, linkedExpenseId: 'canon',
        })
        .mockResolvedValueOnce({ id: 'mir', linkedExpenseId: 'canon' })
        .mockResolvedValueOnce({ id: 'canon' });
      prisma.expense.findMany
        .mockResolvedValueOnce(linkedRows)
        .mockResolvedValueOnce(linkedRows)
        .mockResolvedValue([]); // nenhum espelho aponta p/ 'mir'
      prisma.crossProjectSettlement.count.mockResolvedValue(0);
      prisma.expense.update.mockImplementation(async ({ data, where }: any) => ({ id: where.id, ...data }));
      prisma.expense.findUnique
        .mockResolvedValueOnce(null) // regenerateCashFlow do principal (early return)
        .mockResolvedValueOnce({ valor: 20000, quantidade: 1 }) // counterpart p/ valorTotal
        .mockResolvedValue(null); // regenerateCashFlow do counterpart

      await service.update(tenantId, projectId, 'mir', {
        valor: 150,
        dataPagamento: '2026-06-17',
      } as any, TEST_OWNER_REQUESTER);

      const counterpart = prisma.expense.update.mock.calls.find((c: any) => c[0].where.id === 'canon');
      expect(counterpart).toBeDefined();
      expect(counterpart![0].data.valor).toBe(15000);
      expect(counterpart![0].data.valorTotal).toBe(15000);
      expect(counterpart![0].data.dataPagamento).toBeInstanceOf(Date);
      expect((counterpart![0].data.dataPagamento as Date).toISOString().slice(0, 10)).toBe('2026-06-17');
    });

    it('NÃO sincroniza quando o par é de conciliação (CrossProjectSettlement)', async () => {
      const linkedRows = [
        {
          id: 'mir',
          projectId,
          tenantId,
          deletedAt: null,
          linkedExpenseId: 'canon',
          project: { id: projectId, tenantId, type: 'REFORMA', deletedAt: null },
        },
        {
          id: 'canon',
          projectId,
          tenantId,
          deletedAt: null,
          linkedExpenseId: null,
          project: { id: projectId, tenantId, type: 'REFORMA', deletedAt: null },
        },
      ];
      prisma.expense.findFirst.mockResolvedValue({
        id: 'mir', projectId, tenantId, deletedAt: null, valor: 10000, quantidade: 1, linkedExpenseId: 'canon',
      });
      prisma.expense.findMany
        .mockResolvedValueOnce(linkedRows)
        .mockResolvedValueOnce(linkedRows)
        .mockResolvedValue([]);
      prisma.crossProjectSettlement.count.mockResolvedValue(1); // tem settlement
      prisma.expense.update.mockImplementation(async ({ data, where }: any) => ({ id: where.id, ...data }));
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.update(tenantId, projectId, 'mir', { valor: 150 } as any, TEST_OWNER_REQUESTER);

      // Apenas a própria despesa é atualizada; o canônico NÃO é tocado.
      const counterpart = prisma.expense.update.mock.calls.find((c: any) => c[0].where.id === 'canon');
      expect(counterpart).toBeUndefined();
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

  describe('markPaidInPlace (#294 — sync do espelho do financiamento)', () => {
    const dataPagamento = new Date('2026-02-10T00:00:00.000Z');

    it('marca a despesa PAGO in-place (sem clone) e regenera o cashflow com status PAGO', async () => {
      const expense = {
        id: 'fin-espelho-1',
        projectId,
        tenantId,
        tipoDespesa: 'FINANCIAMENTO',
        categoriaMaoDeObra: null,
        roomId: null,
        valorTotal: 340_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: null,
        quantidadeParcela: null,
        dataInicioParcela: null,
        status: 'PLANEJADO',
        settledByExpenseId: null,
        deletedAt: null,
        room: null,
      };
      prisma.expense.findFirst.mockResolvedValue(expense);
      prisma.expense.findUnique.mockResolvedValue(expense);
      // regenerateCashFlow relê a despesa via findUnique — simula o update real
      // mutando o mesmo objeto que o mock devolve (senão o findUnique ainda veria
      // status PLANEJADO por trás do update mockado).
      prisma.expense.update.mockImplementation(async ({ data }: any) => {
        Object.assign(expense, data);
        return expense;
      });

      let createdEntries: any[] = [];
      prisma.cashFlowEntry.createMany.mockImplementation(async ({ data }: any) => {
        createdEntries = data;
        return { count: data.length };
      });

      await service.markPaidInPlace(tenantId, 'fin-espelho-1', dataPagamento, prisma as any);

      expect(prisma.expense.update).toHaveBeenCalledWith({
        where: { id: 'fin-espelho-1' },
        data: { status: 'PAGO', dataPagamento },
      });
      expect(createdEntries).toHaveLength(1);
      expect(createdEntries[0].status).toBe('PAGO');
    });

    it('não é chamado (no-op) quando a despesa já é alvo de rateio — caminho PESSOAL→financiamento (#276) governa', async () => {
      prisma.rateioAllocation.findUnique.mockResolvedValue({
        targetExpenseId: 'fin-espelho-1',
        sourceExpenseId: 'src-pessoal',
      });

      await service.markPaidInPlace(tenantId, 'fin-espelho-1', dataPagamento, prisma as any);

      expect(prisma.expense.findFirst).not.toHaveBeenCalled();
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });

    it('não quebra quando a despesa não existe (id inválido/tenant errado)', async () => {
      prisma.expense.findFirst.mockResolvedValue(null);

      await expect(
        service.markPaidInPlace(tenantId, 'inexistente', dataPagamento, prisma as any),
      ).resolves.toBeUndefined();
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });

    it('idempotente: chamar 2× não duplica cashFlowEntry (regenerateCashFlow soft-deleta antes de recriar)', async () => {
      const expense = {
        id: 'fin-espelho-1',
        projectId,
        tenantId,
        tipoDespesa: 'FINANCIAMENTO',
        categoriaMaoDeObra: null,
        roomId: null,
        valorTotal: 340_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: null,
        quantidadeParcela: null,
        dataInicioParcela: null,
        status: 'PLANEJADO',
        settledByExpenseId: null,
        deletedAt: null,
        room: null,
      };
      prisma.expense.findFirst.mockResolvedValue(expense);
      prisma.expense.findUnique.mockResolvedValue(expense);

      await service.markPaidInPlace(tenantId, 'fin-espelho-1', dataPagamento, prisma as any);
      await service.markPaidInPlace(tenantId, 'fin-espelho-1', dataPagamento, prisma as any);

      // Cada chamada soft-deleta as entries antigas antes de recriar — 2 chamadas
      // devem gerar 2 rodadas de updateMany(soft-delete) + createMany, nunca acúmulo.
      expect(prisma.cashFlowEntry.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.cashFlowEntry.createMany).toHaveBeenCalledTimes(2);
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

    it('cashflow usa a data efetiva sem alterar os demais índices', async () => {
      const expense = {
        id: 'e-override',
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
        installmentDateOverrides: '{"1":"2026-09-20"}',
        status: 'PAGO',
        paidParcelas: null,
        settledByExpenseId: null,
        room: null,
      };
      prisma.expense.findUnique.mockResolvedValue(expense);
      let createdEntries: any[] = [];
      prisma.cashFlowEntry.createMany.mockImplementation(async ({ data }: any) => {
        createdEntries = data;
        return { count: data.length };
      });

      await (service as any).regenerateCashFlow(expense.id);

      expect(createdEntries.map((entry) => ({
        data: entry.data.toISOString().slice(0, 10),
        status: entry.status,
        valor: entry.valor,
      }))).toEqual([
        { data: '2026-07-01', status: 'PAGO', valor: 10000 },
        { data: '2026-09-20', status: 'PAGO', valor: 10000 },
        { data: '2026-09-01', status: 'PAGO', valor: 10000 },
      ]);
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

    it('preserva createdByUserId do planejado no clone pago', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e-planned',
        projectId,
        tenantId,
        status: 'PLANEJADO',
        valor: 10000,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        paidParcelas: null,
        quantidadeParcela: null,
        settledByExpenseId: null,
        createdByUserId: 'creator-1',
      });
      prisma.expense.create.mockResolvedValue({ id: 'e-paid' });
      prisma.expense.update.mockResolvedValue({});
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.payPlanned(tenantId, projectId, 'e-planned', {} as any);

      expect(prisma.expense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdByUserId: 'creator-1' }),
        }),
      );
    });
  });

  describe('conciliarParcela — realValor default (P4: valorTotal do espelho)', () => {
    it('sem realValor, usa o valorTotal do ESPELHO (source), não o slice da parcela', async () => {
      // P4/I10: o espelho representa o pagamento efetivo; o override do alvo deve
      // CASAR com o valorTotal do espelho no caixa PESSOAL.
      prisma.expense.findFirst.mockResolvedValue({
        id: 'src-1',
        projectId,
        tenantId,
        deletedAt: null,
        valorTotal: 290934,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 6,
        dataPagamento: null,
        dataInicioParcela: new Date('2026-06-10T00:00:00Z'),
      });
      const spy = jest
        .spyOn(service['conciliacao'], 'settleTargetParcela')
        .mockResolvedValue(undefined as never);

      await service.conciliarParcela(tenantId, projectId, 'src-1', {
        targetExpenseId: 'tgt-1',
        parcelaIndex: 0,
        // realValor OMITIDO de propósito (web não envia)
      }, TEST_OWNER_REQUESTER);

      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][1];
      expect(arg.realValor).toBe(290934); // valorTotal do espelho
      spy.mockRestore();
    });

    it('respeita realValor explícito quando informado', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'src-2',
        projectId,
        tenantId,
        deletedAt: null,
        valorTotal: 290934,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 6,
        dataPagamento: null,
        dataInicioParcela: new Date('2026-06-10T00:00:00Z'),
      });
      const spy = jest
        .spyOn(service['conciliacao'], 'settleTargetParcela')
        .mockResolvedValue(undefined as never);

      await service.conciliarParcela(tenantId, projectId, 'src-2', {
        targetExpenseId: 'tgt-2',
        parcelaIndex: 1,
        realValor: 50000,
      }, TEST_OWNER_REQUESTER);

      expect(spy.mock.calls[0][1].realValor).toBe(50000);
      spy.mockRestore();
    });
  });

  describe('remove', () => {
    it('soft-delete da despesa e das entradas do fluxo de caixa', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1',
        projectId,
        tenantId,
        deletedAt: null,
        linkedExpenseId: null,
      });
      prisma.expense.findMany.mockResolvedValue([]); // sem espelhos
      prisma.crossProjectSettlement.count.mockResolvedValue(0);
      const result = await service.remove(tenantId, projectId, 'e1', TEST_OWNER_REQUESTER);
      expect(result).toEqual({ deleted: true, count: 1 });
    });

    it('cascateia o par vinculado (espelho -> canônico) quando não há conciliação', async () => {
      // remove o espelho 'mir' que aponta para o canônico 'canon'
      prisma.expense.findFirst
        .mockResolvedValueOnce({ id: 'mir', projectId, tenantId, deletedAt: null, linkedExpenseId: 'canon' }) // a própria
        .mockResolvedValueOnce({ id: 'canon' }); // o alvo
      prisma.expense.findMany
        .mockResolvedValueOnce([
          {
            id: 'mir', projectId, tenantId, linkedExpenseId: 'canon',
            project: { id: projectId, tenantId, type: 'PESSOAL', deletedAt: null },
          },
          {
            id: 'canon', projectId: 'other-project', tenantId, linkedExpenseId: null,
            project: { id: 'other-project', tenantId, type: 'REFORMA', deletedAt: null },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'mir', projectId, tenantId, linkedExpenseId: 'canon',
            project: { id: projectId, tenantId, type: 'PESSOAL', deletedAt: null },
          },
          {
            id: 'canon', projectId: 'other-project', tenantId, linkedExpenseId: null,
            project: { id: 'other-project', tenantId, type: 'REFORMA', deletedAt: null },
          },
        ])
        .mockResolvedValue([]); // sem espelhos apontando para 'mir'
      prisma.crossProjectSettlement.count.mockResolvedValue(0);
      let deletedIds: string[] = [];
      prisma.expense.updateMany.mockImplementation((args: any) => {
        if (args?.data?.deletedAt && args?.where?.id?.in) deletedIds = args.where.id.in;
        return Promise.resolve({ count: 0 });
      });

      const result = await service.remove(tenantId, projectId, 'mir', TEST_OWNER_REQUESTER);
      expect(result.count).toBe(2);
      expect(deletedIds.sort()).toEqual(['canon', 'mir']);
    });

    it('NÃO cascateia quando há conciliação (CrossProjectSettlement)', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'src', projectId, tenantId, deletedAt: null, linkedExpenseId: 'planned',
      });
      prisma.expense.findMany
        .mockResolvedValueOnce([
          {
            id: 'src', projectId, tenantId, linkedExpenseId: 'planned',
            project: { id: projectId, tenantId, type: 'PESSOAL', deletedAt: null },
          },
          {
            id: 'planned', projectId: 'other-project', tenantId, linkedExpenseId: null,
            project: { id: 'other-project', tenantId, type: 'REFORMA', deletedAt: null },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'src', projectId, tenantId, linkedExpenseId: 'planned',
            project: { id: projectId, tenantId, type: 'PESSOAL', deletedAt: null },
          },
          {
            id: 'planned', projectId: 'other-project', tenantId, linkedExpenseId: null,
            project: { id: 'other-project', tenantId, type: 'REFORMA', deletedAt: null },
          },
        ])
        .mockResolvedValue([]);
      prisma.crossProjectSettlement.count.mockResolvedValue(1); // tem settlement
      const result = await service.remove(tenantId, projectId, 'src', TEST_OWNER_REQUESTER);
      expect(result.count).toBe(1); // só a própria, não cascateia o 'planned'
    });

    it('lança NotFound quando despesa não existe', async () => {
      prisma.expense.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.remove(tenantId, projectId, 'e404', TEST_OWNER_REQUESTER),
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
      prisma.expense.findFirst.mockResolvedValue({
        projectId: 'other-project',
        project: { id: 'other-project', tenantId, type: 'REFORMA' },
      });
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 100,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        linkedExpenseId: 'target-1',
      } as any, null, undefined, TEST_OWNER_REQUESTER);

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
        } as any, null, undefined, TEST_OWNER_REQUESTER),
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
        } as any, null, undefined, TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update com creditCardId="" limpa cardLast4', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1', projectId, tenantId, valor: 1000, quantidade: 1, deletedAt: null,
      });
      prisma.expense.update.mockImplementation(async ({ data }: any) => data);

      await service.update(tenantId, projectId, 'e1', { creditCardId: '' } as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.cardLast4).toBeNull();
    });
  });

  describe('resolveLinks — "cartão paga cartão" (settlesInvoiceKey)', () => {
    it('create com settlesInvoiceCardId + settlesInvoiceDueMonth monta settlesInvoiceKey', async () => {
      prisma.creditCard.findFirst.mockResolvedValue({
        last4: '3541',
        project: { id: projectId, tenantId, type: 'REFORMA' },
      });
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      prisma.expense.findUnique.mockResolvedValue(null);

      await service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 100,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        settlesInvoiceCardId: 'card-nubank',
        settlesInvoiceDueMonth: '2026-09',
      } as any, null, undefined, TEST_OWNER_REQUESTER);

      const arg = prisma.expense.create.mock.calls[0]![0];
      expect(arg.data.settlesInvoiceKey).toBe('3541:2026-09');
    });

    it('rejeita cartão de projeto oculto antes de criar settlesInvoiceKey', async () => {
      prisma.creditCard.findFirst.mockResolvedValue({
        last4: '3541',
        project: { id: 'hidden-project', tenantId, type: 'REFORMA' },
      });

      await expect(service.create(tenantId, projectId, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 100,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        settlesInvoiceCardId: 'card-hidden',
        settlesInvoiceDueMonth: '2026-09',
      } as any, null, undefined, {
        role: 'USER',
        allowedProjects: [projectId],
        allowedModules: ['expenses'],
      })).rejects.toThrow('Cartão da fatura quitada não encontrado neste tenant');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.expense.create).not.toHaveBeenCalled();
    });

    it('create rejeita settlesInvoiceCardId sem settlesInvoiceDueMonth', async () => {
      prisma.creditCard.findFirst.mockResolvedValue({
        last4: '3541',
        project: { id: projectId, tenantId, type: 'REFORMA' },
      });
      await expect(
        service.create(tenantId, projectId, {
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 100,
          quantidade: 1,
          formaPagamento: 'A_VISTA',
          status: 'PAGO',
          settlesInvoiceCardId: 'card-nubank',
        } as any, null, undefined, TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create rejeita settlesInvoiceCardId inválido', async () => {
      prisma.creditCard.findFirst.mockResolvedValue(null);
      await expect(
        service.create(tenantId, projectId, {
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 100,
          quantidade: 1,
          formaPagamento: 'A_VISTA',
          status: 'PAGO',
          settlesInvoiceCardId: 'card-fake',
          settlesInvoiceDueMonth: '2026-09',
        } as any, null, undefined, TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update com settlesInvoiceCardId="" limpa settlesInvoiceKey', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1', projectId, tenantId, valor: 1000, quantidade: 1, deletedAt: null,
      });
      prisma.expense.update.mockImplementation(async ({ data }: any) => data);

      await service.update(tenantId, projectId, 'e1', { settlesInvoiceCardId: '' } as any, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.settlesInvoiceKey).toBeNull();
    });
  });

  describe('findCrossProject', () => {
    it('retorna apenas despesas de OUTROS projetos do mesmo tenant', async () => {
      prisma.expense.findMany.mockResolvedValue([
        { id: 'x1', projectId: 'other-1', titulo: 'Mármore', valorTotal: 5000 },
      ]);
      await service.findCrossProject(tenantId, projectId, {}, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.findMany.mock.calls[0]![0];
      expect(arg.where.tenantId).toBe(tenantId);
      expect(arg.where.NOT).toEqual({ projectId });
    });

    it('aplica busca textual (title / fornecedor) e limit', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      await service.findCrossProject(tenantId, projectId, { search: 'polo', limit: 50 }, TEST_OWNER_REQUESTER);
      const arg = prisma.expense.findMany.mock.calls[0]![0];
      expect(arg.where.OR).toEqual([
        { titulo: { contains: 'polo' } },
        { fornecedor: { contains: 'polo' } },
      ]);
      expect(arg.take).toBe(50);
    });

    it('limit é clampado entre 1 e 2000', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      await service.findCrossProject(tenantId, projectId, { limit: 9999 }, TEST_OWNER_REQUESTER);
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
        service.linkCrossProject(tenantId, projectId, 'src', 'target', TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('link salva linkedExpenseId quando alvo é de outro projeto', async () => {
      prisma.expense.findFirst
        .mockResolvedValueOnce({ id: 'src', projectId, tenantId, deletedAt: null })
        .mockResolvedValueOnce({
          projectId: 'other-project',
          project: { id: 'other-project', tenantId, type: 'REFORMA' },
        });
      prisma.expense.update.mockResolvedValue({ id: 'src', linkedExpenseId: 'target' });

      await service.linkCrossProject(tenantId, projectId, 'src', 'target', TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.linkedExpenseId).toBe('target');
    });

    it('unlink seta linkedExpenseId=null', async () => {
      prisma.expense.findFirst.mockResolvedValueOnce({ id: 'src', projectId, tenantId, deletedAt: null });
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'src', projectId, tenantId, linkedExpenseId: null,
          project: { id: projectId, tenantId, type: 'PESSOAL', deletedAt: null },
        },
      ]);
      prisma.expense.update.mockResolvedValue({ id: 'src', linkedExpenseId: null });

      await service.unlinkCrossProject(tenantId, projectId, 'src', TEST_OWNER_REQUESTER);
      const arg = prisma.expense.update.mock.calls[0]![0];
      expect(arg.data.linkedExpenseId).toBeNull();
    });

    it('link lança NotFound se a despesa de origem não existe', async () => {
      prisma.expense.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.linkCrossProject(tenantId, projectId, 'ghost', 'target', TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createRecorrente', () => {
    beforeEach(() => {
      // create() usa expense.create + regenerateCashFlow (findUnique). Devolve um id
      // único por chamada e um expense mínimo para o cashflow não quebrar.
      let n = 0;
      prisma.expense.create.mockImplementation(async () => ({ id: `rec-${++n}`, valorTotal: 50000 }));
      prisma.expense.findUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        projectId,
        tenantId,
        tipoDespesa: 'MORADIA',
        categoriaMaoDeObra: null,
        roomId: null,
        valor: 50000,
        quantidade: 1,
        valorTotal: 50000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-01-10'),
        quantidadeParcela: null,
        dataInicioParcela: null,
        status: 'PLANEJADO',
        cardLast4: null,
        bankLast4: null,
        settledByExpenseId: null,
        room: null,
      }));
    });

    it('MENSAL gera uma despesa planejada por mês (início e fim inclusivos)', async () => {
      const res = await service.createRecorrente(tenantId, projectId, {
        tipoDespesa: 'MORADIA',
        valor: 500,
        frequencia: 'MENSAL',
        dataInicio: '2026-01-10',
        dataFim: '2026-04-10',
      } as any, null, TEST_OWNER_REQUESTER);

      expect(res.count).toBe(4); // jan, fev, mar, abr
      expect(res.ids).toHaveLength(4);
      // cada ocorrência é A_VISTA/PLANEJADO
      const firstCall = prisma.expense.create.mock.calls[0]![0];
      expect(firstCall.data.formaPagamento).toBe('A_VISTA');
      expect(firstCall.data.status).toBe('PLANEJADO');
      expect(firstCall.data.valor).toBe(50000); // 500 reais em centavos
    });

    it('QUINZENAL gera ocorrências a cada 15 dias', async () => {
      const res = await service.createRecorrente(tenantId, projectId, {
        tipoDespesa: 'MORADIA',
        valor: 300,
        frequencia: 'QUINZENAL',
        dataInicio: '2026-01-01',
        dataFim: '2026-02-15',
      } as any, null, TEST_OWNER_REQUESTER);
      expect(res.count).toBe(4); // 01/01, 16/01, 31/01, 15/02
    });

    it('rejeita frequência inválida', async () => {
      await expect(
        service.createRecorrente(tenantId, projectId, {
          tipoDespesa: 'MORADIA',
          valor: 500,
          frequencia: 'SEMANAL',
          dataInicio: '2026-01-10',
          dataFim: '2026-04-10',
        } as any, null, TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejeita período com fim antes do início', async () => {
      await expect(
        service.createRecorrente(tenantId, projectId, {
          tipoDespesa: 'MORADIA',
          valor: 500,
          frequencia: 'MENSAL',
          dataInicio: '2026-04-10',
          dataFim: '2026-01-10',
        } as any, null, TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('não cria nada quando o projeto não pertence ao tenant', async () => {
      prisma.project.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.createRecorrente(tenantId, projectId, {
          tipoDespesa: 'MORADIA',
          valor: 500,
          frequencia: 'MENSAL',
          dataInicio: '2026-01-10',
          dataFim: '2026-04-10',
        } as any, null, TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.expense.create).not.toHaveBeenCalled();
    });

    it('cross-project: gera par canônica(obra) + espelho(pessoal) por ocorrência', async () => {
      // validateProject(pessoal) na entrada, depois validação da obra, depois
      // validateProject dentro de cada create (obra e pessoal).
      prisma.project.findFirst.mockImplementation(async ({ where }: any) => {
        if (where.id === 'obra-1') return { id: 'obra-1', tenantId, type: 'REFORMA', deletedAt: null };
        return { id: where.id, tenantId, type: 'PESSOAL', deletedAt: null };
      });
      // linkedExpenseId aponta para a canônica (outro projeto) — resolveLinks ok.
      prisma.expense.findFirst.mockResolvedValue({
        projectId: 'obra-1',
        project: { id: 'obra-1', tenantId, type: 'REFORMA' },
      });
      prisma.bankAccount.findFirst.mockResolvedValue({ last4: '4321' });

      const res = await service.createRecorrente(tenantId, projectId, {
        tipoDespesa: 'MAO_DE_OBRA',
        valor: 2000,
        frequencia: 'MENSAL',
        dataInicio: '2026-01-05',
        dataFim: '2026-03-05',
        obraProjectId: 'obra-1',
        bankAccountId: 'acc-1',
      } as any, null, TEST_OWNER_REQUESTER);

      expect(res.count).toBe(3); // 3 ocorrências
      expect(res.crossProject).toBe(true);
      // 2 creates por ocorrência (canônica + espelho) = 6
      expect(prisma.expense.create).toHaveBeenCalledTimes(6);
      // o espelho carrega o linkedExpenseId da canônica
      const espelhoCall = prisma.expense.create.mock.calls[1]![0];
      expect(espelhoCall.data.linkedExpenseId).toBeTruthy();
      expect(espelhoCall.data.status).toBe('PLANEJADO');
    });

    it('cross-project: rejeita obra do tipo PESSOAL', async () => {
      prisma.project.findFirst.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        tenantId,
        type: 'PESSOAL',
        deletedAt: null,
      }));
      await expect(
        service.createRecorrente(tenantId, projectId, {
          tipoDespesa: 'MORADIA',
          valor: 500,
          frequencia: 'MENSAL',
          dataInicio: '2026-01-10',
          dataFim: '2026-02-10',
          obraProjectId: 'outro-pessoal',
        } as any, null, TEST_OWNER_REQUESTER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
