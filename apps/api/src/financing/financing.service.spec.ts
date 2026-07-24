import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FinancingService,
  buildPriceSchedule,
  buildSacSchedule,
  monthlyDueDate,
  parseDateOnlyUtc,
} from './financing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseService } from '../expense/expense.service';

function makePrismaMock() {
  return {
    financing: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    financingInstallment: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
    },
    expense: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    rateioAllocation: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    cashFlowEntry: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  } as any;
}

function makeExpenseServiceMock() {
  return {
    create: jest.fn().mockResolvedValue({ id: 'expense-mock' }),
    markPaidInPlace: jest.fn().mockResolvedValue(undefined),
  } as any;
}

/** Data "YYYY-MM-DD" N meses a partir de agora, fixada no dia 10 (evita fragilidade de fim de mês). */
function isoDateMonthsFromNow(months: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 10));
  return d.toISOString().slice(0, 10);
}

describe('buildPriceSchedule (PRICE)', () => {
  it('gera prestação fixa e zera o saldo exatamente na última parcela', () => {
    const rows = buildPriceSchedule(100_000_00, 100, 12); // R$100.000,00 a 1% a.m. em 12x
    expect(rows).toHaveLength(12);
    const valores = rows.map((r) => r.valorPrevisto);
    // PRICE: todas as prestações devem ser iguais (± 1 centavo de arredondamento acumulado na última).
    const uniqueButLast = new Set(valores.slice(0, -1));
    expect(uniqueButLast.size).toBe(1);
    expect(rows[rows.length - 1].saldoDevedorPrevisto).toBe(0);
    // Saldo devedor é sempre decrescente e nunca negativo.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].saldoDevedorPrevisto).toBeLessThanOrEqual(rows[i - 1].saldoDevedorPrevisto);
      expect(rows[i].saldoDevedorPrevisto).toBeGreaterThanOrEqual(0);
    }
  });

  it('com juros zero, divide o principal em parcelas iguais e absorve o resto na última', () => {
    const rows = buildPriceSchedule(1000, 0, 3); // 1000 centavos / 3 = 333.33...
    expect(rows.map((r) => r.valorPrevisto)).toEqual([333, 333, 334]);
    expect(rows[rows.length - 1].saldoDevedorPrevisto).toBe(0);
    const somaTotal = rows.reduce((sum, r) => sum + r.valorPrevisto, 0);
    expect(somaTotal).toBe(1000);
  });

  it('a soma das parcelas com juros é sempre maior ou igual ao principal', () => {
    const rows = buildPriceSchedule(50_000_00, 80, 24);
    const somaTotal = rows.reduce((sum, r) => sum + r.valorPrevisto, 0);
    expect(somaTotal).toBeGreaterThan(50_000_00);
  });

  it('permanece finito no limite aceito de prazo e juros', () => {
    const rows = buildPriceSchedule(100_000_00, 10_000, 600);
    expect(rows).toHaveLength(600);
    expect(rows.every((row) => Number.isFinite(row.valorPrevisto))).toBe(true);
    expect(rows[599].saldoDevedorPrevisto).toBe(0);
  });
});

describe('buildSacSchedule (SAC)', () => {
  it('amortização constante gera prestações decrescentes e zera o saldo na última', () => {
    const rows = buildSacSchedule(120_000_00, 100, 12);
    expect(rows).toHaveLength(12);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].valorPrevisto).toBeLessThanOrEqual(rows[i - 1].valorPrevisto);
    }
    expect(rows[rows.length - 1].saldoDevedorPrevisto).toBe(0);
  });

  it('com juros zero, amortização é igual à parcela e não há resto perdido', () => {
    const rows = buildSacSchedule(1000, 0, 3);
    expect(rows.map((r) => r.valorPrevisto)).toEqual([333, 333, 334]);
    const somaTotal = rows.reduce((sum, r) => sum + r.valorPrevisto, 0);
    expect(somaTotal).toBe(1000);
  });
});

