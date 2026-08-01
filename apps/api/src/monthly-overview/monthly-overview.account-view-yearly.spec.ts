import { Test, TestingModule } from "@nestjs/testing";
import { MonthlyOverviewService } from "./monthly-overview.service";
import { PrismaService } from "../prisma/prisma.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";

// Invariante central da consolidação anual (Opção B): o ano é 12x
// getAccountView consolidado, nunca uma segunda agregação. Este teste prova
// estruturalmente que soma(saidas/entradas/fluxos dos 12 meses) == retorno do
// getAccountViewYearly, e que os saldos pontuais (caixaHoje/carteiraHoje) não
// são somados 12x.
describe("MonthlyOverviewService.getAccountViewYearly", () => {
  let service: MonthlyOverviewService;
  let prisma: any;

  const tenantId = "tenant-1";
  const projectId = "pessoal-1";

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    prisma = {
      project: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            id: projectId,
            tenantId,
            type: "PESSOAL",
            deletedAt: null,
          }),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: projectId, name: "Pessoal", type: "PESSOAL" },
          ]),
      },
      bankAccount: {
        findMany: jest.fn().mockResolvedValue([
          {
            openingBalanceCents: 100_000,
            openingBalanceDate: new Date("2025-12-31T00:00:00.000Z"),
          },
        ]),
        findFirst: jest.fn(),
      },
      expense: {
        findMany: jest.fn().mockResolvedValue([
          // uma despesa paga em cada um de dois meses diferentes do ano-alvo
          {
            id: "exp-jan",
            tenantId,
            projectId,
            tipoDespesa: "ALIMENTACAO",
            titulo: "Mercado jan",
            fornecedor: "Mercado",
            valorTotal: 5_000,
            valor: 5_000,
            formaPagamento: "A_VISTA",
            dataPagamento: new Date("2026-01-10T00:00:00.000Z"),
            dataInicioParcela: null,
            createdAt: new Date("2026-01-10T00:00:00.000Z"),
            quantidadeParcela: null,
            status: "PAGO",
            cardLast4: null,
            bankLast4: "4247",
          },
          {
            id: "exp-mar",
            tenantId,
            projectId,
            tipoDespesa: "MORADIA",
            titulo: "Aluguel mar",
            fornecedor: "Imobiliaria",
            valorTotal: 8_000,
            valor: 8_000,
            formaPagamento: "A_VISTA",
            dataPagamento: new Date("2026-03-05T00:00:00.000Z"),
            dataInicioParcela: null,
            createdAt: new Date("2026-03-05T00:00:00.000Z"),
            quantidadeParcela: null,
            status: "PLANEJADO",
            cardLast4: null,
            bankLast4: "4247",
          },
          // compra de CARTÃO (sem conta): entra em comprasCartao/fatura, não em
          // saidas. Fixture necessária para exercitar devoCartaoTotal (> 0) e a
          // divergência do ticket médio (o mensal conta compras de cartão).
          {
            id: "exp-card-abr",
            tenantId,
            projectId,
            tipoDespesa: "ALIMENTACAO",
            titulo: "Restaurante abr",
            fornecedor: "Restaurante",
            valorTotal: 3_000,
            valor: 3_000,
            formaPagamento: "CREDITO",
            dataPagamento: new Date("2026-04-10T00:00:00.000Z"),
            dataInicioParcela: null,
            createdAt: new Date("2026-04-10T00:00:00.000Z"),
            quantidadeParcela: null,
            status: "PLANEJADO",
            cardLast4: "1234",
            bankLast4: null,
          },
        ]),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      receipt: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "rec-fev",
            tenantId,
            projectId,
            tipo: "SALARIO",
            descricao: "Salario fev",
            valor: 10_000,
            data: new Date("2026-02-05T00:00:00.000Z"),
            status: "EM_CAIXA",
            bankLast4: "4247",
          },
        ]),
      },
      cashFlowEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "cfe-card-abr",
            tenantId,
            projectId,
            tipo: "DESPESA",
            data: new Date("2026-04-10T00:00:00.000Z"),
            valor: 3_000,
            expense: {
              id: "exp-card-abr",
              tipoDespesa: "ALIMENTACAO",
              titulo: "Restaurante abr",
              fornecedor: "Restaurante",
              cardLast4: "1234",
              bankLast4: null,
              linkedExpenseId: null,
            },
            receipt: null,
          },
        ]),
      },
      creditCard: {
        findMany: jest.fn().mockResolvedValue([
          {
            nickname: "Cartao Teste",
            last4: "1234",
            closingDay: 25,
            dueDay: 5,
            limitTotalCents: 1_000_000,
            limitAvailableCents: 500_000,
          },
        ]),
      },
      crossProjectSettlement: { findMany: jest.fn().mockResolvedValue([]) },
      rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      invoiceAdjustment: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
      },
      bankStatementImport: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const settlement = {
      settleInvoice: jest
        .fn()
        .mockResolvedValue({ settledExpenses: 0, settledParcelas: 0 }),
    };

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

  it("ano == soma dos 12 meses para listas e fluxos", async () => {
    const yearly = await service.getAccountViewYearly(tenantId, projectId, 2026);

    const months = Array.from(
      { length: 12 },
      (_, i) => `2026-${String(i + 1).padStart(2, "0")}`,
    );
    const monthly = await Promise.all(
      months.map((m) => service.getAccountView(tenantId, projectId, m)),
    );

    expect(yearly.saidas.length).toBe(
      monthly.reduce((sum, m) => sum + m.saidas.length, 0),
    );
    expect(yearly.entradas.length).toBe(
      monthly.reduce((sum, m) => sum + m.entradas.length, 0),
    );
    expect(yearly.comprasCartao.length).toBe(
      monthly.reduce((sum, m) => sum + m.comprasCartao.length, 0),
    );
    expect(yearly.entrouMes).toBe(monthly.reduce((sum, m) => sum + m.entrouMes, 0));
    expect(yearly.saiuMes).toBe(monthly.reduce((sum, m) => sum + m.saiuMes, 0));
    expect(yearly.faltaPagarMes).toBe(
      monthly.reduce((sum, m) => sum + m.faltaPagarMes, 0),
    );
    expect(yearly.recebimentosPrevistosMes).toBe(
      monthly.reduce((sum, m) => sum + m.recebimentosPrevistosMes, 0),
    );
  });

  it("caixaHoje, carteiraHoje e devoCartaoTotal NÃO são somados 12x (saldo pontual, não fluxo)", async () => {
    const yearly = await service.getAccountViewYearly(tenantId, projectId, 2026);
    const anyMonth = await service.getAccountView(tenantId, projectId, "2026-06");

    expect(yearly.caixaHoje).toBe(anyMonth.caixaHoje);
    expect(yearly.carteiraHoje).toBe(anyMonth.carteiraHoje);
    // `devoCartaoTotal` soma TODAS as faturas com saldo pendente do histórico
    // (invoiceRows não é filtrado por mesSelecionado), logo é idêntico nos 12
    // meses — somar inflaria 12x o que se deve de cartão.
    expect(yearly.devoCartaoTotal).toBe(anyMonth.devoCartaoTotal);
    // sanity: a fixture tem fatura pendente de verdade, senão o assert é vazio.
    expect(anyMonth.devoCartaoTotal).toBeGreaterThan(0);
  });

  it("ticketMedio.serie12m[i] é exatamente o ticket que a tela mensal mostra para o mês i", async () => {
    const yearly = await service.getAccountViewYearly(tenantId, projectId, 2026);

    const months = Array.from(
      { length: 12 },
      (_, i) => `2026-${String(i + 1).padStart(2, "0")}`,
    );
    const monthly = await Promise.all(
      months.map((m) => service.getAccountView(tenantId, projectId, m)),
    );

    expect(yearly.ticketMedio.serie12m).toHaveLength(12);
    months.forEach((mes, i) => {
      expect(yearly.ticketMedio.serie12m[i]!.mes).toBe(mes);
      expect(yearly.ticketMedio.serie12m[i]!.valor).toBe(
        monthly[i]!.ticketMedio.valor,
      );
    });

    expect(yearly.ticketMedio.nCompras).toBe(
      monthly.reduce((sum, m) => sum + m.ticketMedio.nCompras, 0),
    );
    expect(yearly.ticketMedio.totalCompras).toBe(
      monthly.reduce((sum, m) => sum + m.ticketMedio.totalCompras, 0),
    );
    // sanity: a fixture tem compras (inclusive de cartão), senão o assert é vazio.
    expect(yearly.ticketMedio.nCompras).toBeGreaterThan(0);
  });

  it("sobraPrevista anual segue a matriz conta/carteira sem dupla contagem", async () => {
    const scenarios = [
      {
        id: "paga-com-conta",
        expense: {
          id: "exp-paga-com-conta",
          tenantId,
          projectId,
          tipoDespesa: "ALIMENTACAO",
          titulo: "Despesa paga com conta",
          fornecedor: "Fornecedor",
          valorTotal: 5_500,
          valor: 5_500,
          formaPagamento: "A_VISTA",
          dataPagamento: new Date("2026-08-15T00:00:00.000Z"),
          dataInicioParcela: null,
          createdAt: new Date("2026-08-15T00:00:00.000Z"),
          quantidadeParcela: null,
          status: "PAGO",
          cardLast4: null,
          bankLast4: "4247",
          origin: "account",
          accountId: "acc-1",
          linkedExpenseId: null,
        },
        expected: { caixaHoje: 94_500, carteiraHoje: 0, faltaPagarMes: 0, sobraPrevista: 94_500 },
      },
      {
        id: "paga-sem-conta",
        expense: {
          id: "exp-paga-sem-conta",
          tenantId,
          projectId,
          tipoDespesa: "ALIMENTACAO",
          titulo: "Despesa paga sem conta",
          fornecedor: "Fornecedor",
          valorTotal: 5_500,
          valor: 5_500,
          formaPagamento: "A_VISTA",
          dataPagamento: new Date("2026-08-15T00:00:00.000Z"),
          dataInicioParcela: null,
          createdAt: new Date("2026-08-15T00:00:00.000Z"),
          quantidadeParcela: null,
          status: "PAGO",
          cardLast4: null,
          bankLast4: null,
          origin: "none",
          accountId: null,
          linkedExpenseId: null,
        },
        expected: { caixaHoje: 100_000, carteiraHoje: -5_500, faltaPagarMes: 0, sobraPrevista: 94_500 },
      },
      {
        id: "pendente-com-conta",
        expense: {
          id: "exp-pendente-com-conta",
          tenantId,
          projectId,
          tipoDespesa: "ALIMENTACAO",
          titulo: "Despesa pendente com conta",
          fornecedor: "Fornecedor",
          valorTotal: 5_500,
          valor: 5_500,
          formaPagamento: "A_VISTA",
          dataPagamento: new Date("2026-08-20T00:00:00.000Z"),
          dataInicioParcela: null,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          quantidadeParcela: null,
          status: "PLANEJADO",
          cardLast4: null,
          bankLast4: "4247",
          origin: "account",
          accountId: "acc-1",
          linkedExpenseId: null,
        },
        expected: { caixaHoje: 100_000, carteiraHoje: 0, faltaPagarMes: 5_500, sobraPrevista: 94_500 },
      },
      {
        id: "pendente-sem-conta",
        expense: {
          id: "exp-pendente-sem-conta",
          tenantId,
          projectId,
          tipoDespesa: "ALIMENTACAO",
          titulo: "Despesa pendente sem conta",
          fornecedor: "Fornecedor",
          valorTotal: 5_500,
          valor: 5_500,
          formaPagamento: "A_VISTA",
          dataPagamento: new Date("2026-08-20T00:00:00.000Z"),
          dataInicioParcela: null,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
          quantidadeParcela: null,
          status: "PLANEJADO",
          cardLast4: null,
          bankLast4: null,
          origin: "none",
          accountId: null,
          linkedExpenseId: null,
        },
        expected: { caixaHoje: 100_000, carteiraHoje: 0, faltaPagarMes: 5_500, sobraPrevista: 94_500 },
      },
    ] as const;

    prisma.receipt.findMany.mockResolvedValue([]);
    prisma.cashFlowEntry.findMany.mockResolvedValue([]);
    prisma.creditCard.findMany.mockResolvedValue([]);

    for (const scenario of scenarios) {
      prisma.expense.findMany.mockResolvedValue([scenario.expense]);
      const yearly = await service.getAccountViewYearly(tenantId, projectId, 2026);

      expect(yearly.caixaHoje).toBe(scenario.expected.caixaHoje);
      expect(yearly.carteiraHoje).toBe(scenario.expected.carteiraHoje);
      expect(yearly.faltaPagarMes).toBe(scenario.expected.faltaPagarMes);
      expect(yearly.sobraPrevista).toBe(scenario.expected.sobraPrevista);
    }
  });
});
