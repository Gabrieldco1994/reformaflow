import { Test, TestingModule } from '@nestjs/testing';
import {
  MonthlyOverviewService,
  matchPaidInvoices,
  computePaidInvoiceKeys,
} from './monthly-overview.service';
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
        findMany: jest.fn().mockResolvedValue([{ id: projectId, name: 'Pessoal', type: 'PESSOAL' }]),
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
      crossProjectSettlement: { findMany: jest.fn().mockResolvedValue([]) },
      rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      bankStatementImport: { findMany: jest.fn().mockResolvedValue([]) },
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

  it('inclui cobrança neutra no cartão (PgConta/Pix no crédito) na fatura, mas fora do gasto real', async () => {
    // Card "Latam-like": closing 25, due 1. Compras em 2026-04-30 caem na fatura de 2026-06.
    prisma.bankAccount.findMany.mockResolvedValue([]);
    prisma.receipt.findMany.mockResolvedValue([]);

    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp-real',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Compra real',
        fornecedor: 'Loja',
        valorTotal: 1_000,
        valor: 1_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-04-30T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PLANEJADO',
        cardLast4: '9999',
        bankLast4: null,
      },
      {
        // Neutro lançado COMO COBRANÇA no cartão (sem bankLast4): usar este cartão
        // para pagar a fatura de outro / Pix no crédito. Deve entrar na fatura.
        id: 'exp-pgconta',
        tenantId,
        projectId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        titulo: 'PgConta NU PAGAMENTOS SA',
        fornecedor: 'NU PAGAMENTOS',
        valorTotal: 5_000,
        valor: 5_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-04-30T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PLANEJADO',
        cardLast4: '9999',
        bankLast4: null,
      },
    ]);

    prisma.cashFlowEntry.findMany.mockResolvedValue([
      {
        id: 'cfe-real',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 1_000,
        data: new Date('2026-04-30T00:00:00.000Z'),
        status: 'PLANEJADO',
        categoria: 'OUTROS',
        subcategoria: 'Latam',
        formaPagamento: 'CARTAO_CREDITO',
        parcela: null,
        expense: {
          id: 'exp-real',
          tipoDespesa: 'OUTROS',
          titulo: 'Compra real',
          fornecedor: 'Loja',
          cardLast4: '9999',
          bankLast4: null,
        },
        receipt: null,
      },
      {
        id: 'cfe-pgconta',
        tenantId,
        projectId,
        tipo: 'DESPESA',
        valor: 5_000,
        data: new Date('2026-04-30T00:00:00.000Z'),
        status: 'PLANEJADO',
        categoria: 'PAGAMENTO_FATURA_CARTAO',
        subcategoria: 'Latam',
        formaPagamento: 'CARTAO_CREDITO',
        parcela: null,
        expense: {
          id: 'exp-pgconta',
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          titulo: 'PgConta NU PAGAMENTOS SA',
          fornecedor: 'NU PAGAMENTOS',
          cardLast4: '9999',
          bankLast4: null,
        },
        receipt: null,
      },
    ]);

    prisma.creditCard.findMany.mockResolvedValue([
      {
        id: 'card-latam',
        tenantId,
        projectId,
        nickname: 'Latam',
        last4: '9999',
        closingDay: 25,
        dueDay: 1,
        limitTotalCents: 100_000,
        limitAvailableCents: 50_000,
      },
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

    // Fatura espelha o banco: inclui a cobrança neutra (1.000 + 5.000).
    const fatura = res.saidas.find(
      (item: any) => item.isInvoice === true && item.cardLast4 === '9999',
    );
    expect(fatura).toBeDefined();
    expect(fatura.valor).toBe(6_000);

    // Gasto real (comprasCartao) NÃO inclui o neutro: só a compra real.
    const compras9999 = res.comprasCartao.filter((item: any) => item.cardLast4 === '9999');
    expect(compras9999.reduce((sum: number, item: any) => sum + item.valor, 0)).toBe(1_000);
    expect(compras9999.some((item: any) => /PgConta/i.test(item.descricao))).toBe(false);

    // Devo de cartão considera a fatura cheia (6.000).
    expect(res.devoCartaoTotal).toBe(6_000);
  });

  it('getCardInvoicesYearly agrupa faturas por mês e inclui conta corrente', async () => {
    // Cartão closing 25, due 1: compra em 2026-04-30 vence em 2026-06.
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      {
        valor: 10_000,
        data: new Date('2026-04-30T00:00:00.000Z'),
        status: 'PLANEJADO',
        expense: { cardLast4: '9999', bankLast4: null, tipoDespesa: 'OUTROS' },
      },
      {
        // neutro lançado como cobrança no cartão (sem bankLast4): ENTRA na fatura
        valor: 5_000,
        data: new Date('2026-04-30T00:00:00.000Z'),
        status: 'PLANEJADO',
        expense: { cardLast4: '9999', bankLast4: null, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' },
      },
      {
        // neutro liquidado via conta (bankLast4 set): FORA da fatura E fora da conta
        valor: 7_000,
        data: new Date('2026-04-30T00:00:00.000Z'),
        status: 'PAGO',
        expense: { cardLast4: '9999', bankLast4: '4247', tipoDespesa: 'PAGAMENTO_FATURA_CARTAO' },
      },
      {
        // gasto da conta corrente em maio (sem cartão): ENTRA na série da conta
        valor: 2_500,
        data: new Date('2026-05-10T00:00:00.000Z'),
        status: 'PAGO',
        expense: { cardLast4: null, bankLast4: '4247', tipoDespesa: 'MORADIA' },
      },
      {
        // neutro da conta (movimentação interna): FORA
        valor: 9_000,
        data: new Date('2026-05-12T00:00:00.000Z'),
        status: 'PAGO',
        expense: { cardLast4: null, bankLast4: '4247', tipoDespesa: 'MOVIMENTACAO_INTERNA' },
      },
      {
        // ano diferente: ignorado
        valor: 9_999,
        data: new Date('2025-04-30T00:00:00.000Z'),
        status: 'PAGO',
        expense: { cardLast4: '9999', bankLast4: null, tipoDespesa: 'OUTROS' },
      },
    ]);
    prisma.creditCard.findMany.mockResolvedValue([
      { nickname: 'Latam', last4: '9999', closingDay: 25, dueDay: 1 },
    ]);
    prisma.bankAccount.findMany.mockResolvedValue([
      { nickname: 'Itau', institution: 'ITAU', last4: '4247' },
    ]);

    const res: any = await service.getCardInvoicesYearly(tenantId, projectId, 2026);

    expect(res.year).toBe(2026);
    expect(res.months).toHaveLength(12);
    expect(res.origins.map((o: any) => o.key)).toEqual(['card:9999', 'conta:4247']);
    expect(res.origins.find((o: any) => o.kind === 'conta').nickname).toBe('Itau');

    const jun = res.months.find((m: any) => m.mes === '2026-06');
    expect(jun.porOrigem['card:9999']).toBe(15_000); // 10.000 compra + 5.000 neutro-no-cartão
    expect(jun.porOrigem['conta:4247']).toBe(0);
    expect(jun.total).toBe(15_000);

    const mai = res.months.find((m: any) => m.mes === '2026-05');
    expect(mai.porOrigem['conta:4247']).toBe(2_500); // só o gasto não-neutro da conta
    expect(mai.total).toBe(2_500);

    // Total do ano = faturas + conta (neutros via conta de 7.000 e mov. interna 9.000 fora).
    expect(res.totalAno).toBe(17_500);
  });

  it('getOriginItemsYearly lista despesas da origem aplicando regra de neutros', async () => {
    prisma.project.findMany.mockResolvedValue([
      { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
    ]);
    prisma.creditCard.findFirst.mockResolvedValue({ closingDay: 25, dueDay: 1 });
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      {
        valor: 10_000,
        data: new Date('2026-04-30T00:00:00.000Z'),
        status: 'PLANEJADO',
        expense: {
          tipoDespesa: 'OUTROS',
          titulo: 'Compra real',
          fornecedor: 'Loja',
          cardLast4: '9999',
          bankLast4: null,
          linkedExpenseId: null,
          project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
        },
      },
      {
        valor: 5_000,
        data: new Date('2026-04-30T00:00:00.000Z'),
        status: 'PLANEJADO',
        expense: {
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          titulo: 'PgConta NU',
          fornecedor: 'NU',
          cardLast4: '9999',
          bankLast4: null,
          linkedExpenseId: null,
          project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
        },
      },
    ]);

    const res: any = await service.getOriginItemsYearly(tenantId, projectId, {
      year: 2026,
      kind: 'card',
      last4: '9999',
    });

    expect(res.kind).toBe('card');
    expect(res.last4).toBe('9999');
    // Ambos entram (cobrança neutra no cartão conta na fatura); ambos vencem em 2026-06.
    expect(res.items).toHaveLength(2);
    expect(res.items.every((i: any) => i.mes === '2026-06')).toBe(true);
    expect(res.total).toBe(15_000);
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

  it('consolida projetos: rotula espelho, deduplica alvo e soma planejado de outro projeto em falta pagar', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([
      {
        openingBalanceCents: 100_000,
        openingBalanceDate: new Date('2025-12-31T00:00:00.000Z'),
        last4: '9999',
        nickname: 'Conta',
        institution: 'Banco',
      },
    ]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'esp-1',
        tenantId,
        projectId,
        tipoDespesa: 'OUTROS',
        titulo: 'Material reforma',
        fornecedor: 'Loja',
        valor: 3_000,
        valorTotal: 3_000,
        formaPagamento: 'CONTA_CORRENTE',
        dataPagamento: new Date('2026-06-10T00:00:00.000Z'),
        dataInicioParcela: null,
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '9999',
        createdAt: new Date('2026-06-10T00:00:00.000Z'),
        linkedExpenseId: 'ref-target',
        settledByExpenseId: null,
        project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
      },
      {
        id: 'ref-target',
        tenantId,
        projectId: 'reforma-1',
        tipoDespesa: 'OUTROS',
        titulo: 'Material reforma',
        fornecedor: 'Loja',
        valor: 3_000,
        valorTotal: 3_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-10T00:00:00.000Z'),
        dataInicioParcela: null,
        quantidadeParcela: null,
        status: 'PLANEJADO',
        cardLast4: null,
        bankLast4: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        linkedExpenseId: null,
        settledByExpenseId: 'esp-1',
        project: { id: 'reforma-1', name: 'Reforma Ap', type: 'REFORMA' },
      },
      {
        id: 'ref-plan',
        tenantId,
        projectId: 'reforma-1',
        tipoDespesa: 'OUTROS',
        titulo: 'Pintura',
        fornecedor: 'Pintor',
        valor: 5_000,
        valorTotal: 5_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-20T00:00:00.000Z'),
        dataInicioParcela: null,
        quantidadeParcela: null,
        status: 'PLANEJADO',
        cardLast4: null,
        bankLast4: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        linkedExpenseId: null,
        settledByExpenseId: null,
        project: { id: 'reforma-1', name: 'Reforma Ap', type: 'REFORMA' },
      },
    ]);
    prisma.receipt.findMany.mockResolvedValue([]);
    prisma.cashFlowEntry.findMany.mockResolvedValue([]);
    prisma.creditCard.findMany.mockResolvedValue([]);

    const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

    const esp = res.saidas.find((s: any) => s.id === 'esp-1');
    expect(esp).toBeTruthy();
    expect(esp.projetoOrigem).toEqual(
      expect.objectContaining({ type: 'REFORMA', name: 'Reforma Ap' }),
    );

    expect(res.saidas.some((s: any) => s.id === 'ref-target')).toBe(false);

    const plan = res.saidas.find((s: any) => s.id === 'ref-plan');
    expect(plan).toBeTruthy();
    expect(plan.realizado).toBe(false);
    expect(plan.editavel).toBe(false);
    expect(plan.projetoOrigem).toEqual(expect.objectContaining({ type: 'REFORMA' }));

    expect(res.faltaPagarMes).toBe(5_000);
    expect(res.caixaHoje).toBe(97_000);
    expect(res.saiuMes).toBe(3_000);
    expect(res.sobraPrevista).toBe(92_000);
  });

  it('casa pagamento da fatura pelo valor: vencimento dia 1 pago no mês anterior marca a fatura certa', async () => {
    // Cartão Nubank (closing 24, due 1): a fatura de cada mês é paga no fim do mês
    // ANTERIOR ao vencimento. Casar só por mês marcaria a fatura errada.
    prisma.bankAccount.findMany.mockResolvedValue([]);
    prisma.receipt.findMany.mockResolvedValue([]);
    const purchaseJun = {
      // compra 10/05 → fatura vence em junho (2026-06)
      id: 'buy-jun',
      tenantId,
      projectId,
      tipoDespesa: 'OUTROS',
      titulo: 'Compra junho',
      fornecedor: 'Loja',
      valorTotal: 442_034,
      valor: 442_034,
      formaPagamento: 'A_VISTA',
      dataPagamento: new Date('2026-05-10T00:00:00.000Z'),
      dataInicioParcela: null,
      quantidadeParcela: null,
      status: 'PAGO',
      cardLast4: '3541',
      bankLast4: null,
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
      linkedExpenseId: null,
      settledByExpenseId: null,
      project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
    };
    const purchaseJul = {
      // compra 10/06 → fatura vence em julho (2026-07)
      id: 'buy-jul',
      tenantId,
      projectId,
      tipoDespesa: 'OUTROS',
      titulo: 'Compra julho',
      fornecedor: 'Loja',
      valorTotal: 2_401_031,
      valor: 2_401_031,
      formaPagamento: 'A_VISTA',
      dataPagamento: new Date('2026-06-10T00:00:00.000Z'),
      dataInicioParcela: null,
      quantidadeParcela: null,
      status: 'PAGO',
      cardLast4: '3541',
      bankLast4: null,
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      linkedExpenseId: null,
      settledByExpenseId: null,
      project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
    };
    const payJun = {
      // pago 28/05 (mês anterior ao vencimento) → quita a fatura de junho (442.034)
      id: 'pay-jun',
      tenantId,
      projectId,
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      titulo: 'PIX QRS NU PAGAMENT28/05',
      fornecedor: 'NU PAGAMENTOS',
      valorTotal: 442_034,
      valor: 442_034,
      formaPagamento: 'A_VISTA',
      dataPagamento: new Date('2026-05-28T00:00:00.000Z'),
      dataInicioParcela: null,
      quantidadeParcela: null,
      status: 'PAGO',
      cardLast4: '3541',
      bankLast4: '3636',
      createdAt: new Date('2026-05-28T00:00:00.000Z'),
      linkedExpenseId: null,
      settledByExpenseId: null,
      project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
    };
    const payJul = {
      // pago 22/06 (mês anterior ao vencimento) → quita a fatura de julho (2.401.031)
      // valor 2.401.033 difere por 2 centavos do total da fatura (arredondamento).
      id: 'pay-jul',
      tenantId,
      projectId,
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      titulo: 'PIX QRS NU PAGAMENT22/06',
      fornecedor: 'NU PAGAMENTOS',
      valorTotal: 2_401_033,
      valor: 2_401_033,
      formaPagamento: 'A_VISTA',
      dataPagamento: new Date('2026-06-22T00:00:00.000Z'),
      dataInicioParcela: null,
      quantidadeParcela: null,
      status: 'PAGO',
      cardLast4: '3541',
      bankLast4: '3636',
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      linkedExpenseId: null,
      settledByExpenseId: null,
      project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
    };
    prisma.expense.findMany.mockResolvedValue([purchaseJun, purchaseJul, payJun, payJul]);
    const entryFor = (e: any) => ({
      id: `cfe-${e.id}`,
      tenantId,
      projectId,
      tipo: 'DESPESA',
      valor: e.valorTotal,
      data: e.dataPagamento,
      status: e.status,
      categoria: e.tipoDespesa,
      subcategoria: 'Nubank',
      formaPagamento: 'CARTAO_CREDITO',
      parcela: null,
      expense: {
        id: e.id,
        tipoDespesa: e.tipoDespesa,
        titulo: e.titulo,
        fornecedor: e.fornecedor,
        cardLast4: e.cardLast4,
        bankLast4: e.bankLast4,
        linkedExpenseId: null,
      },
      receipt: null,
    });
    prisma.cashFlowEntry.findMany.mockResolvedValue([entryFor(purchaseJun), entryFor(purchaseJul)]);
    prisma.creditCard.findMany.mockResolvedValue([
      {
        id: 'card-nu',
        tenantId,
        projectId,
        nickname: 'Nubank',
        last4: '3541',
        closingDay: 24,
        dueDay: 1,
        limitTotalCents: null,
        limitAvailableCents: null,
      },
    ]);

    const jul: any = await service.getAccountView(tenantId, projectId, '2026-07');
    const cardJul = jul.cartoes.find((c: any) => c.last4 === '3541');
    expect(cardJul.faturaAtual).toBe(2_401_031);
    expect(cardJul.status).toBe('paga');

    const jun: any = await service.getAccountView(tenantId, projectId, '2026-06');
    const cardJun = jun.cartoes.find((c: any) => c.last4 === '3541');
    expect(cardJun.faturaAtual).toBe(442_034);
    expect(cardJun.status).toBe('paga');
  });

  it('cartão paga cartão: vínculo explícito quita a fatura do cartão pago sem inflar caixa', async () => {
    // Latam (7259) junho 15.677,55: pago por (a) cobrança "Itaú" no Nubank 6.492,40
    // (cartão paga cartão, sem banco) + (b) PIX da conta 9.185,15 (banco 3636).
    // Nubank (3541) maio 5.347,15: pago pela cobrança "PgConta NU" no Latam 5.597,83.
    prisma.bankAccount.findMany.mockResolvedValue([
      { openingBalanceCents: 1_000_000, openingBalanceDate: new Date('2025-12-31T00:00:00.000Z') },
    ]);
    prisma.receipt.findMany.mockResolvedValue([]);
    const baseExp = (over: any) => ({
      tenantId,
      projectId,
      titulo: '',
      fornecedor: '',
      valor: over.valorTotal,
      formaPagamento: 'A_VISTA',
      dataInicioParcela: null,
      quantidadeParcela: null,
      cardLast4: null,
      bankLast4: null,
      linkedExpenseId: null,
      settledByExpenseId: null,
      settlesInvoiceKey: null,
      project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
      ...over,
    });
    // Compra real que compõe a fatura do Latam junho (closing 25/due 1 → compra 30/04).
    // A fatura (1.567.755) = compra real (1.007.972) + cobrança PgConta NU (559.783),
    // espelhando o banco; a PgConta NU também quita o Nubank maio (vínculo explícito).
    const latamReal = baseExp({
      id: 'latam-real',
      tipoDespesa: 'OUTROS',
      titulo: 'Compra Latam',
      valorTotal: 1_007_972,
      dataPagamento: new Date('2026-04-30T00:00:00.000Z'),
      createdAt: new Date('2026-04-30T00:00:00.000Z'),
      status: 'PAGO',
      cardLast4: '7259',
    });
    // Compra real que compõe a fatura do Nubank maio (closing 24/due 1 → compra 30/03)
    const nubankReal = baseExp({
      id: 'nubank-real',
      tipoDespesa: 'OUTROS',
      titulo: 'Compra Nubank',
      valorTotal: 534_715,
      dataPagamento: new Date('2026-03-30T00:00:00.000Z'),
      createdAt: new Date('2026-03-30T00:00:00.000Z'),
      status: 'PAGO',
      cardLast4: '3541',
    });
    // (a) Cobrança no Nubank que paga o Latam jun (cartão paga cartão, sem banco)
    const nubankPaysLatam = baseExp({
      id: 'nubank-pays-latam',
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      titulo: 'Itaú Unibanco S/A',
      valorTotal: 649_240,
      dataPagamento: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      status: 'PLANEJADO',
      cardLast4: '3541',
      settlesInvoiceKey: '7259:2026-06',
    });
    // (b) PIX da conta que paga o resto do Latam jun (banco 3636)
    const pixPaysLatam = baseExp({
      id: 'pix-pays-latam',
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      titulo: 'PIX TRANSF LATAM',
      valorTotal: 918_515,
      dataPagamento: new Date('2026-05-18T00:00:00.000Z'),
      createdAt: new Date('2026-05-18T00:00:00.000Z'),
      status: 'PAGO',
      cardLast4: '7259',
      bankLast4: '3636',
      settlesInvoiceKey: '7259:2026-06',
    });
    // Cobrança no Latam que paga o Nubank maio (cartão paga cartão, com juros)
    const latamPaysNubank = baseExp({
      id: 'latam-pays-nubank',
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      titulo: 'PgConta NU PAGAMENTOS SA',
      valorTotal: 559_783,
      dataPagamento: new Date('2026-04-30T00:00:00.000Z'),
      createdAt: new Date('2026-04-30T00:00:00.000Z'),
      status: 'PAGO',
      cardLast4: '7259',
      settlesInvoiceKey: '3541:2026-05',
    });
    prisma.expense.findMany.mockResolvedValue([
      latamReal,
      nubankReal,
      nubankPaysLatam,
      pixPaysLatam,
      latamPaysNubank,
    ]);
    const cfe = (e: any) => ({
      id: `cfe-${e.id}`,
      tenantId,
      projectId,
      tipo: 'DESPESA',
      valor: e.valorTotal,
      data: e.dataPagamento,
      status: e.status,
      categoria: e.tipoDespesa,
      subcategoria: null,
      formaPagamento: 'CARTAO_CREDITO',
      parcela: null,
      expense: {
        id: e.id,
        tipoDespesa: e.tipoDespesa,
        titulo: e.titulo,
        fornecedor: e.fornecedor,
        cardLast4: e.cardLast4,
        bankLast4: e.bankLast4,
        linkedExpenseId: null,
      },
      receipt: null,
    });
    // Mirror: compras reais + cobranças no cartão (sem banco). PIX (com banco) não espelha.
    prisma.cashFlowEntry.findMany.mockResolvedValue([
      cfe(latamReal),
      cfe(nubankReal),
      cfe(nubankPaysLatam),
      cfe(latamPaysNubank),
    ]);
    prisma.creditCard.findMany.mockResolvedValue([
      {
        id: 'card-latam',
        tenantId,
        projectId,
        nickname: 'Latampass',
        last4: '7259',
        closingDay: 25,
        dueDay: 1,
        limitTotalCents: null,
        limitAvailableCents: null,
      },
      {
        id: 'card-nubank',
        tenantId,
        projectId,
        nickname: 'Nubank',
        last4: '3541',
        closingDay: 24,
        dueDay: 1,
        limitTotalCents: null,
        limitAvailableCents: null,
      },
    ]);

    // Latam junho: quitado pela soma 6.492,40 + 9.185,15.
    const latamJun: any = await service.getAccountView(tenantId, projectId, '2026-06');
    const latam = latamJun.cartoes.find((c: any) => c.last4 === '7259');
    expect(latam.faturaAtual).toBe(1_567_755);
    expect(latam.status).toBe('paga');

    // Nubank maio: quitado pela cobrança no Latam (com juros).
    const nubankMai: any = await service.getAccountView(tenantId, projectId, '2026-05');
    const nubank = nubankMai.cartoes.find((c: any) => c.last4 === '3541');
    expect(nubank.faturaAtual).toBe(534_715);
    expect(nubank.status).toBe('paga');

    // Caixa: só o PIX real (9.185,15) sai da conta. As cobranças cartão-paga-cartão
    // (sem banco) NÃO afetam o caixa → sem inflação.
    expect(latamJun.caixaHoje).toBe(1_000_000 - 918_515);
  });

  it('separa contas com mesmo last4 usando importId e prioriza Itaú como conta principal do caixa', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([
      {
        id: 'acc-itau',
        openingBalanceCents: 100_000,
        openingBalanceDate: new Date('2025-12-31T00:00:00.000Z'),
        last4: '3636',
        nickname: 'Itau',
        institution: 'ITAU',
      },
      {
        id: 'acc-nubank',
        openingBalanceCents: 0,
        openingBalanceDate: null,
        last4: '3636',
        nickname: 'Nubank',
        institution: 'NUBANK',
      },
    ]);
    prisma.bankStatementImport.findMany.mockResolvedValue([{ id: 'imp-nu', accountId: 'acc-nubank' }]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp-itau',
        tenantId,
        projectId,
        tipoDespesa: 'ALIMENTACAO',
        titulo: 'Mercado',
        fornecedor: 'Mercado',
        valorTotal: 2_000,
        valor: 2_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-05T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-05T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '3636',
        importId: null,
        linkedExpenseId: null,
        settledByExpenseId: null,
        settlesInvoiceKey: null,
        project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
      },
      {
        id: 'exp-nubank',
        tenantId,
        projectId,
        tipoDespesa: 'ALIMENTACAO',
        titulo: 'Compra Nubank',
        fornecedor: 'Nubank',
        valorTotal: 7_000,
        valor: 7_000,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-06T00:00:00.000Z'),
        dataInicioParcela: null,
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
        quantidadeParcela: null,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '3636',
        importId: 'imp-nu',
        linkedExpenseId: null,
        settledByExpenseId: null,
        settlesInvoiceKey: null,
        project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
      },
    ]);
    prisma.receipt.findMany.mockResolvedValue([
      {
        id: 'rec-itau',
        tenantId,
        projectId,
        valor: 5_000,
        data: new Date('2026-06-10T00:00:00.000Z'),
        tipo: 'SALARIO',
        descricao: 'Receita Itaú',
        status: 'EM_CAIXA',
        bankLast4: '3636',
        importId: null,
      },
      {
        id: 'rec-nubank',
        tenantId,
        projectId,
        valor: 9_000,
        data: new Date('2026-06-11T00:00:00.000Z'),
        tipo: 'OUTROS',
        descricao: 'Receita Nubank',
        status: 'EM_CAIXA',
        bankLast4: '3636',
        importId: 'imp-nu',
      },
    ]);
    prisma.cashFlowEntry.findMany.mockResolvedValue([]);
    prisma.creditCard.findMany.mockResolvedValue([]);

    const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

    expect(res.caixaHoje).toBe(103_000);
    expect(res.entrouMes).toBe(5_000);
    expect(res.saiuMes).toBe(2_000);
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

  describe('getAccountView — parcelas foreign bank-paid (espelho na conta)', () => {
    const reforma = { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' };

    const base = (over: any) => ({
      tenantId,
      tipoDespesa: 'MAO_DE_OBRA',
      valor: 0,
      valorTotal: 0,
      formaPagamento: 'A_VISTA',
      dataPagamento: null,
      dataInicioParcela: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      quantidadeParcela: null,
      paidParcelas: null,
      status: 'PLANEJADO',
      cardLast4: null,
      bankLast4: null,
      linkedExpenseId: null,
      settledByExpenseId: null,
      settlesInvoiceKey: null,
      importId: null,
      project: null,
      ...over,
    });

    beforeEach(() => {
      prisma.receipt.findMany.mockResolvedValue([]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([]);
      prisma.creditCard.findMany.mockResolvedValue([]);
    });

    it('emite as parcelas FUTURAS não pagas de uma foreign QUINZENAL bank-paid no mês do vencimento', async () => {
      prisma.expense.findMany.mockResolvedValue([
        base({ id: 'esp-0', projectId, titulo: 'PIX RMD ENG', fornecedor: 'RMD ENG',
          valorTotal: 3_000, valor: 3_000, status: 'PAGO', bankLast4: '3636',
          dataPagamento: new Date('2026-05-24T00:00:00.000Z'), linkedExpenseId: 'foreign-q' }),
        base({ id: 'esp-1', projectId, titulo: 'PIX RMD ENG', fornecedor: 'RMD ENG',
          valorTotal: 3_000, valor: 3_000, status: 'PAGO', bankLast4: '3636',
          dataPagamento: new Date('2026-06-08T00:00:00.000Z'), linkedExpenseId: 'foreign-q' }),
        base({ id: 'foreign-q', projectId: reforma.id, titulo: 'Infra Eletrica', fornecedor: 'RMD ENG',
          valorTotal: 12_000, valor: 3_000, formaPagamento: 'QUINZENAL', quantidadeParcela: 4,
          dataInicioParcela: new Date('2026-05-24T00:00:00.000Z'), paidParcelas: '[0,1]',
          status: 'PLANEJADO', project: reforma }),
      ]);

      const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

      const emitida = res.saidas.find(
        (s: any) => s.descricao === 'Infra Eletrica' && s.status === 'PLANEJADO',
      );
      expect(emitida).toBeDefined();
      expect(emitida.valor).toBe(3_000);
      expect(emitida.isInvoice).toBe(false);
      expect(emitida.bankLast4).toBe('3636');
      expect(emitida.projetoOrigem).toEqual(
        expect.objectContaining({ id: 'reforma-1', type: 'REFORMA' }),
      );
      expect(emitida.data.slice(0, 10)).toBe('2026-06-23');

      const parcelasReforma = res.saidas.filter(
        (s: any) => s.descricao === 'Infra Eletrica' && s.status === 'PLANEJADO',
      );
      expect(parcelasReforma).toHaveLength(1);
      expect(res.saidas.some((s: any) => s.valor === 12_000)).toBe(false);
      expect(res.faltaPagarMes).toBe(3_000);
    });

    it('NÃO emite saída de conta para foreign PARCELADO paga por CARTÃO (evita dupla contagem)', async () => {
      prisma.creditCard.findMany.mockResolvedValue([
        { id: 'c-5572', tenantId, projectId, nickname: 'Cartão', last4: '5572',
          closingDay: 20, dueDay: 28, limitTotalCents: 100_000, limitAvailableCents: 50_000 },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        base({ id: 'esp-card', projectId, titulo: 'Calhas parcela', fornecedor: 'Calhas',
          valorTotal: 4_000, valor: 4_000, status: 'PLANEJADO', cardLast4: '5572',
          formaPagamento: 'PARCELADO', quantidadeParcela: 2,
          dataInicioParcela: new Date('2026-06-10T00:00:00.000Z'), linkedExpenseId: 'foreign-p' }),
        base({ id: 'foreign-p', projectId: reforma.id, titulo: 'Calhas e Rufos', fornecedor: 'Calhas',
          valorTotal: 8_000, valor: 4_000, formaPagamento: 'PARCELADO', quantidadeParcela: 2,
          dataInicioParcela: new Date('2026-06-10T00:00:00.000Z'), status: 'PLANEJADO', project: reforma }),
      ]);

      const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

      const contaReforma = res.saidas.filter(
        (s: any) => s.isInvoice === false && s.projetoOrigem?.type === 'REFORMA',
      );
      expect(contaReforma).toHaveLength(0);
      expect(res.saidas.some((s: any) => s.bankLast4 === '5572')).toBe(false);
    });

    it('mantém excluída a foreign À VISTA quitada por espelho bank (não re-emite)', async () => {
      prisma.expense.findMany.mockResolvedValue([
        base({ id: 'esp-av', projectId, titulo: 'PIX à vista', fornecedor: 'Loja',
          valorTotal: 5_000, valor: 5_000, status: 'PAGO', bankLast4: '3636',
          dataPagamento: new Date('2026-06-05T00:00:00.000Z'), linkedExpenseId: 'foreign-av' }),
        base({ id: 'foreign-av', projectId: reforma.id, titulo: 'Material à vista', fornecedor: 'Loja',
          valorTotal: 5_000, valor: 5_000, formaPagamento: 'A_VISTA', status: 'PLANEJADO',
          dataPagamento: new Date('2026-06-05T00:00:00.000Z'), project: reforma }),
      ]);

      const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

      const planejadasReforma = res.saidas.filter(
        (s: any) => s.projetoOrigem?.type === 'REFORMA' && s.status !== 'PAGO',
      );
      expect(planejadasReforma).toHaveLength(0);
      expect(res.faltaPagarMes).toBe(0);
    });

    it('preserva o lump (valorTotal) para foreign SEM espelho (não linkada)', async () => {
      prisma.expense.findMany.mockResolvedValue([
        base({ id: 'foreign-nl', projectId: reforma.id, titulo: 'Material avulso', fornecedor: 'Obramax',
          valorTotal: 7_000, valor: 7_000, formaPagamento: 'A_VISTA', status: 'PLANEJADO',
          dataPagamento: new Date('2026-06-15T00:00:00.000Z'), project: reforma }),
      ]);

      const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

      const lump = res.saidas.find((s: any) => s.descricao === 'Material avulso');
      expect(lump).toBeDefined();
      expect(lump.valor).toBe(7_000);
      expect(lump.bankLast4).toBeNull();
      expect(lump.projetoOrigem).toEqual(expect.objectContaining({ type: 'REFORMA' }));
      expect(lump.data.slice(0, 10)).toBe('2026-06-15');
      expect(res.faltaPagarMes).toBe(7_000);
    });

    it('rateio multi-alvo: suprime TODOS os alvos (fonte cobre) — sem lump nem dupla contagem', async () => {
      // Fonte PESSOAL no cartão 5572, PARCELADO 2x; rateada entre 2 alvos REFORMA.
      // Só o 1º alvo recebe linkedExpenseId; sem a supressão por RateioAllocation o
      // 2º alvo viraria lump (valorTotal na data de compra) e inflaria a projeção.
      prisma.creditCard.findMany.mockResolvedValue([
        { id: 'c-5572', tenantId, projectId, nickname: 'Cartão', last4: '5572',
          closingDay: 20, dueDay: 28, limitTotalCents: 100_000, limitAvailableCents: 50_000 },
      ]);
      prisma.rateioAllocation.findMany.mockResolvedValue([
        { sourceExpenseId: 'src-rat', targetExpenseId: 'tgt-a' },
        { sourceExpenseId: 'src-rat', targetExpenseId: 'tgt-b' },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        base({ id: 'src-rat', projectId, titulo: 'Compras TelhaNorte', fornecedor: 'TelhaNorte',
          valorTotal: 8_000, valor: 4_000, status: 'PLANEJADO', cardLast4: '5572',
          formaPagamento: 'PARCELADO', quantidadeParcela: 2,
          dataInicioParcela: new Date('2026-06-10T00:00:00.000Z'), linkedExpenseId: 'tgt-a' }),
        base({ id: 'tgt-a', projectId: reforma.id, titulo: 'Piso', fornecedor: 'TelhaNorte',
          valorTotal: 5_000, valor: 2_500, formaPagamento: 'PARCELADO', quantidadeParcela: 2,
          dataInicioParcela: new Date('2026-06-10T00:00:00.000Z'), status: 'PLANEJADO', project: reforma }),
        base({ id: 'tgt-b', projectId: reforma.id, titulo: 'Areia', fornecedor: 'TelhaNorte',
          valorTotal: 3_000, valor: 1_500, formaPagamento: 'PARCELADO', quantidadeParcela: 2,
          dataInicioParcela: new Date('2026-06-10T00:00:00.000Z'), status: 'PLANEJADO', project: reforma }),
      ]);

      const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

      // Nenhum alvo REFORMA vira saída de conta (a fatura do cartão da fonte cobre).
      const contaReforma = res.saidas.filter(
        (s: any) => s.isInvoice === false && s.projetoOrigem?.type === 'REFORMA',
      );
      expect(contaReforma).toHaveLength(0);
      // Especificamente o 2º alvo (não linkado) não pode virar lump.
      expect(res.saidas.some((s: any) => s.descricao === 'Areia')).toBe(false);
      expect(res.saidas.some((s: any) => s.valor === 3_000)).toBe(false);
    });
  });
});