describe('monthlyDueDate', () => {
  it('mantém o dia quando o mês alvo tem dias suficientes', () => {
    const anchor = parseDateOnlyUtc('2026-01-15');
    const due = monthlyDueDate(anchor, 1, 15);
    expect(due.toISOString()).toBe('2026-02-15T00:00:00.000Z');
  });

  it('faz clamp do dia 31 para o último dia de fevereiro (não-bissexto)', () => {
    const anchor = parseDateOnlyUtc('2026-01-31');
    const due = monthlyDueDate(anchor, 1, 31);
    expect(due.getUTCFullYear()).toBe(2026);
    expect(due.getUTCMonth()).toBe(1); // fevereiro
    expect(due.getUTCDate()).toBe(28);
  });

  it('faz clamp do dia 31 para o último dia de fevereiro em ano bissexto', () => {
    const anchor = parseDateOnlyUtc('2028-01-31');
    const due = monthlyDueDate(anchor, 1, 31);
    expect(due.getUTCDate()).toBe(29);
  });

  it('faz clamp do dia 30/31 para abril (30 dias)', () => {
    const anchor = parseDateOnlyUtc('2026-01-31');
    const due = monthlyDueDate(anchor, 3, 31);
    expect(due.getUTCMonth()).toBe(3); // abril
    expect(due.getUTCDate()).toBe(30);
  });

  it('avança o ano corretamente ao cruzar dezembro', () => {
    const anchor = parseDateOnlyUtc('2026-11-10');
    const due = monthlyDueDate(anchor, 2, 10);
    expect(due.getUTCFullYear()).toBe(2027);
    expect(due.getUTCMonth()).toBe(0); // janeiro
  });
});

