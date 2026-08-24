// Prova I1/I3 na FONTE: o delegador público `getCaixaConta` devolve exatamente o
// número da função pura congelada `computeCaixaConta` (§10), sem mock do motor.
import { Test, TestingModule } from '@nestjs/testing';
import {
  MonthlyOverviewService,
  computeCaixaConta,
  type CaixaContaAccount,
  type CaixaContaExpense,
  type CaixaContaReceipt,
} from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('MonthlyOverviewService.getCaixaConta — delegador público do §10 (congelado)', () => {
  let service: MonthlyOverviewService;
  let prisma: any;

  // Dataset PESSOAL: conta Itaú 3636 com saldo inicial + 1 débito PAGO + 1 crédito EM_CAIXA.
  const accounts = [
    { id: 'acc1', openingBalanceCents: 1_000_000, openingBalanceDate: D('2025-12-31'),
      last4: '3636', nickname: 'Itau', institution: 'Itau' },
  ];
  const expenses = [
    { valorTotal: 250_000, status: 'PAGO', dataPagamento: D('2026-02-10'), createdAt: D('2026-02-10'),
      bankLast4: '3636', importId: null }, // −R$2.500
    { valorTotal: 900_000, status: 'PLANEJADO', dataPagamento: D('2026-07-01'), createdAt: D('2026-06-01'),
      bankLast4: '3636', importId: null }, // futuro → §10 ignora
    {
      valorTotal: 30_000,
      status: 'PLANEJADO',
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: D('2026-04-10'),
      dataPagamento: null,
      paidParcelas: '[0]',
      installmentDateOverrides: null,
      createdAt: D('2026-04-01'),
      bankLast4: '3636',
      importId: null,
    }, // somente a parcela realizada de R$ 100
  ];
  const receipts = [
    { valor: 300_000, status: 'EM_CAIXA', data: D('2026-03-01'), bankLast4: '3636', importId: null }, // +R$3.000
    { valor: 500_000, status: 'PREVISTO', data: D('2026-06-30'), bankLast4: '3636', importId: null }, // §10 ignora
  ];

  beforeEach(async () => {
    prisma = {
      bankAccount: { findMany: jest.fn().mockResolvedValue(accounts) },
      expense: { findMany: jest.fn().mockResolvedValue(expenses) },
      receipt: { findMany: jest.fn().mockResolvedValue(receipts) },
      bankStatementImport: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: CardInvoiceSettlementService, useValue: {} }, // não usado por getCaixaConta
      ],
    }).compile();
    service = moduleRef.get(MonthlyOverviewService);
  });

  it('hoje = saldoInicial + Σ realizados da conta (=1.040.000) — bate com o oracle puro', async () => {
    const oracle = computeCaixaConta(
      accounts as CaixaContaAccount[],
      expenses as unknown as CaixaContaExpense[],
      receipts as unknown as CaixaContaReceipt[],
    );
    expect(oracle.hoje).toBe(1_040_000); // pin explícito

    const r = await service.getCaixaConta('t1', 'pessoal-1');

    expect(r.hoje).toBe(1_040_000);   // §10, não 0 nem 900k nem 500k
    expect(r.hoje).toBe(oracle.hoje); // paridade com a função pura congelada
    expect(r.saldoInicial).toBe(1_000_000);
    expect(r.temSaldoInicial).toBe(true);
  });

  it('expõe carteiraHoje na rota estreita sem montar a Visão Conta completa', async () => {
    prisma.expense.findMany.mockResolvedValue([
      {
        valorTotal: 12_500,
        status: 'PAGO',
        formaPagamento: 'A_VISTA',
        quantidadeParcela: null,
        dataPagamento: D('2026-03-10'),
        dataInicioParcela: null,
        dataCompra: null,
        paidParcelas: null,
        installmentDateOverrides: null,
        createdAt: D('2026-03-10'),
        cardLast4: null,
        bankLast4: null,
        importId: null,
        tipoDespesa: 'ALIMENTACAO',
        settledByExpenseId: null,
      },
    ]);
    prisma.receipt.findMany.mockResolvedValue([
      { valor: 2_500, status: 'EM_CAIXA', data: D('2026-03-12'), bankLast4: null, importId: null },
    ]);

    const r = await service.getCaixaConta('t1', 'pessoal-1');

    expect(r.hoje).toBe(1_000_000);
    expect(r.carteiraHoje).toBe(-10_000);
  });

  it('aplica o mesmo hoje BRT ao caixa e à Carteira, excluindo realizados futuros', async () => {
    const today = D('2026-06-30');
    prisma.expense.findMany.mockResolvedValue([
      {
        valorTotal: 10_000,
        status: 'PAGO',
        formaPagamento: 'A_VISTA',
        dataPagamento: today,
        createdAt: today,
        bankLast4: '3636',
        importId: null,
      },
      {
        valorTotal: 20_000,
        status: 'PAGO',
        formaPagamento: 'A_VISTA',
        dataPagamento: D('2026-07-01'),
        createdAt: D('2026-07-01'),
        bankLast4: '3636',
        importId: null,
      },
      {
        valorTotal: 1_000,
        status: 'PAGO',
        formaPagamento: 'A_VISTA',
        dataPagamento: today,
        createdAt: today,
        cardLast4: null,
        bankLast4: null,
        importId: null,
        tipoDespesa: 'ALIMENTACAO',
        settledByExpenseId: null,
      },
      {
        valorTotal: 2_000,
        status: 'PAGO',
        formaPagamento: 'A_VISTA',
        dataPagamento: D('2026-07-01'),
        createdAt: D('2026-07-01'),
        cardLast4: null,
        bankLast4: null,
        importId: null,
        tipoDespesa: 'ALIMENTACAO',
        settledByExpenseId: null,
      },
    ]);
    prisma.receipt.findMany.mockResolvedValue([
      {
        valor: 500,
        status: 'EM_CAIXA',
        data: today,
        bankLast4: null,
        importId: null,
      },
      {
        valor: 5_000,
        status: 'EM_CAIXA',
        data: D('2026-07-01'),
        bankLast4: null,
        importId: null,
      },
    ]);

    const result = await service.getCaixaConta('t1', 'pessoal-1', today);

    expect(result.hoje).toBe(990_000);
    expect(result.carteiraHoje).toBe(-500);
  });
});