describe('matchPaidInvoices', () => {
  const inv = (dueMonth: string, cardLast4: string, total: number) => ({
    dueMonth,
    cardLast4,
    total,
  });
  const pay = (payMonth: string, cardLast4: string, amount: number) => ({
    payMonth,
    cardLast4,
    amount,
  });

  it('casa o pagamento pela proximidade de valor dentro da janela {payMonth, payMonth+1}', () => {
    // Nubank: junho 4420.34 pago em 2026-05; julho 24010.31 pago em 2026-06 (24010.33).
    const invoices = [inv('2026-06', '3541', 442_034), inv('2026-07', '3541', 2_401_031)];
    const payments = [pay('2026-05', '3541', 442_034), pay('2026-06', '3541', 2_401_033)];
    const paid = matchPaidInvoices(invoices, payments);
    expect(paid.has('2026-06__3541')).toBe(true);
    expect(paid.has('2026-07__3541')).toBe(true);
    expect(paid.size).toBe(2);
  });

  it('não deixa um pagamento do mês anterior marcar a fatura de menor valor do mesmo mês', () => {
    // O pagamento de 22/06 (24010.33) NÃO pode marcar junho (4420.34): junho já foi
    // quitado pelo pagamento de maio; o de junho deve cair em julho.
    const invoices = [inv('2026-06', '3541', 442_034), inv('2026-07', '3541', 2_401_031)];
    const payments = [pay('2026-06', '3541', 2_401_033)];
    const paid = matchPaidInvoices(invoices, payments);
    expect(paid.has('2026-07__3541')).toBe(true);
    expect(paid.has('2026-06__3541')).toBe(false);
    expect(paid.size).toBe(1);
  });

  it('preserva o casamento no mesmo mês quando o pagamento ocorre no mês do vencimento', () => {
    const invoices = [inv('2026-06', '1111', 7_000), inv('2026-07', '1111', 2_000)];
    const payments = [pay('2026-06', '1111', 7_000)];
    const paid = matchPaidInvoices(invoices, payments);
    expect(paid.has('2026-06__1111')).toBe(true);
    expect(paid.has('2026-07__1111')).toBe(false);
  });

  it('isola por cartão e ignora pagamento sem fatura na janela', () => {
    const invoices = [inv('2026-06', 'AAAA', 1_000)];
    const payments = [pay('2026-06', 'BBBB', 1_000), pay('2026-01', 'AAAA', 1_000)];
    const paid = matchPaidInvoices(invoices, payments);
    expect(paid.size).toBe(0);
  });

  it('consome cada fatura uma única vez (dois pagamentos, duas faturas distintas)', () => {
    const invoices = [inv('2026-06', '9999', 5_000), inv('2026-07', '9999', 5_000)];
    const payments = [pay('2026-05', '9999', 5_000), pay('2026-06', '9999', 5_000)];
    const paid = matchPaidInvoices(invoices, payments);
    expect(paid.has('2026-06__9999')).toBe(true);
    expect(paid.has('2026-07__9999')).toBe(true);
    expect(paid.size).toBe(2);
  });

  it('sem pagamentos retorna conjunto vazio', () => {
    const invoices = [inv('2026-06', '3541', 442_034)];
    expect(matchPaidInvoices(invoices, []).size).toBe(0);
  });
});

