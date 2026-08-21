import { Test, TestingModule } from "@nestjs/testing";
import { MonthlyOverviewService } from "./monthly-overview.service";
import { PrismaService } from "../prisma/prisma.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";

/**
 * #519 — "sobra prevista mostra mais dinheiro do que existe".
 *
 * Uma despesa paga em CARTEIRA (sem conta bancária) sai do bolso do usuário e
 * DEVE reduzir a sobra prevista. `carteiraHoje` é computado e devolvido no
 * payload, mas ficava de fora da fórmula de `sobraPrevista` — a tela mostrava
 * um saldo maior do que a realidade (o pior sentido de errar num número
 * financeiro).
 *
 * Matriz de regressão: paga/pendente × com conta/sem conta, mais o caso já
 * corrigido em #379 (pendente sem conta) como trava. Provamos o SINAL da
 * carteira nos dois extremos: negativo (despesa domina) e positivo (dinheiro em
 * caixa domina).
 *
 * Todos os valores em centavos (Int). Banco: saldo inicial 100.000 (R$ 1.000,00),
 * ancorado antes do mês. Mês observado: 2026-06. Relógio: 2026-06-15.
 */
describe("MonthlyOverviewService.getAccountView — #519 carteira na sobra prevista", () => {
  let service: MonthlyOverviewService;
  let prisma: any;
  let settlement: any;

  const tenantId = "tenant-1";
  const projectId = "pessoal-1";

  const SALDO_INICIAL = 100_000; // R$ 1.000,00 no banco, ancorado em 2025-12-31
  const VALOR = 5_500; // R$ 55,00 — a mesma ordem de grandeza medida no PR #390

  const baseExpense = (over: Record<string, unknown>) => ({
    tenantId,
    projectId,
    tipoDespesa: "MAO_DE_OBRA", // não-neutro: entra no fluxo de caixa
    titulo: "Diarista",
    fornecedor: "Diarista",
    valor: 0,
    valorTotal: 0,
    formaPagamento: "A_VISTA", // pagamento único
    dataPagamento: null,
    dataInicioParcela: null,
    quantidadeParcela: null,
    status: "PLANEJADO",
    cardLast4: null,
    bankLast4: null,
    importId: null,
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    linkedExpenseId: null,
    settledByExpenseId: null,
    settlesInvoiceKey: null,
    paidParcelas: null,
    installmentDateOverrides: null,
    project: { id: projectId, name: "Pessoal", type: "PESSOAL" },
    ...over,
  });

  const baseReceipt = (over: Record<string, unknown>) => ({
    tenantId,
    projectId,
    tipo: "PAGAMENTO",
    descricao: "Entrada",
    valor: 0,
    data: new Date("2026-06-05T00:00:00.000Z"),
    status: "EM_CAIXA",
    bankLast4: null,
    importId: null,
    ...over,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({
          id: projectId,
          tenantId,
          type: "PESSOAL",
          deletedAt: null,
        }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: projectId, name: "Pessoal", type: "PESSOAL" }]),
      },
      bankAccount: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "acc-1",
            openingBalanceCents: SALDO_INICIAL,
            openingBalanceDate: new Date("2025-12-31T00:00:00.000Z"),
            last4: "4247",
            nickname: "Conta principal",
            institution: "NUBANK",
          },
        ]),
        findFirst: jest.fn(),
      },
      expense: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), create: jest.fn() },
      receipt: { findMany: jest.fn().mockResolvedValue([]) },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
      creditCard: { findMany: jest.fn().mockResolvedValue([]) },
      crossProjectSettlement: { findMany: jest.fn().mockResolvedValue([]) },
      rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      invoiceAdjustment: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
      },
      bankStatementImport: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
    };

    settlement = {
      prepareSettleInvoice: jest.fn().mockResolvedValue({ purchases: [] }),
      applyPreparedSettlement: jest
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

  // ── Caso A: paga COM conta ────────────────────────────────────────────────
  // Reduz o saldo do banco (caixaHoje). carteiraHoje = 0. Já correto hoje —
  // serve de controle para provar que o caminho "com conta" não regride.
  it("paga com conta: reduz caixaHoje e a sobra prevista (controle)", async () => {
    prisma.expense.findMany.mockResolvedValue([
      baseExpense({
        id: "exp-conta-paga",
        status: "PAGO",
        bankLast4: "4247",
        valor: VALOR,
        valorTotal: VALOR,
        dataPagamento: new Date("2026-06-10T00:00:00.000Z"),
      }),
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, "2026-06");

    expect(res.caixaHoje).toBe(SALDO_INICIAL - VALOR); // 94.500
    expect(res.carteiraHoje).toBe(0);
    expect(res.faltaPagarMes).toBe(0);
    expect(res.saiuMes).toBe(VALOR);
    expect(res.sobraPrevista).toBe(SALDO_INICIAL - VALOR); // 94.500
  });

  // ── Caso B: pendente COM conta ────────────────────────────────────────────
  // Não saiu do banco ainda (caixaHoje intacto), mas entra em faltaPagarMes.
  // Já correto hoje — controle.
  it("pendente com conta: não mexe no caixa, entra em faltaPagar e reduz a sobra (controle)", async () => {
    prisma.expense.findMany.mockResolvedValue([
      baseExpense({
        id: "exp-conta-pendente",
        status: "PLANEJADO",
        bankLast4: "4247",
        valor: VALOR,
        valorTotal: VALOR,
        dataPagamento: new Date("2026-06-20T00:00:00.000Z"),
      }),
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, "2026-06");

    expect(res.caixaHoje).toBe(SALDO_INICIAL); // 100.000
    expect(res.carteiraHoje).toBe(0);
    expect(res.faltaPagarMes).toBe(VALOR);
    expect(res.saiuMes).toBe(0);
    expect(res.sobraPrevista).toBe(SALDO_INICIAL - VALOR); // 94.500
  });

  // ── Caso C: paga SEM conta (CARTEIRA) — O DEFEITO #519 ─────────────────────
  // Saiu do bolso (carteiraHoje = -VALOR), mas NÃO reduz caixaHoje nem
  // faltaPagar. Hoje a sobra ignora a carteira → mostra R$ 1.000 onde só há
  // R$ 945 (medição do PR #390). Prova o SINAL NEGATIVO da carteira.
  it("paga sem conta (carteira negativa): a saída de carteira reduz a sobra prevista", async () => {
    prisma.expense.findMany.mockResolvedValue([
      baseExpense({
        id: "exp-carteira-paga",
        status: "PAGO",
        // sem cardLast4 e sem bankLast4 → Carteira
        valor: VALOR,
        valorTotal: VALOR,
        dataPagamento: new Date("2026-06-10T00:00:00.000Z"),
      }),
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, "2026-06");

    expect(res.caixaHoje).toBe(SALDO_INICIAL); // banco intacto: 100.000
    expect(res.carteiraHoje).toBe(-VALOR); // -5.500
    expect(res.faltaPagarMes).toBe(0); // realizado, não é "falta pagar"
    expect(res.saiuMes).toBe(VALOR); // sem dupla contagem: só a saída de carteira
    // A sobra prevista TEM de descontar a carteira: 100.000 + (-5.500) = 94.500.
    expect(res.sobraPrevista).toBe(SALDO_INICIAL - VALOR); // 94.500
  });

  // ── Caso D: pendente SEM conta (CARTEIRA) — trava do #379 ──────────────────
  // Não realizada → NÃO entra em carteiraHoje; entra em faltaPagarMes. Já
  // correto desde #379; trava para a correção do #519 não reintroduzir o
  // desconto por dois caminhos.
  it("pendente sem conta (#379): entra em faltaPagar, fora da carteira, reduz a sobra uma única vez", async () => {
    prisma.expense.findMany.mockResolvedValue([
      baseExpense({
        id: "exp-carteira-pendente",
        status: "PLANEJADO",
        valor: VALOR,
        valorTotal: VALOR,
        dataPagamento: new Date("2026-06-20T00:00:00.000Z"),
      }),
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, "2026-06");

    expect(res.caixaHoje).toBe(SALDO_INICIAL); // 100.000
    expect(res.carteiraHoje).toBe(0); // pendente não realiza carteira
    expect(res.faltaPagarMes).toBe(VALOR);
    expect(res.saiuMes).toBe(0);
    expect(res.sobraPrevista).toBe(SALDO_INICIAL - VALOR); // 94.500 (uma vez só)
  });

  // ── Sinal POSITIVO da carteira: dinheiro em caixa domina ──────────────────
  // Recebimento EM_CAIXA sem conta (dinheiro na mão) MAIOR que a despesa de
  // carteira → carteiraHoje > 0. A sobra prevista tem de SOMAR esse dinheiro
  // disponível. Prova que a correção não inverte o sinal quando a carteira é
  // positiva.
  it("carteira positiva (dinheiro em caixa > despesa): a sobra prevista soma a carteira", async () => {
    prisma.expense.findMany.mockResolvedValue([
      baseExpense({
        id: "exp-carteira-paga",
        status: "PAGO",
        valor: VALOR,
        valorTotal: VALOR,
        dataPagamento: new Date("2026-06-10T00:00:00.000Z"),
      }),
    ]);
    prisma.receipt.findMany.mockResolvedValue([
      baseReceipt({
        id: "rec-dinheiro-em-caixa",
        valor: 20_000, // R$ 200,00 recebidos em dinheiro (sem conta), EM_CAIXA
        status: "EM_CAIXA",
        bankLast4: null,
        data: new Date("2026-06-05T00:00:00.000Z"),
      }),
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, "2026-06");

    expect(res.caixaHoje).toBe(SALDO_INICIAL); // banco intacto: recebimento sem conta não entra no §10
    expect(res.carteiraHoje).toBe(20_000 - VALOR); // +14.500
    expect(res.faltaPagarMes).toBe(0);
    expect(res.saiuMes).toBe(VALOR);
    // 100.000 + 14.500 = 114.500
    expect(res.sobraPrevista).toBe(SALDO_INICIAL + (20_000 - VALOR)); // 114.500
  });
});
