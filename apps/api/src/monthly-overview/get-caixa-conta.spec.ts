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
  ];
  const receipts = [
    { valor: 300_000, status: 'EM_CAIXA', data: D('2026-03-01'), bankLast4: '3636', importId: null }, // +R$3.000
    { valor: 500_000, status: 'PREVISTO', data: D('2026-06-30'), bankLast4: '3636', importId: null }, // §10 ignora
  ];

  beforeEach(async () => {
    const prisma = {
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

  it('hoje = saldoInicial + Σ realizados da conta (=1.050.000) — bate com o oracle puro', async () => {
    const oracle = computeCaixaConta(
      accounts as CaixaContaAccount[],
      expenses as unknown as CaixaContaExpense[],
      receipts as unknown as CaixaContaReceipt[],
    );
    expect(oracle.hoje).toBe(1_050_000); // pin explícito

    const r = await service.getCaixaConta('t1', 'pessoal-1');

    expect(r.hoje).toBe(1_050_000);   // §10, não 0 nem 900k nem 500k
    expect(r.hoje).toBe(oracle.hoje); // paridade com a função pura congelada
    expect(r.saldoInicial).toBe(1_000_000);
    expect(r.temSaldoInicial).toBe(true);
  });
});