describe('FinancingService', () => {
  let service: FinancingService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let expenseService: ReturnType<typeof makeExpenseServiceMock>;
  const tenantId = 'tenant-1';
  const projectId = 'project-1';

  beforeEach(async () => {
    prisma = makePrismaMock();
    expenseService = makeExpenseServiceMock();
    prisma.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinancingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ExpenseService, useValue: expenseService },
      ],
    }).compile();
    service = module.get(FinancingService);
  });

  describe('get', () => {
    it('retorna null quando não há financiamento para o projeto', async () => {
      prisma.financing.findFirst.mockResolvedValue(null);
      const result = await service.get(tenantId, projectId);
      expect(result).toBeNull();
      expect(prisma.financing.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId, tenantId, deletedAt: null } }),
      );
    });

    it('calcula o summary a partir das parcelas (pagas e previstas)', async () => {
      prisma.financing.findFirst.mockResolvedValue({
        id: 'fin-1',
        sistema: 'PRICE',
        valorTotalFinanciado: 1000,
        taxaJurosMensalBps: 0,
        prazoMeses: 3,
        installments: [
          {
            id: 'i1',
            numeroParcela: 1,
            status: 'PAGO',
            valorPago: 340,
            saldoDevedorPrevisto: 667,
          },
          {
            id: 'i2',
            numeroParcela: 2,
            status: 'PREVISTO',
            valorPago: null,
            saldoDevedorPrevisto: 334,
          },
          {
            id: 'i3',
            numeroParcela: 3,
            status: 'PREVISTO',
            valorPago: null,
            saldoDevedorPrevisto: 0,
          },
        ],
      });

      const result = await service.get(tenantId, projectId);
      expect(result?.summary).toEqual({
        valorPago: 340,
        saldoDevedor: 667,
        proximaParcela: expect.objectContaining({ id: 'i2' }),
        progresso: 33,
        totalParcelas: 3,
        parcelasPagas: 1,
      });
    });

    it('usa o valor total financiado como saldo devedor quando nada foi pago', async () => {
      prisma.financing.findFirst.mockResolvedValue({
        id: 'fin-1',
        sistema: 'PRICE',
        valorTotalFinanciado: 1000,
        taxaJurosMensalBps: 0,
        prazoMeses: 3,
        installments: [
          { id: 'i1', numeroParcela: 1, status: 'PREVISTO', valorPago: null, saldoDevedorPrevisto: 667 },
        ],
      });

      const result = await service.get(tenantId, projectId);
      expect(result?.summary.saldoDevedor).toBe(1000);
      expect(result?.summary.valorPago).toBe(0);
      expect(result?.summary.progresso).toBe(0);
    });

    it('não reduz o saldo por pagamento fora de ordem', async () => {
      prisma.financing.findFirst.mockResolvedValue({
        id: 'fin-1',
        sistema: 'PRICE',
        valorTotalFinanciado: 1000,
        taxaJurosMensalBps: 0,
        prazoMeses: 3,
        installments: [
          { id: 'i1', numeroParcela: 1, status: 'PREVISTO', valorPago: null, saldoDevedorPrevisto: 667 },
          { id: 'i2', numeroParcela: 2, status: 'PAGO', valorPago: 333, saldoDevedorPrevisto: 334 },
        ],
      });

      const result = await service.get(tenantId, projectId);
      expect(result?.summary.saldoDevedor).toBe(1000);
    });

    it('recalcula o saldo com os termos atuais sem depender do snapshot pago antigo', async () => {
      prisma.financing.findFirst.mockResolvedValue({
        id: 'fin-1',
        sistema: 'PRICE',
        valorTotalFinanciado: 1200,
        taxaJurosMensalBps: 0,
        prazoMeses: 3,
        installments: [
          {
            id: 'i1',
            numeroParcela: 1,
            status: 'PAGO',
            valorPago: 333,
            saldoDevedorPrevisto: 667,
          },
          {
            id: 'i2',
            numeroParcela: 2,
            status: 'PREVISTO',
            valorPago: null,
            saldoDevedorPrevisto: 400,
          },
        ],
      });

      const result = await service.get(tenantId, projectId);
      expect(result?.summary.saldoDevedor).toBe(800);
    });
  });

  describe('upsert', () => {
    const baseDto = {
      sistema: 'PRICE' as const,
      valorTotalFinanciado: 1000,
      taxaJurosMensalBps: 0,
      prazoMeses: 3,
      dataPrimeiraParcela: '2026-01-10',
      diaVencimento: 10,
    };

    it('cria o financiamento e gera todas as parcelas como PREVISTO quando não existe', async () => {
      prisma.financing.findFirst
        .mockResolvedValueOnce(null) // existing lookup
        .mockResolvedValueOnce({
          id: 'fin-1',
          valorTotalFinanciado: 1000,
          installments: [],
        }); // getWithSummary lookup
      prisma.financing.create.mockResolvedValue({ id: 'fin-1' });

      await service.upsert(tenantId, projectId, baseDto as any);

      expect(prisma.financing.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId,
          projectId,
          sistema: 'PRICE',
          valorTotalFinanciado: 1000,
          prazoMeses: 3,
        }),
      });
      expect(prisma.financingInstallment.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ numeroParcela: 1, financingId: 'fin-1', projectId, tenantId }),
          expect.objectContaining({ numeroParcela: 2 }),
          expect.objectContaining({ numeroParcela: 3 }),
        ]),
      });
      const created = prisma.financingInstallment.createMany.mock.calls[0][0].data;
      expect(created).toHaveLength(3);
    });

    it('preserva parcelas PAGO e regenera apenas PREVISTO ao editar um financiamento existente', async () => {
      prisma.financing.findFirst
        .mockResolvedValueOnce({ id: 'fin-1' }) // existing
        .mockResolvedValueOnce({ id: 'fin-1', valorTotalFinanciado: 1000, installments: [] }); // summary
      prisma.financingInstallment.findMany
        .mockResolvedValueOnce([{ id: 'inst-1', numeroParcela: 1, status: 'PAGO', expenseId: null }]) // current
        .mockResolvedValueOnce([]); // materializable

      await service.upsert(tenantId, projectId, { ...baseDto, prazoMeses: 3 } as any);

      expect(prisma.financing.update).toHaveBeenCalledWith({
        where: { id: 'fin-1' },
        data: expect.objectContaining({ prazoMeses: 3 }),
      });
      // Parcela 1 já paga: nada a descartar (é a única parcela previamente existente).
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      const insertedNumeros = prisma.financingInstallment.createMany.mock.calls[0][0].data.map(
        (r: any) => r.numeroParcela,
      );
      // Parcela 1 já paga não deve ser reinserida (só as 2 e 3, PREVISTO).
      expect(insertedNumeros).toEqual([2, 3]);
    });

    it('não descarta nem reinsere parcela vinculada via rateio ao PESSOAL mesmo com status PREVISTO', async () => {
      prisma.financing.findFirst
        .mockResolvedValueOnce({ id: 'fin-1' })
        .mockResolvedValueOnce({ id: 'fin-1', valorTotalFinanciado: 1000, installments: [] });
      prisma.financingInstallment.findMany
        .mockResolvedValueOnce([
          { id: 'inst-1', numeroParcela: 1, status: 'PREVISTO', expenseId: 'exp-1' },
        ])
        .mockResolvedValueOnce([]);
      prisma.expense.findUnique.mockResolvedValue({ status: 'PLANEJADO' });
      prisma.rateioAllocation.findUnique.mockResolvedValue({ targetExpenseId: 'exp-1' });

      await service.upsert(tenantId, projectId, { ...baseDto, prazoMeses: 3 } as any);

      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      const insertedNumeros = prisma.financingInstallment.createMany.mock.calls[0][0].data.map(
        (r: any) => r.numeroParcela,
      );
      expect(insertedNumeros).toEqual([2, 3]); // parcela 1 (rateada) preservada intocada
    });

    it('descarta (hard-delete) parcela PREVISTO não vinculada e recria com os novos termos', async () => {
      prisma.financing.findFirst
        .mockResolvedValueOnce({ id: 'fin-1' })
        .mockResolvedValueOnce({ id: 'fin-1', valorTotalFinanciado: 1000, installments: [] });
      prisma.financingInstallment.findMany
        .mockResolvedValueOnce([
          { id: 'inst-old-2', numeroParcela: 2, status: 'PREVISTO', expenseId: 'exp-old-2' },
        ])
        .mockResolvedValueOnce([]);
      prisma.expense.findUnique.mockResolvedValue({ status: 'PLANEJADO' });
      prisma.rateioAllocation.findUnique.mockResolvedValue(null);

      await service.upsert(tenantId, projectId, { ...baseDto, prazoMeses: 3 } as any);

      expect(prisma.cashFlowEntry.updateMany).toHaveBeenCalledWith({
        where: { expenseId: { in: ['exp-old-2'] }, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.expense.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['exp-old-2'] }, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.$executeRaw).toHaveBeenCalled();
      const insertedNumeros = prisma.financingInstallment.createMany.mock.calls[0][0].data.map(
        (r: any) => r.numeroParcela,
      );
      expect(insertedNumeros).toEqual([1, 2, 3]); // recriadas do zero (parcela 2 antiga não era protegida)
    });

    it('rejeita prazo menor que o número da última parcela paga', async () => {
      prisma.financing.findFirst.mockResolvedValueOnce({ id: 'fin-1' });
      prisma.financingInstallment.findMany.mockResolvedValueOnce([
        { numeroParcela: 1, status: 'PAGO', expenseId: null },
        { numeroParcela: 2, status: 'PAGO', expenseId: null },
      ]);

      await expect(
        service.upsert(tenantId, projectId, { ...baseDto, prazoMeses: 1 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.financing.update).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejeita prazo menor que o número de uma parcela vinculada via rateio (mesmo não paga)', async () => {
      prisma.financing.findFirst.mockResolvedValueOnce({ id: 'fin-1' });
      prisma.financingInstallment.findMany.mockResolvedValueOnce([
        { id: 'inst-1', numeroParcela: 1, status: 'PREVISTO', expenseId: 'exp-1' },
        { id: 'inst-2', numeroParcela: 2, status: 'PREVISTO', expenseId: 'exp-2' },
      ]);
      prisma.expense.findUnique.mockResolvedValue({ status: 'PLANEJADO' });
      prisma.rateioAllocation.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.targetExpenseId === 'exp-2' ? { targetExpenseId: 'exp-2' } : null),
      );

      await expect(
        service.upsert(tenantId, projectId, { ...baseDto, prazoMeses: 1 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.financing.update).not.toHaveBeenCalled();
    });
  });

  describe('materialização de despesa espelho (regra 14 — visível no consolidado)', () => {
    it('materializa despesa PLANEJADA para parcela dentro da janela rolling de 12 meses', async () => {
      prisma.financing.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'fin-1', valorTotalFinanciado: 340_00, installments: [] });
      prisma.financing.create.mockResolvedValue({ id: 'fin-1' });
      prisma.financingInstallment.findMany.mockResolvedValueOnce([
        {
          id: 'inst-1',
          numeroParcela: 1,
          expenseId: null,
          valorPrevisto: 34000,
          dataVencimento: parseDateOnlyUtc(isoDateMonthsFromNow(1)),
        },
      ]);
      expenseService.create.mockResolvedValue({ id: 'expense-1' });

      await service.upsert(tenantId, projectId, {
        sistema: 'PRICE' as const,
        valorTotalFinanciado: 340_00,
        taxaJurosMensalBps: 0,
        prazoMeses: 1,
        dataPrimeiraParcela: isoDateMonthsFromNow(1),
        diaVencimento: 10,
      } as any);

      expect(expenseService.create).toHaveBeenCalledWith(
        tenantId,
        projectId,
        expect.objectContaining({
          tipoDespesa: 'FINANCIAMENTO',
          formaPagamento: 'A_VISTA',
          status: 'PLANEJADO',
          valor: 340,
        }),
        null,
        prisma,
      );
      expect(prisma.financingInstallment.update).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: { expenseId: 'expense-1' },
      });
    });

    it('não materializa parcela com vencimento além da janela de 12 meses', async () => {
      prisma.financing.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'fin-1', valorTotalFinanciado: 340_00, installments: [] });
      prisma.financing.create.mockResolvedValue({ id: 'fin-1' });
      prisma.financingInstallment.findMany.mockResolvedValueOnce([
        {
          id: 'inst-1',
          numeroParcela: 1,
          expenseId: null,
          valorPrevisto: 34000,
          dataVencimento: parseDateOnlyUtc(isoDateMonthsFromNow(15)),
        },
      ]);

      await service.upsert(tenantId, projectId, {
        sistema: 'PRICE' as const,
        valorTotalFinanciado: 340_00,
        taxaJurosMensalBps: 0,
        prazoMeses: 1,
        dataPrimeiraParcela: isoDateMonthsFromNow(15),
        diaVencimento: 10,
      } as any);

      expect(expenseService.create).not.toHaveBeenCalled();
      expect(prisma.financingInstallment.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('lança NotFoundException quando não há financiamento para o projeto', async () => {
      prisma.financing.findFirst.mockResolvedValue(null);
      await expect(service.remove(tenantId, projectId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('soft-deleta parcelas e despesas não vinculadas, preserva as pagas/vinculadas, e soft-deleta o financiamento', async () => {
      prisma.financing.findFirst.mockResolvedValue({
        id: 'fin-1',
        installments: [
          { id: 'inst-1', numeroParcela: 1, status: 'PAGO', expenseId: 'exp-1' }, // protegida (paga)
          { id: 'inst-2', numeroParcela: 2, status: 'PREVISTO', expenseId: 'exp-2' }, // livre
        ],
      });
      prisma.expense.findUnique.mockResolvedValue({ status: 'PLANEJADO' });
      prisma.rateioAllocation.findUnique.mockResolvedValue(null);

      const result = await service.remove(tenantId, projectId);

      expect(result).toEqual({ deleted: true });
      // Parcela 2 (livre): despesa e cashflow soft-deletados.
      expect(prisma.cashFlowEntry.updateMany).toHaveBeenCalledWith({
        where: { expenseId: 'exp-2', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.expense.updateMany).toHaveBeenCalledWith({
        where: { id: 'exp-2', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.financingInstallment.update).toHaveBeenCalledWith({
        where: { id: 'inst-2' },
        data: { deletedAt: expect.any(Date) },
      });
      // Parcela 1 (paga): nunca tocada.
      expect(prisma.expense.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'exp-1' }) }),
      );
      expect(prisma.financingInstallment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inst-1' } }),
      );
      expect(prisma.financing.update).toHaveBeenCalledWith({
        where: { id: 'fin-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  describe('payInstallment', () => {
    it('marca a parcela como PAGO com valor e data informados', async () => {
      prisma.financingInstallment.findFirst.mockResolvedValue({
        id: 'inst-1',
        status: 'PREVISTO',
      });
      prisma.financingInstallment.update.mockResolvedValue({
        id: 'inst-1',
        status: 'PAGO',
        valorPago: 500,
      });

      const result = await service.payInstallment(tenantId, projectId, 'inst-1', {
        valorPago: 500,
        dataPagamento: '2026-02-10',
      });

      expect(result.status).toBe('PAGO');
      expect(prisma.financingInstallment.update).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: {
          status: 'PAGO',
          valorPago: 500,
          dataPagamento: parseDateOnlyUtc('2026-02-10'),
        },
      });
    });

    it('é idempotente: repetir o pagamento da mesma parcela não falha', async () => {
      prisma.financingInstallment.findFirst.mockResolvedValue({
        id: 'inst-1',
        status: 'PAGO',
        valorPago: 500,
      });
      prisma.financingInstallment.update.mockResolvedValue({
        id: 'inst-1',
        status: 'PAGO',
        valorPago: 500,
      });

      await expect(
        service.payInstallment(tenantId, projectId, 'inst-1', {
          valorPago: 500,
          dataPagamento: '2026-02-10',
        }),
      ).resolves.toEqual(expect.objectContaining({ status: 'PAGO' }));
    });

    it('lança NotFoundException quando a parcela não existe (ou é de outro tenant/projeto)', async () => {
      prisma.financingInstallment.findFirst.mockResolvedValue(null);

      await expect(
        service.payInstallment(tenantId, projectId, 'inexistente', {
          valorPago: 500,
          dataPagamento: '2026-02-10',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejeita pagamento de valor zero', async () => {
      await expect(
        service.payInstallment(tenantId, projectId, 'inst-1', {
          valorPago: 0,
          dataPagamento: '2026-02-10',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.financingInstallment.update).not.toHaveBeenCalled();
    });

    it('#294: parcela COM espelho (expenseId) sincroniza a Expense via markPaidInPlace', async () => {
      prisma.financingInstallment.findFirst.mockResolvedValue({
        id: 'inst-1',
        status: 'PREVISTO',
        expenseId: 'expense-espelho-1',
      });
      prisma.financingInstallment.update.mockResolvedValue({
        id: 'inst-1',
        status: 'PAGO',
        valorPago: 500,
        expenseId: 'expense-espelho-1',
      });

      await service.payInstallment(tenantId, projectId, 'inst-1', {
        valorPago: 500,
        dataPagamento: '2026-02-10',
      });

      expect(expenseService.markPaidInPlace).toHaveBeenCalledWith(
        tenantId,
        'expense-espelho-1',
        parseDateOnlyUtc('2026-02-10'),
        prisma, // $transaction injeta o próprio mock como `tx`
      );
    });

    it('#294: parcela SEM espelho (expenseId null — fora da janela rolling) não quebra e não sincroniza', async () => {
      prisma.financingInstallment.findFirst.mockResolvedValue({
        id: 'inst-2',
        status: 'PREVISTO',
        expenseId: null,
      });
      prisma.financingInstallment.update.mockResolvedValue({
        id: 'inst-2',
        status: 'PAGO',
        valorPago: 500,
        expenseId: null,
      });

      const result = await service.payInstallment(tenantId, projectId, 'inst-2', {
        valorPago: 500,
        dataPagamento: '2026-02-10',
      });

      expect(result.status).toBe('PAGO');
      expect(expenseService.markPaidInPlace).not.toHaveBeenCalled();
    });

    it('#294: idempotência com espelho — marcar paga 2× não lança e sincroniza ambas as vezes sem efeito duplicado (regenerateCashFlow é soft-delete+recriar)', async () => {
      prisma.financingInstallment.findFirst.mockResolvedValue({
        id: 'inst-1',
        status: 'PAGO',
        expenseId: 'expense-espelho-1',
      });
      prisma.financingInstallment.update.mockResolvedValue({
        id: 'inst-1',
        status: 'PAGO',
        valorPago: 500,
        expenseId: 'expense-espelho-1',
      });

      await service.payInstallment(tenantId, projectId, 'inst-1', {
        valorPago: 500,
        dataPagamento: '2026-02-10',
      });
      await service.payInstallment(tenantId, projectId, 'inst-1', {
        valorPago: 500,
        dataPagamento: '2026-02-10',
      });

      expect(expenseService.markPaidInPlace).toHaveBeenCalledTimes(2);
    });
  });
});