describe('computePaidInvoiceKeys', () => {
  const inv = (dueMonth: string, cardLast4: string, total: number) => ({
    dueMonth,
    cardLast4,
    total,
  });
  const pay = (payMonth: string, cardLast4: string, amount: number) => ({
    payMonth,
    cardLast4,
    amount,
  });
  const set = (targetKey: string, amount: number) => ({ targetKey, amount });

  it('mantém o casamento implícito por valor quando não há vínculos explícitos', () => {
    const invoices = [inv('2026-06', '3541', 442_034), inv('2026-07', '3541', 2_401_031)];
    const implicit = [pay('2026-05', '3541', 442_034), pay('2026-06', '3541', 2_401_033)];
    const paid = computePaidInvoiceKeys(invoices, implicit, []);
    expect(paid.has('2026-06__3541')).toBe(true);
    expect(paid.has('2026-07__3541')).toBe(true);
  });

  it('quita por vínculo explícito quando a soma cobre o total (cartão paga cartão + juros)', () => {
    // Nubank maio 5.347,15 pago pela cobrança "PgConta NU" no Latam (5.597,83 com juros).
    const invoices = [inv('2026-05', '3541', 534_715)];
    const explicit = [set('2026-05__3541', 559_783)];
    const paid = computePaidInvoiceKeys(invoices, [], explicit);
    expect(paid.has('2026-05__3541')).toBe(true);
    expect(paid.size).toBe(1);
  });

  it('soma vínculos parciais (cartão + PIX) para quitar a fatura', () => {
    // Latam junho 15.677,55 = 6.492,40 (cobrança no Nubank) + 9.185,15 (PIX conta).
    const invoices = [inv('2026-06', '7259', 1_567_755)];
    const explicit = [set('2026-06__7259', 649_240), set('2026-06__7259', 918_515)];
    const paid = computePaidInvoiceKeys(invoices, [], explicit);
    expect(paid.has('2026-06__7259')).toBe(true);
  });

  it('NÃO quita quando os vínculos explícitos não cobrem o total', () => {
    const invoices = [inv('2026-06', '7259', 1_567_755)];
    const explicit = [set('2026-06__7259', 649_240)]; // só parte
    const paid = computePaidInvoiceKeys(invoices, [], explicit);
    expect(paid.has('2026-06__7259')).toBe(false);
    expect(paid.size).toBe(0);
  });

  it('combina implícito e explícito sem interferência entre faturas', () => {
    const invoices = [
      inv('2026-05', '3541', 534_715),
      inv('2026-06', '7259', 1_567_755),
      inv('2026-07', '3541', 2_401_031),
    ];
    const implicit = [pay('2026-06', '3541', 2_401_033)]; // quita jul por valor
    const explicit = [
      set('2026-05__3541', 559_783), // quita maio (juros)
      set('2026-06__7259', 649_240),
      set('2026-06__7259', 918_515), // soma quita Latam jun
    ];
    const paid = computePaidInvoiceKeys(invoices, implicit, explicit);
    expect(paid.has('2026-05__3541')).toBe(true);
    expect(paid.has('2026-06__7259')).toBe(true);
    expect(paid.has('2026-07__3541')).toBe(true);
    expect(paid.size).toBe(3);
  });
});
