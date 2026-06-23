import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

describe('MonthlyOverviewService.getAccountView', () => {
  let service: MonthlyOverviewService;
  let prisma: any;
  let settlement: any;

  const tenantId = 'tenant-1';
  const projectId = 'pessoal-1';

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    prisma = {
      project: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL', deletedAt: null }),
      },
      bankAccount: {
        findMany: jest.fn().mockResolvedValue([
          { openingBalanceCents: 100_000, openingBalanceDate: new Date('2025-12-31T00:00:00.000Z') },
        ]),
        findFirst: jest.fn(),
      },
      expense: { findMany: jest.fn(), create: jest.fn() },
      receipt: { findMany: jest.fn() },
      cashFlowEntry: { findMany: jest.fn() },
      creditCard: { findMany: jest.fn(), findFirst: jest.fn() },
    };

    settlement = { settleInvoice: jest.fn().mockResolvedValue({ settledExpenses: 0, settledParcelas: 0 }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: CardInvoiceSettlementService, useValue: settlement },
      ],
    }).compile();

    service = module.get<MonthlyOverviewService>(MonthlyOverviewService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('monta a visão da conta sem dobrar pagamento de fatura neutro', async () => {
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp-bank-paid',
        tenantId,
        projectId,
        tipoDespesa: 'ALIMENTACAO',
        titulo: 'Mercado',
        fornecedor: 'Mercado',
        valorTotal: 5_000,
        valor: 5_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-05T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-05T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'exp-rent',
        tenantId,
        projectId,
        tipoDespesa: 'MORADIA',
        titulo: 'Aluguel',
        fornecedor: 'Imobiliaria',
        valorTotal: 8_000,
        valor: 8_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-25T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PLANEJADO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'exp-fatura-pagamento',
        tenantId,
        projectId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        titulo: 'Pagamento fatura Nubank',
        fornecedor: 'NU PAGAMENTOS',
        valorTotal: 7_000,
        valor: 7_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-10T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-10T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: '1111',
        bankLast4: '4247',
      },
      {
        id: 'exp-card-paid-1',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Compra 1',
        fornecedor: 'Loja 1',
        valorTotal: 3_000,
        valor: 3_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-05-25T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-05-25T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: '1111',
        bankLast4: null,
      },
      {
        id: 'exp-card-paid-2',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Compra 2',
        fornecedor: 'Loja 2',
        valorTotal: 4_000,
        valor: 4_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-05-26T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-05-26T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: '1111',
        bankLast4: null,
      },
      {
        id: 'exp-card-future',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Compra futura',
        fornecedor: 'Loja 3',
        valorTotal: 2_000,
        valor: 2_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-21T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-21T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PLANEJADO',
        cardLast4: '1111',
        bankLast4: null,
      },
    ]);

    prisma.receipt.findMany.mockResolvedValue([
      {
        id: 'rec-salary',
        tenantId,
        projectId,
        valor: 20_000,
        data: new Date('2026-06-02T00:00:00.000Z'),
        tipo: 'SALARIO',
        descricao: 'Salario',
        status: 'EM_CAIXA',
        bankLast4: '4247',
      },
      {
        id: 'rec-future',
        tenantId,
        projectId,
        valor: 4_000,
        data: new Date('2026-06-20T00:00:00.000Z'),
        tipo: 'REEMBOLSO',
        descricao: 'Reembolso',
        status: 'PREVISTO',
        bankLast4: '4247',
      },
    ]);

    prisma.cashFlowEntry.findMany.mockResolvedValue([
      {
        id: 'cfe-bank-paid',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 5_000,
        data: new Date('2026-06-05T00:00:00.000Z'),
        status: 'PAGO',
        categoria: 'ALIMENTACAO',
        subcategoria: null,
        formaPagamento: 'CONTA_CORRENTE',
        parcela: null,
        expense: {
          id: 'exp-bank-paid',
          tipoDespesa: 'ALIMENTACAO',
          titulo: 'Mercado',
          fornecedor: 'Mercado',
          cardLast4: null,
          bankLast4: '4247',
        },
        receipt: null,
      },
      {
        id: 'cfe-rent',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 8_000,
        data: new Date('2026-06-25T00:00:00.000Z'),
        status: 'PLANEJADO',
        categoria: 'MORADIA',
        subcategoria: null,
        formaPagamento: 'CONTA_CORRENTE',
        parcela: null,
        expense: {
          id: 'exp-rent',
          tipoDespesa: 'MORADIA',
          titulo: 'Aluguel',
          fornecedor: 'Imobiliaria',
          cardLast4: null,
          bankLast4: '4247',
        },
        receipt: null,
      },
      {
        id: 'cfe-card-paid-1',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 3_000,
        data: new Date('2026-05-25T00:00:00.000Z'),
        status: 'PAGO',
        categoria: 'OUTROS',
        subcategoria: 'Nubank',
        formaPagamento: 'CARTAO_CREDITO',
        parcela: null,
        expense: {
          id: 'exp-card-paid-1',
          tipoDespesa: 'OUTROS',
          titulo: 'Compra 1',
          fornecedor: 'Loja 1',
          cardLast4: '1111',
          bankLast4: null,
        },
        receipt: null,
      },
      {
        id: 'cfe-card-paid-2',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 4_000,
        data: new Date('2026-05-26T00:00:00.000Z'),
        status: 'PAGO',
        categoria: 'OUTROS',
        subcategoria: 'Nubank',
        formaPagamento: 'CARTAO_CREDITO',
        parcela: null,
        expense: {
          id: 'exp-card-paid-2',
          tipoDespesa: 'OUTROS',
          titulo: 'Compra 2',
          fornecedor: 'Loja 2',
          cardLast4: '1111',
          bankLast4: null,
        },
        receipt: null,
      },
      {
        id: 'cfe-card-future',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 2_000,
        data: new Date('2026-06-21T00:00:00.000Z'),
        status: 'PLANEJADO',
        categoria: 'OUTROS',
        subcategoria: 'Nubank',
        formaPagamento: 'CARTAO_CREDITO',
        parcela: null,
        expense: {
          id: 'exp-card-future',
          tipoDespesa: 'OUTROS',
          titulo: 'Compra futura',
          fornecedor: 'Loja 3',
          cardLast4: '1111',
          bankLast4: null,
        },
        receipt: null,
      },
    ]);

    prisma.creditCard.findMany.mockResolvedValue([
      {
        id: 'card-1',
        tenantId,
        projectId,
        nickname: 'Nubank',
        last4: '1111',
        closingDay: 20,
        dueDay: 28,
        limitTotalCents: 10_000,
        limitAvailableCents: 3_000,
      },
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

    expect(res.caixaHoje).toBe(108_000);
    expect(res.entrouMes).toBe(20_000);
    expect(res.saiuMes).toBe(12_000);
    expect(res.faltaPagarMes).toBe(8_000);
    expect(res.sobraPrevista).toBe(104_000);
    expect(res.devoCartaoTotal).toBe(2_000);

    expect(res.cartoes).toEqual([
      expect.objectContaining({
        nickname: 'Nubank',
        last4: '1111',
        faturaAtual: 7_000,
        vencimento: '2026-06-28',
        status: 'paga',
        limiteUsadoPct: 70,
        limiteUsado: 7_000,
        limiteTotal: 10_000,
      }),
    ]);

    const fatura = res.saidas.find((item: any) => item.forma === 'cartao');
    expect(fatura).toEqual(
      expect.objectContaining({
        descricao: 'Fatura Nubank',
        valor: 7_000,
        realizado: true,
      }),
    );
    expect(res.saidas.some((item: any) => /Pagamento fatura/i.test(item.descricao))).toBe(false);
    expect(res.saidas.reduce((sum: number, item: any) => sum + item.valor, 0)).toBe(20_000);

    const comprasNubank = res.comprasCartao.filter((item: any) => item.cardLast4 === '1111');
    expect(comprasNubank.length).toBeGreaterThan(0);
    expect(comprasNubank.every((item: any) => item.isInvoice === false)).toBe(true);
    expect(comprasNubank.reduce((sum: number, item: any) => sum + item.valor, 0)).toBe(7_000);
    expect(prisma.cashFlowEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            { OR: [{ expenseId: null }, { expense: { deletedAt: null } }] },
            { OR: [{ receiptId: null }, { receipt: { deletedAt: null } }] },
          ],
        }),
      }),
    );

    expect(res.entradas).toEqual([
      expect.objectContaining({
        descricao: 'Salario',
        tipo: 'salario',
        valor: 20_000,
      }),
    ]);
  });

  it('calcula ticket médio, variação mensal e média de 6 meses por competência', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([]);
    prisma.receipt.findMany.mockResolvedValue([]);
    prisma.cashFlowEntry.findMany.mockResolvedValue([]);
    prisma.creditCard.findMany.mockResolvedValue([]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'jan',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Jan',
        fornecedor: 'Loja',
        valorTotal: 8_000,
        valor: 8_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-01-10T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-01-10T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'feb',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Fev',
        fornecedor: 'Loja',
        valorTotal: 6_000,
        valor: 6_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-02-10T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-02-10T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'mar',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Mar',
        fornecedor: 'Loja',
        valorTotal: 12_000,
        valor: 12_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-03-10T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-03-10T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'apr',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Abr',
        fornecedor: 'Loja',
        valorTotal: 9_000,
        valor: 9_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-04-10T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-04-10T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'may',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Mai',
        fornecedor: 'Loja',
        valorTotal: 5_000,
        valor: 5_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-05-10T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-05-10T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'jun-1',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Jun 1',
        fornecedor: 'Loja',
        valorTotal: 12_000,
        valor: 12_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-01T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'jun-2',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Jun 2',
        fornecedor: 'Loja',
        valorTotal: 8_000,
        valor: 8_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-08T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-08T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
      {
        id: 'neutral',
        tenantId,
        projectId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        titulo: 'Neutra',
        fornecedor: 'Banco',
        valorTotal: 99_999,
        valor: 99_999,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-20T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '4247',
      },
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

    expect(res.ticketMedio.valor).toBe(10_000);
    expect(res.ticketMedio.nCompras).toBe(2);
    expect(res.ticketMedio.totalCompras).toBe(20_000);
    expect(res.ticketMedio.serie6m).toEqual([
      expect.objectContaining({ mes: '2026-01', valor: 8_000, deltaPct: null }),
      expect.objectContaining({ mes: '2026-02', valor: 6_000, deltaPct: -25 }),
      expect.objectContaining({ mes: '2026-03', valor: 12_000, deltaPct: 100 }),
      expect.objectContaining({ mes: '2026-04', valor: 9_000, deltaPct: -25 }),
      expect.objectContaining({ mes: '2026-05', valor: 5_000, deltaPct: -44.44 }),
      expect.objectContaining({ mes: '2026-06', valor: 10_000, deltaPct: 100 }),
    ]);
    expect(res.ticketMedio.media6m).toBe(8_333);
    expect(res.ticketMedio.deltaVsMediaPct).toBe(20);
  });

  it('mantém fatura futura como a pagar até existir pagamento neutro da fatura', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'future-card-expense',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Compra futura',
        fornecedor: 'Loja',
        valorTotal: 2_000,
        valor: 2_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-21T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-21T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: '1111',
        bankLast4: null,
      },
    ]);
    prisma.receipt.findMany.mockResolvedValue([]);
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      {
        id: 'future-entry',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 2_000,
        data: new Date('2026-06-21T00:00:00.000Z'),
        status: 'PAGO',
        categoria: 'OUTROS',
        subcategoria: 'Nubank',
        formaPagamento: 'CARTAO_CREDITO',
        parcela: null,
        expense: {
          id: 'future-card-expense',
          tipoDespesa: 'OUTROS',
          titulo: 'Compra futura',
          fornecedor: 'Loja',
          cardLast4: '1111',
          bankLast4: null,
        },
        receipt: null,
      },
    ]);
    prisma.creditCard.findMany.mockResolvedValue([
      {
        id: 'card-1',
        tenantId,
        projectId,
        nickname: 'Nubank',
        last4: '1111',
        closingDay: 20,
        dueDay: 28,
        limitTotalCents: null,
        limitAvailableCents: null,
      },
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, '2026-07');

    expect(res.faltaPagarMes).toBe(2_000);
    expect(res.devoCartaoTotal).toBe(2_000);
    expect(res.saidas).toEqual([
      expect.objectContaining({
        descricao: 'Fatura Nubank',
        valor: 2_000,
        realizado: false,
      }),
    ]);
    expect(res.cartoes[0]).toEqual(
      expect.objectContaining({
        faturaAtual: 2_000,
        status: 'a pagar',
        vencimento: '2026-07-28',
      }),
    );
  });

  describe('payInvoice', () => {
    beforeEach(() => {
      prisma.creditCard.findFirst.mockResolvedValue({
        id: 'card-1',
        last4: '1111',
        nickname: 'Nubank',
        closingDay: 20,
        dueDay: 28,
      });
      prisma.bankAccount.findFirst.mockResolvedValue({ last4: '4247' });
      prisma.expense.findMany.mockResolvedValue([]); // nenhuma fatura paga ainda
      prisma.expense.create.mockResolvedValue({ id: 'pay-1' });
    });

    it('gera despesa neutra PAGAMENTO_FATURA_CARTAO e liquida o ciclo', async () => {
      const res: any = await service.payInvoice(tenantId, projectId, {
        cardLast4: '1111',
        month: '2026-06',
        amountCents: 7_000,
        bankLast4: '4247',
      });

      expect(prisma.expense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
            status: 'PAGO',
            valorTotal: 7_000,
            bankLast4: '4247',
            cardLast4: '1111',
          }),
        }),
      );
      expect(settlement.settleInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId, amountCents: 7_000 }),
      );
      expect(res.ok).toBe(true);
      expect(res.paymentExpenseId).toBe('pay-1');
    });

    it('bloqueia pagamento duplicado no mesmo mês', async () => {
      prisma.expense.findMany.mockResolvedValue([
        { dataPagamento: new Date('2026-06-10T00:00:00.000Z'), createdAt: new Date('2026-06-10T00:00:00.000Z') },
      ]);

      await expect(
        service.payInvoice(tenantId, projectId, {
          cardLast4: '1111',
          month: '2026-06',
          amountCents: 7_000,
          bankLast4: '4247',
        }),
      ).rejects.toThrow(/já está marcada como paga/i);
      expect(prisma.expense.create).not.toHaveBeenCalled();
    });

    it('exige conta de débito e valor válido', async () => {
      await expect(
        service.payInvoice(tenantId, projectId, {
          cardLast4: '1111',
          month: '2026-06',
          amountCents: 7_000,
        }),
      ).rejects.toThrow(/Conta de débito obrigatória/i);

      await expect(
        service.payInvoice(tenantId, projectId, {
          cardLast4: '1111',
          month: '2026-06',
          amountCents: 0,
          bankLast4: '4247',
        }),
      ).rejects.toThrow(/Valor da fatura inválido/i);
    });
  });
});
