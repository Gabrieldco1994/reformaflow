import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CategoryBudgetService } from './category-budget.service';
import { PrismaService } from '../prisma/prisma.service';

describe('CategoryBudgetService', () => {
  let service: CategoryBudgetService;
  let prisma: any;
  const tenantId = 'tenant-1';
  const projectId = 'project-1';

  beforeEach(async () => {
    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: projectId, type: 'PESSOAL' }),
      },
      categoryBudget: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      expense: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CategoryBudgetService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(CategoryBudgetService);
  });

  it('cria meta quando não existe e atualiza quando já existe para tenant/projeto/tipo/mês', async () => {
    prisma.categoryBudget.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'b1' });
    prisma.categoryBudget.create.mockResolvedValue({ id: 'b1', valorLimiteCents: 50000 });
    prisma.categoryBudget.update.mockResolvedValue({ id: 'b1', valorLimiteCents: 65000 });

    await service.upsert(tenantId, projectId, {
      tipoDespesa: 'ALIMENTACAO',
      mes: '2026-06',
      valorLimiteCents: 50000,
    });
    await service.upsert(tenantId, projectId, {
      tipoDespesa: 'ALIMENTACAO',
      mes: '2026-06',
      valorLimiteCents: 65000,
    });

    expect(prisma.categoryBudget.findFirst).toHaveBeenCalledWith({
      where: { tenantId, projectId, tipoDespesa: 'ALIMENTACAO', mes: '2026-06' },
    });
    expect(prisma.categoryBudget.create).toHaveBeenCalledWith({
      data: { tenantId, projectId, tipoDespesa: 'ALIMENTACAO', mes: '2026-06', valorLimiteCents: 50000 },
    });
    expect(prisma.categoryBudget.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { valorLimiteCents: 65000 },
    });
  });

  it('calcula progresso do mês ignorando categorias neutras e somando todas as despesas simples', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T12:00:00Z')); // Qualquer dia em junho

    prisma.categoryBudget.findMany.mockResolvedValue([
      { tipoDespesa: 'ALIMENTACAO', valorLimiteCents: 100000, mes: '2026-06' },
      { tipoDespesa: 'TRANSPORTE', valorLimiteCents: 50000, mes: null },
      { tipoDespesa: 'MOVIMENTACAO_INTERNA', valorLimiteCents: 999999, mes: '2026-06' },
    ]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp1',
        tipoDespesa: 'ALIMENTACAO',
        valorTotal: 30000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-05'),
        quantidadeParcela: null,
        dataInicioParcela: null,
        installmentDateOverrides: null,
        paidParcelas: null,
        status: 'PAGO',
        recorrente: false,
        recorrenciaFim: null,
        createdAt: new Date('2026-06-05'),
      },
      {
        id: 'exp2',
        tipoDespesa: 'ALIMENTACAO',
        valorTotal: 50000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-10'),
        quantidadeParcela: null,
        dataInicioParcela: null,
        installmentDateOverrides: null,
        paidParcelas: null,
        status: 'PAGO',
        recorrente: false,
        recorrenciaFim: null,
        createdAt: new Date('2026-06-10'),
      },
      {
        id: 'exp3',
        tipoDespesa: 'TRANSPORTE',
        valorTotal: 60000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-12'),
        quantidadeParcela: null,
        dataInicioParcela: null,
        installmentDateOverrides: null,
        paidParcelas: null,
        status: 'PAGO',
        recorrente: false,
        recorrenciaFim: null,
        createdAt: new Date('2026-06-12'),
      },
    ]);

    const result = await service.progress(tenantId, projectId, '2026-06');

    expect(result).toEqual([
      { tipoDespesa: 'ALIMENTACAO', limiteCents: 100000, gastoCents: 80000, pct: 80 },
      { tipoDespesa: 'TRANSPORTE', limiteCents: 50000, gastoCents: 60000, pct: 120 },
    ]);

    jest.useRealTimers();
  });

  it('expande despesas parceladas e soma apenas as parcelas do mês solicitado', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T12:00:00Z')); // Congelar em agosto

    prisma.categoryBudget.findMany.mockResolvedValue([
      { tipoDespesa: 'MOVEIS', valorLimiteCents: 300000, mes: '2026-08' },
    ]);

    // Despesa de R$ 300 (300000 centavos) parcelada em 3x
    // Parcela 1: 10000 centavos (R$ 100) vencimento 2026-08-10
    // Parcela 2: 10000 centavos (R$ 100) vencimento 2026-09-10
    // Parcela 3: 80000 centavos (R$ 80) vencimento 2026-10-10
    // Apenas a parcela 1 cai em agosto, então gasto deve ser 10000 centavos
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp-parcelada',
        tipoDespesa: 'MOVEIS',
        valorTotal: 30000, // Total em centavos
        formaPagamento: 'PARCELADO',
        dataPagamento: null,
        quantidadeParcela: 3,
        dataInicioParcela: new Date('2026-08-10'),
        installmentDateOverrides: null,
        paidParcelas: null,
        status: 'PLANEJADO',
        recorrente: false,
        recorrenciaFim: null,
        createdAt: new Date('2026-08-01'),
      },
    ]);

    const result = await service.progress(tenantId, projectId, '2026-08');

    // Valor esperado: apenas a primeira parcela (30000 / 3 = 10000)
    expect(result).toEqual([
      { tipoDespesa: 'MOVEIS', limiteCents: 300000, gastoCents: 10000, pct: 3 },
    ]);

    jest.useRealTimers();
  });

  it('expande despesas recorrentes e soma apenas as ocorrências do mês solicitado', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T12:00:00Z')); // Congelar em agosto

    prisma.categoryBudget.findMany.mockResolvedValue([
      { tipoDespesa: 'ALUGUEL', valorLimiteCents: 150000, mes: null },
    ]);

    // Despesa recorrente de R$ 150 (150000 centavos) por mês
    // Começando em 2026-07-01, sem fim
    // Julho (fora do mês): 15000 centavos
    // Agosto (no mês): 15000 centavos
    // Setembro (fora do mês): 15000 centavos
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp-recorrente',
        tipoDespesa: 'ALUGUEL',
        valorTotal: 150000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-07-01'),
        quantidadeParcela: null,
        dataInicioParcela: null,
        installmentDateOverrides: null,
        paidParcelas: null,
        status: 'PAGO',
        recorrente: true,
        recorrenciaFim: null,
        createdAt: new Date('2026-07-01'),
      },
    ]);

    const result = await service.progress(tenantId, projectId, '2026-08');

    // Apenas a ocorrência de agosto (150000 centavos)
    expect(result).toEqual([
      { tipoDespesa: 'ALUGUEL', limiteCents: 150000, gastoCents: 150000, pct: 100 },
    ]);

    jest.useRealTimers();
  });

  it('respeita virada de mês: dia 1 às 00:30 BRT cai em mês anterior em UTC', async () => {
    jest.useFakeTimers();
    // 2026-09-01T00:30:00 BRT = 2026-09-01T03:30:00 UTC
    // O "dia 1" em BRT é representado como 2026-09-01T00:00:00Z
    jest.setSystemTime(new Date('2026-09-01T03:30:00Z')); // 00:30 BRT

    prisma.categoryBudget.findMany.mockResolvedValue([
      { tipoDespesa: 'ALIMENTACAO', valorLimiteCents: 100000, mes: '2026-09' },
    ]);

    // Despesa com data de pagamento 2026-09-01 às 00:00 BRT
    // Deve ser contada em setembro, não agosto
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp-virada',
        tipoDespesa: 'ALIMENTACAO',
        valorTotal: 50000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-09-01T03:00:00Z'), // 00:00 BRT
        quantidadeParcela: null,
        dataInicioParcela: null,
        installmentDateOverrides: null,
        paidParcelas: null,
        status: 'PAGO',
        recorrente: false,
        recorrenciaFim: null,
        createdAt: new Date('2026-09-01'),
      },
    ]);

    const result = await service.progress(tenantId, projectId, '2026-09');

    // A despesa deve ser contada em setembro
    expect(result).toEqual([
      { tipoDespesa: 'ALIMENTACAO', limiteCents: 100000, gastoCents: 50000, pct: 50 },
    ]);

    jest.useRealTimers();
  });

  it('diferencia parcelas pagas de planejadas na contagem', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-15T12:00:00Z')); // Congelar em agosto

    prisma.categoryBudget.findMany.mockResolvedValue([
      { tipoDespesa: 'ELETRONICO', valorLimiteCents: 100000, mes: '2026-08' },
    ]);

    // Despesa parcelada em 2x
    // Parcela 1 (paga): 15000 centavos vencimento 2026-08-05
    // Parcela 2 (planejada): 15000 centavos vencimento 2026-09-05
    // paidParcelas = [0] (índice 0 é pago)
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp-parcial',
        tipoDespesa: 'ELETRONICO',
        valorTotal: 30000,
        formaPagamento: 'PARCELADO',
        dataPagamento: null,
        quantidadeParcela: 2,
        dataInicioParcela: new Date('2026-08-05'),
        installmentDateOverrides: null,
        paidParcelas: '[0]', // Apenas primeira parcela paga
        status: 'PLANEJADO',
        recorrente: false,
        recorrenciaFim: null,
        createdAt: new Date('2026-08-01'),
      },
    ]);

    const result = await service.progress(tenantId, projectId, '2026-08');

    // Apenas a parcela 1 em agosto (15000 centavos)
    expect(result).toEqual([
      { tipoDespesa: 'ELETRONICO', limiteCents: 100000, gastoCents: 15000, pct: 15 },
    ]);

    jest.useRealTimers();
  });

  it('bloqueia metas em projetos não PESSOAL', async () => {
    prisma.project.findFirst.mockResolvedValueOnce({ id: projectId, type: 'REFORMA' });

    await expect(
      service.upsert(tenantId, projectId, {
        tipoDespesa: 'ALIMENTACAO',
        mes: '2026-06',
        valorLimiteCents: 1000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