describe('computeCaixaConta — corte pelo saldo inicial (§10)', () => {
  const contas = [{ openingBalanceCents: 1_428_597, openingBalanceDate: D('2025-12-31') }];

  it('ignora lançamentos ANTERIORES ao saldo inicial (não conta o mesmo dinheiro 2x)', () => {
    // Caso real de produção: 3 recebimentos de nov/dez-2025 estavam sendo somados
    // sobre um saldo inicial datado de 31/12/2025 — R$ 5.489,44 contados em dobro.
    const receipts = [
      { valor: 547_823, status: 'EM_CAIXA', data: D('2025-12-15') },
      { valor: 1_103, status: 'EM_CAIXA', data: D('2025-11-30') },
      { valor: 18, status: 'EM_CAIXA', data: D('2025-11-28') },
      { valor: 100_000, status: 'EM_CAIXA', data: D('2026-01-10') }, // depois: conta
    ];

    const r = computeCaixaConta(
      contas as CaixaContaAccount[],
      [] as CaixaContaExpense[],
      receipts as CaixaContaReceipt[],
    );

    expect(r.hoje).toBe(1_428_597 + 100_000);
    expect(r.porMes.map((m) => m.mes)).toEqual(['2026-01']);
  });

  it('lançamento NO DIA do saldo inicial conta (saldo é da abertura do dia)', () => {
    const r = computeCaixaConta(
      contas as CaixaContaAccount[],
      [] as CaixaContaExpense[],
      [{ valor: 50_000, status: 'EM_CAIXA', data: D('2025-12-31') }] as CaixaContaReceipt[],
    );
    expect(r.hoje).toBe(1_428_597 + 50_000);
  });

  it('sem data de saldo inicial, nada é cortado', () => {
    const r = computeCaixaConta(
      [{ openingBalanceCents: 0, openingBalanceDate: null }] as CaixaContaAccount[],
      [] as CaixaContaExpense[],
      [{ valor: 547_823, status: 'EM_CAIXA', data: D('2020-01-01') }] as CaixaContaReceipt[],
    );
    expect(r.hoje).toBe(547_823);
  });

  it('corta parcela anterior ao saldo inicial sem descartar as posteriores', () => {
    const despesa = {
      valorTotal: 300_000,
      status: 'PAGO',
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: D('2025-11-30'),
      dataPagamento: null,
      createdAt: D('2025-11-30'),
    };
    const r = computeCaixaConta(
      contas as CaixaContaAccount[],
      [despesa] as unknown as CaixaContaExpense[],
      [] as CaixaContaReceipt[],
    );
    // parcelas: 30/11 (cortada), 30/12 (cortada), 30/01 (conta)
    expect(r.hoje).toBe(1_428_597 - 100_000);
  });
});
