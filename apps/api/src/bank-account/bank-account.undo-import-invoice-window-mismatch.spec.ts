// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "./bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "../expense/rateio.types";

/**
 * RED spec — issue #569.
 *
 * M1: `undoImport` deriva o mês da fatura a partir do mês do PAGAMENTO
 * (`bank-account.service.ts` linha ~1216), mas `settleInvoice` (via
 * `resolveTargetDueMonth` em `card-invoice-settlement.service.ts`, janela
 * `{payMonth, payMonth+1}`) pode ter liquidado uma fatura de mês DIFERENTE do
 * pagamento. `undoImport` então despaga a fatura errada — inclusive uma
 * fatura já quitada por OUTRO pagamento, sem que nenhum registro amarre
 * "este pagamento liquidou esta fatura X".
 *
 * M2: a prévia (`card-invoice-match.ts`, janela {-1,0,+1} = 3 meses) promete
 * vínculo que a liquidação real (`card-invoice-settlement.service.ts`, janela
 * {0,+1} = 2 meses) não confirma. `getImportDetail` conta
 * `invoiceLiquidations` só por a despesa ter `tipoDespesa` +
 * `cardLast4` e o cartão ter `closingDay`/`dueDay` — não por ter checado que
 * `prepareSettleInvoice` de fato encontrou e pagou alguma compra.
 */
