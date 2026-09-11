// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "../bank-account/bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { MonthlyOverviewService } from "./monthly-overview.service";
import type { RateioRequester } from "../expense/rateio.types";

/**
 * Achado #1 (journey-qa) — cartão SEM closingDay/dueDay (estado normal, usuário
 * ainda não preencheu) + compra planejada MANUAL (nunca veio de um
 * `CreditCardStatementImport`) + pagamento de fatura importado do extrato
 * bancário cujo valor casa por coincidência o total da fatura.
 *
 * Nenhuma estratégia de liquidação real (`CardInvoiceSettlementService.
 * prepareSettleInvoice`) consegue liquidar: a estratégia 1 (`hasDays`) é pulada
 * por falta de `closingDay`/`dueDay`; a estratégia 2 (fallback por fatura
 * IMPORTADA) exige que a compra tenha vindo de um `CreditCardStatementImport`,
 * o que uma despesa planejada manualmente nunca tem. `Expense.invoiceUndoState`
 * fica `PROCESSED_NONE` e a compra continua `PLANEJADO` no banco.
 *
 * Antes da correção, `MonthlyOverviewService.getAccountView` (via
 * `matchPaidInvoices`/`assignImplicitPayments`) casava o pagamento por VALOR
 * contra o total da fatura (soma de TODOS os lançamentos, qualquer status) e
 * marcava a fatura como "paga" mesmo sem nenhuma liquidação real — a UI (card
 * widget "✓ Paga" e "Ainda falta pagar R$ 0,00") mentia sobre o estado real.
 */
describe("MonthlyOverviewService.getAccountView — não mente 'paga' quando nenhuma liquidação real ocorreu (#1)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let bankSvc: BankAccountService;
  let overviewSvc: MonthlyOverviewService;

  const TENANT = "mo-bug1-tenant";
  const PESSOAL = "mo-bug1-pessoal";
  const CARD_LAST4 = "4321";
  const BANK_LAST4 = "8765";
  const REQUESTER: RateioRequester = {
    role: "USER",
    allowedProjects: [PESSOAL],
    allowedProjectTypes: ["PESSOAL"],
    allowedModules: ["expenses", "creditCards"],
  };

  let accountId: string;
  let cardId: string;
  const PURCHASE_ID = "bug1-purchase";
  const PURCHASE_VALOR = 300_000; // R$ 3.000,00

  function ofxDebit(date: string, amountCents: number, memo: string, fitId: string): string {
    const amount = (amountCents / 100).toFixed(2);
    return [
      "<STMTTRN>",
      "<TRNTYPE>DEBIT</TRNTYPE>",
      `<DTPOSTED>${date}</DTPOSTED>`,
      `<TRNAMT>-${amount}</TRNAMT>`,
      `<FITID>${fitId}</FITID>`,
      `<MEMO>${memo}</MEMO>`,
      "</STMTTRN>",
    ].join("");
  }

  function bankOfx(...transactions: string[]): Buffer {
    return Buffer.from(
      [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
        `<BANKACCTFROM><ACCTID>${BANK_LAST4}</ACCTID></BANKACCTFROM>`,
        "<BANKTRANLIST>",
        ...transactions,
        "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
      ].join("\n"),
    );
  }

  async function cleanup(): Promise<void> {
    await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  }

  async function cleanupAll(): Promise<void> {
    await cleanup();
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  }

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await setupPrisma.tenant.create({ data: { id: TENANT, name: "Bug1 Monthly Overview" } });
    await setupPrisma.project.create({
      data: { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
    });
    const account = await setupPrisma.bankAccount.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: "ITAU", nickname: "Conta Bug1", last4: BANK_LAST4 },
    });
    accountId = account.id;
    // Cartão SEM closingDay/dueDay — estado normal de quem ainda não preencheu.
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "NUBANK",
        brand: "Mastercard",
        nickname: "Cartão Bug1",
        last4: CARD_LAST4,
        closingDay: null,
        dueDay: null,
      },
    });
    cardId = card.id;
    bankSvc = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
    overviewSvc = new MonthlyOverviewService(prisma, new CardInvoiceSettlementService(prisma));
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanupAll();
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it("compra planejada manual + pagamento importado de valor coincidente NÃO marca a fatura como paga", async () => {
    // Compra planejada MANUAL (nunca importada de fatura de cartão).
    await setupPrisma.expense.create({
      data: {
        id: PURCHASE_ID,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: "Compra planejada manual",
        valor: PURCHASE_VALOR,
        quantidade: 1,
        valorTotal: PURCHASE_VALOR,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-10T12:00:00.000Z"),
        status: "PLANEJADO",
        cardLast4: CARD_LAST4,
        paidParcelas: null,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${PURCHASE_ID}-entry`,
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: PURCHASE_ID,
        valor: PURCHASE_VALOR,
        tipo: "DESPESA",
        data: new Date("2026-06-10T12:00:00.000Z"),
        categoria: "OUTROS",
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
      },
    });

    const result = await bankSvc.commitImport(
      TENANT,
      PESSOAL,
      accountId,
      bankOfx(ofxDebit("20260628", PURCHASE_VALOR, `PAGTO CART CRED ${CARD_LAST4}`, "BUG1-PAY")),
      "extrato-bug1.ofx",
      "OFX",
      "2026-06",
      undefined,
      undefined,
      null,
      REQUESTER,
    );
    expect(result.cardPayments).toBe(1);

    // Fonte da verdade: nenhuma liquidação real ocorreu.
    const purchase = await setupPrisma.expense.findUnique({ where: { id: PURCHASE_ID } });
    expect(purchase?.status).toBe("PLANEJADO");
    const entry = await setupPrisma.cashFlowEntry.findUnique({ where: { id: `${PURCHASE_ID}-entry` } });
    expect(entry?.status).toBe("PLANEJADO");

    const payment = await setupPrisma.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" },
    });
    expect(payment?.invoiceUndoState).toBe("PROCESSED_NONE");
    expect(payment?.invoiceUndoParcelaCount).toBe(0);

    // A UI (card widget + "Ainda falta pagar") NUNCA pode dizer "paga".
    const view: any = await overviewSvc.getAccountView(TENANT, PESSOAL, "2026-06", REQUESTER);
    const cardRow = view.cartoes.find((c: any) => c.last4 === CARD_LAST4);
    expect(cardRow).toBeDefined();
    expect(cardRow.status).not.toBe("paga");
    expect(cardRow.faturaPendente).toBe(PURCHASE_VALOR);

    const purchaseRow = view.comprasCartao.find((c: any) => c.id === PURCHASE_ID);
    expect(purchaseRow).toBeDefined();
    expect(purchaseRow.status).toBe("PLANEJADO");
    expect(purchaseRow.realizado).toBe(false);

    // "Ainda falta pagar" (faltaPagarMes) precisa refletir a compra ainda não paga.
    expect(view.faltaPagarMes).toBeGreaterThanOrEqual(PURCHASE_VALOR);
  });
});
