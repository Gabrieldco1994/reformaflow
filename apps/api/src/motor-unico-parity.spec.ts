// Motor Único (Fase E): prova que o motor consolidado do /financeiro (tenant-financial)
// converge para o MESMO número do §10 (computeCaixaConta), a partir de UM fixture, com
// serviços REAIS. Cadeia canônica:
//   - getCaixaConta            → §10 (delegador; fonte do tenant-financial / /financeiro)
//   - tenant-financial.caixaTotal → deve ser IDÊNTICO a getCaixaConta.hoje
// Escopo: este spec pina o HEADLINE de caixa (getAccountView.caixaHoje e
// getOverview.caixa.hoje) que /monthly, /conta e /cash-flow renderizam — já coberto por
// monthly-overview.account-view.spec.ts e monthly-overview.service.spec.ts (fixtures
// completos), o MESMO computeCaixaConta. NÃO cobre o saldo por-linha (rollingBalance) do
// CashFlowService, que hoje é orçamentário e não ancora no §10 (ver issue #96).
import { Test, TestingModule } from '@nestjs/testing';
import {
  MonthlyOverviewService,
  computeCaixaConta,
  type CaixaContaAccount,
  type CaixaContaExpense,
  type CaixaContaReceipt,
} from './monthly-overview/monthly-overview.service';
import { TenantFinancialService } from './tenant-financial/tenant-financial.service';
import { PrismaService } from './prisma/prisma.service';
import { CardInvoiceSettlementService } from './credit-card/card-invoice-settlement.service';

const TENANT = 'tenant-1';
const PESSOAL = 'pessoal-1';
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// Fixture PESSOAL com DUAS contas — a primária é eleita pela ÂNCORA do saldo inicial
// (openingBalanceDate/cents), não por instituição. acc2 é isca SEM âncora: o §10 NÃO
// deve elegê-la (regressão do literal '3636' morto). Movimentos são da conta primária.
const accounts = [
  { id: 'acc1', openingBalanceCents: 1_000_000, openingBalanceDate: D('2025-12-31'),
    last4: '0001', nickname: 'Conta Principal', institution: 'Banco X' },
  { id: 'acc2', openingBalanceCents: 0, openingBalanceDate: null,
    last4: '0002', nickname: 'Conta Isca', institution: 'Banco Y' },
];
const expenses = [
  { valorTotal: 250_000, status: 'PAGO', dataPagamento: D('2026-02-10'), createdAt: D('2026-02-10'),
    bankLast4: '0001', importId: null }, // −R$2.500 realizado
  { valorTotal: 900_000, status: 'PLANEJADO', dataPagamento: D('2026-07-01'), createdAt: D('2026-06-01'),
    bankLast4: '0001', importId: null }, // futuro → §10 ignora
];
const receipts = [
  { valor: 300_000, status: 'EM_CAIXA', data: D('2026-03-01'), bankLast4: '0001', importId: null }, // +R$3.000
  { valor: 500_000, status: 'PREVISTO', data: D('2026-06-30'), bankLast4: '0001', importId: null }, // §10 ignora
];

// Oracle = §10 primary-only (conta ancorada acc1); a isca acc2 fica de fora por construção.
const ORACLE = computeCaixaConta(
  [accounts[0]] as unknown as CaixaContaAccount[],
  expenses as unknown as CaixaContaExpense[],
  receipts as unknown as CaixaContaReceipt[],
); // hoje = 1_000_000 − 250_000 + 300_000 = 1_050_000

describe('Motor Único — paridade §10 entre os consumidores (mesmo fixture, serviços reais)', () => {
  let monthly: MonthlyOverviewService;
  let tenantFinancial: TenantFinancialService;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(D('2026-06-15'));
    const prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', deletedAt: null }),
        findMany: jest.fn().mockResolvedValue([{ id: PESSOAL, name: 'Pessoal', type: 'PESSOAL' }]),
        count: jest.fn().mockResolvedValue(1),
      },
      bankAccount: { findMany: jest.fn().mockResolvedValue(accounts), findFirst: jest.fn() },
      expense: { findMany: jest.fn().mockResolvedValue(expenses), create: jest.fn() },
      receipt: { findMany: jest.fn().mockResolvedValue(receipts) },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
      creditCard: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
      crossProjectSettlement: { findMany: jest.fn().mockResolvedValue([]) },
      rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      bankStatementImport: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const settlement = { settleInvoice: jest.fn().mockResolvedValue({ settledExpenses: 0, settledParcelas: 0 }) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        TenantFinancialService,
        { provide: PrismaService, useValue: prisma },
        { provide: CardInvoiceSettlementService, useValue: settlement },
      ],
    }).compile();

    monthly = moduleRef.get(MonthlyOverviewService);
    tenantFinancial = moduleRef.get(TenantFinancialService);
  });

  afterEach(() => jest.useRealTimers());

  it('oracle §10 (pin): 1.000.000 − 250.000 + 300.000 = 1.050.000', () => {
    expect(ORACLE.hoje).toBe(1_050_000);
  });

  it('getCaixaConta.hoje === §10', async () => {
    const r = await monthly.getCaixaConta(TENANT, PESSOAL);
    expect(r.hoje).toBe(ORACLE.hoje);
  });

  // Tela /monthly: caixa.hoje sai do MESMO método privado (computeCaixaConta) que o
  // delegador — prova explícita de que a 3ª tela do §10 converge no mesmo fixture.
  it('monthly.getOverview.caixa.hoje === §10 (tela /monthly)', async () => {
    const overview = await monthly.getOverview(TENANT, PESSOAL);
    expect(overview.caixa.hoje).toBe(ORACLE.hoje);
  });

  it('tenant-financial.caixaTotal === §10 (motor consolidado do /financeiro)', async () => {
    const overview = await tenantFinancial.getOverview(TENANT, null);
    expect(overview.caixaTotal).toBe(ORACLE.hoje);
  });

  it('tenant-financial.caixaTotal === getCaixaConta.hoje === monthly.getOverview.caixa.hoje === §10 (paridade do motor único)', async () => {
    const [caixa, overview, monthlyOverview] = await Promise.all([
      monthly.getCaixaConta(TENANT, PESSOAL),
      tenantFinancial.getOverview(TENANT, null),
      monthly.getOverview(TENANT, PESSOAL),
    ]);
    // As três telas do §10 (delegador, /financeiro, /monthly) convergem no MESMO número.
    expect(overview.caixaTotal).toBe(caixa.hoje);
    expect(monthlyOverview.caixa.hoje).toBe(caixa.hoje);
    expect(caixa.hoje).toBe(ORACLE.hoje);
  });
});