describe("BankAccountService — janela de liquidação de fatura (issue #569)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;
  let cardSettlement: CardInvoiceSettlementService;

  const TENANT = "bank-569-tenant";
  const PESSOAL = "bank-569-pessoal";
  const LAST4 = "5691";
  const REQUESTER: RateioRequester = {
    role: "USER",
    allowedProjects: [PESSOAL],
    allowedProjectTypes: ["PESSOAL"],
    allowedModules: ["expenses", "creditCards"],
  };

  /** Limpa dados TRANSIENTES de um cenário (mantém conta/cartão do beforeAll). */
  async function cleanup(): Promise<void> {
    await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  }

  /** Limpeza completa — só em beforeAll/afterAll. */
  async function cleanupAll(): Promise<void> {
    await cleanup();
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  }

  let accountId: string;
  let cardId: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await setupPrisma.tenant.create({ data: { id: TENANT, name: "Bank 569" } });
    await setupPrisma.project.create({
      data: { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
    });
    const account = await setupPrisma.bankAccount.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: "ITAU", nickname: "Conta 569", last4: "9012" },
    });
    accountId = account.id;
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão 569",
        last4: LAST4,
        closingDay: 25,
        dueDay: 5,
      },
    });
    cardId = card.id;
    cardSettlement = new CardInvoiceSettlementService(prisma);
    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      cardSettlement,
    );
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanupAll();
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  /** Cria uma compra de cartão (Expense OUTROS à vista) com CashFlowEntry PLANEJADO ou PAGO. */
  async function createPurchase(params: {
    id: string;
    purchaseDate: Date;
    valor: number;
    status: "PLANEJADO" | "PAGO";
  }): Promise<void> {
    await setupPrisma.expense.create({
      data: {
        id: params.id,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: `Compra ${params.id}`,
        valor: params.valor,
        quantidade: 1,
        valorTotal: params.valor,
        formaPagamento: "A_VISTA",
        dataPagamento: params.purchaseDate,
        status: params.status,
        cardLast4: LAST4,
        paidParcelas: params.status === "PAGO" ? "[0]" : null,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${params.id}-entry`,
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: params.id,
        valor: params.valor,
        tipo: "DESPESA",
        data: params.purchaseDate,
        categoria: "OUTROS",
        formaPagamento: "A_VISTA",
        status: params.status,
      },
    });
  }

  async function createInvoicePaymentExpense(params: {
    id: string;
    importId: string;
    paymentDate: Date;
    valor: number;
  }): Promise<void> {
    await setupPrisma.expense.create({
      data: {
        id: params.id,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "Pagamento fatura",
        valor: params.valor,
        quantidade: 1,
        valorTotal: params.valor,
        formaPagamento: "A_VISTA",
        dataPagamento: params.paymentDate,
        status: "PAGO",
        cardLast4: LAST4,
        bankLast4: "9012",
        accountId,
        importId: params.importId,
        origin: "import",
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${params.id}-entry`,
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: params.id,
        valor: params.valor,
        tipo: "DESPESA",
        data: params.paymentDate,
        categoria: "Pagamento de fatura",
        formaPagamento: "A_VISTA",
        status: "PAGO",
      },
    });
  }

  it("M1 — undoImport despaga a fatura de JUNHO (já paga por outro pagamento) em vez da de JULHO (efetivamente quitada por este pagamento)", async () => {
    // Cartão fecha dia 25, vence dia 5.
    // Compra de maio (dia 10) -> fatura de junho (JÁ paga por "outro pagamento").
    await createPurchase({
      id: "purchase-may",
      purchaseDate: new Date("2026-05-10T12:00:00.000Z"),
      valor: 500_000, // R$ 5.000,00 — fatura de junho já fechada por outro pagamento
      status: "PAGO",
    });
    // Compra de junho (dia 10) -> fatura de julho (aberta).
    await createPurchase({
      id: "purchase-june",
      purchaseDate: new Date("2026-06-10T12:00:00.000Z"),
      valor: 700_000, // R$ 7.000,00 — fatura de julho, a ser quitada pelo pagamento sob teste
      status: "PLANEJADO",
    });

    const importId = "import-569-m1";
    await setupPrisma.bankStatementImport.create({
      data: {
        id: importId,
        tenantId: TENANT,
        accountId,
        periodLabel: "2026-06",
        source: "OFX",
        inserted: 1,
        totalAmountCents: 700_000,
      },
    });

    // Pagamento em 28/06, valor bate com a fatura de julho (700.000) — a
    // liquidação real (mesma lógica usada na importação) deve escolher julho.
    const paymentDate = new Date("2026-06-28T12:00:00.000Z");
    await createInvoicePaymentExpense({
      id: "payment-m1",
      importId,
      paymentDate,
      valor: 700_000,
    });

    const card = { id: cardId, last4: LAST4, closingDay: 25, dueDay: 5 };
    const settleResult = await cardSettlement.settleInvoice({
      tenantId: TENANT,
      card,
      amountCents: 700_000,
      paymentDate,
      requester: REQUESTER,
    });
    // Mesma persistência que o fluxo real de import faz (bank-account.service
    // .createInvoicePaymentExpense grava `currentSettlement.settledInvoiceKey`
    // no pagamento no momento em que a liquidação é aplicada) — aqui feita
    // explicitamente porque o teste chama `settleInvoice` fora do fluxo de
    // commit completo.
    await setupPrisma.expense.update({
      where: { id: "payment-m1" },
      data: { settledInvoiceKey: settleResult.settledInvoiceKey },
    });

    const beforeUndo = await setupPrisma.cashFlowEntry.findMany({
      where: { tenantId: TENANT, expenseId: { in: ["purchase-may-entry".replace("-entry", ""), "purchase-june"] } },
    });
    // Sanity: a liquidação real de fato marcou a compra de JUNHO (fatura de
    // julho) como PAGA, e não tocou a de MAIO (já paga antes).
    const juneEntryBefore = await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-june-entry" } });
    const mayEntryBefore = await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-may-entry" } });
    expect(juneEntryBefore?.status).toBe("PAGO");
    expect(mayEntryBefore?.status).toBe("PAGO");

    await service.undoImport(TENANT, PESSOAL, accountId, importId, REQUESTER);

    const juneEntryAfter = await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-june-entry" } });
    const mayEntryAfter = await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-may-entry" } });

    // Comportamento CORRETO esperado (hoje falha):
    //  - a compra de junho (fatura de julho, efetivamente quitada por este
    //    pagamento) deveria voltar a PLANEJADO;
    //  - a compra de maio (fatura de junho, quitada por OUTRO pagamento) NÃO
    //    deveria ser tocada.
    expect({ june: juneEntryAfter?.status, may: mayEntryAfter?.status }).toEqual({
      june: "PLANEJADO",
      may: "PAGO",
    });
  });

  it("M2 — getImportDetail conta invoiceLiquidations mesmo quando a liquidação real (janela de 2 meses) não achou nada para pagar", async () => {
    // Compra de abril (dia 10) -> fatura de maio: fica FORA da janela de
    // liquidação real (payMonth=julho => {julho, agosto}) mas DENTRO da
    // janela de 3 meses da prévia ({junho, julho, agosto}).
    await createPurchase({
      id: "purchase-april",
      purchaseDate: new Date("2026-04-10T12:00:00.000Z"),
      valor: 300_000,
      status: "PLANEJADO",
    });

    const importId = "import-569-m2";
    await setupPrisma.bankStatementImport.create({
      data: {
        id: importId,
        tenantId: TENANT,
        accountId,
        periodLabel: "2026-07",
        source: "OFX",
        inserted: 1,
        totalAmountCents: 300_000,
      },
    });

    const paymentDate = new Date("2026-07-28T12:00:00.000Z");
    await createInvoicePaymentExpense({
      id: "payment-m2",
      importId,
      paymentDate,
      valor: 300_000,
    });

    const card = { id: cardId, last4: LAST4, closingDay: 25, dueDay: 5 };
    // Mesma lógica que a importação usaria — a janela real de liquidação NÃO
    // enxerga a fatura de maio (mês -1 em relação ao pagamento de julho).
    const settleResult = await cardSettlement.settleInvoice({
      tenantId: TENANT,
      card,
      amountCents: 300_000,
      paymentDate,
      requester: REQUESTER,
    });
    // Sanity: nada foi de fato liquidado.
    expect(settleResult.settledExpenses).toBe(0);
    const aprilEntry = await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-april-entry" } });
    expect(aprilEntry?.status).toBe("PLANEJADO");

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, importId);

    // Comportamento CORRETO esperado (hoje falha): se nada foi liquidado,
    // invoiceLiquidations deveria ser 0 — não 1 (a prévia promete um vínculo
    // que o commit não fez).
    expect(detail.impact.invoiceLiquidations).toBe(0);
  });
});
