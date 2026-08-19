// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "../bank-account/bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  MonthlyOverviewMutationRequester,
  MonthlyOverviewService,
} from "./monthly-overview.service";

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "sec1-invoice-gate-tenant";
const PESSOAL = "sec1-invoice-gate-pessoal";
const CARD_ID = "sec1-invoice-gate-card";
const ACCOUNT_ID = "sec1-invoice-gate-account";
const PURCHASE_ID = "sec1-invoice-gate-purchase";
const CARD_LAST4 = "4488";
const BANK_LAST4 = "1881";

const FIXED_CLOCK = new Date("2026-08-19T15:00:00.000Z");
const PURCHASE_DATE = new Date("2026-06-15T12:00:00.000Z");
const PAYMENT_DATE = new Date("2026-07-10T12:00:00.000Z");
const DUE_MONTH = "2026-07";
const INVOICE_TOTAL_CENTS = 10_000;

/**
 * A população que o gate por recurso NÃO pode atingir (#480 SEC-1 vs. regressão):
 * `allowedProjectTypes` vazio é o legado "sem restrição" — `reconcileUserModules`
 * devolve os módulos INTOCADOS nesse caso (nunca faz back-fill de `creditCards`)
 * e `accessibleProjectTypes` deriva o tipo A PARTIR dos módulos. Logo este
 * requester alcança PESSOAL por `monthlyOverview`, que é exatamente o módulo
 * declarado no `@RequireModule` das rotas pay-invoice / undo-invoice-payment.
 */
const MONTHLY_OVERVIEW_REQUESTER: MonthlyOverviewMutationRequester = {
  id: "sec1-invoice-gate-user",
  role: "USER",
  allowedProjects: [PESSOAL],
  allowedProjectTypes: [],
  allowedModules: ["monthlyOverview", "expenses"],
};

function bankOfx(): Buffer {
  return Buffer.from(
    [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
      `<BANKACCTFROM><ACCTID>${BANK_LAST4}</ACCTID></BANKACCTFROM>`,
      "<BANKTRANLIST>",
      "<STMTTRN>",
      "<TRNTYPE>DEBIT</TRNTYPE>",
      "<DTPOSTED>20260710</DTPOSTED>",
      "<TRNAMT>-100.00</TRNAMT>",
      "<FITID>SEC1-GATE-INVOICE</FITID>",
      "<MEMO>PAGTO CART CRED</MEMO>",
      "</STMTTRN>",
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
    ].join("\n"),
  );
}

async function cleanupTransient(): Promise<void> {
  await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setup.expense.deleteMany({ where: { tenantId: TENANT } });
}

async function cleanupAll(): Promise<void> {
  await cleanupTransient();
  await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setup.creditCard.deleteMany({ where: { tenantId: TENANT } });
  await setup.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  await setup.project.deleteMany({ where: { tenantId: TENANT } });
  await setup.tenant.deleteMany({ where: { id: TENANT } });
}

async function createPurchase(): Promise<void> {
  await setup.expense.create({
    data: {
      id: PURCHASE_ID,
      tenantId: TENANT,
      projectId: PESSOAL,
      tipoDespesa: "MATERIAL_CONSTRUCAO",
      titulo: PURCHASE_ID,
      valor: INVOICE_TOTAL_CENTS,
      quantidade: 1,
      valorTotal: INVOICE_TOTAL_CENTS,
      formaPagamento: "A_VISTA",
      dataPagamento: PURCHASE_DATE,
      status: "PLANEJADO",
      cardLast4: CARD_LAST4,
      createdAt: PURCHASE_DATE,
      updatedAt: PURCHASE_DATE,
    },
  });
  await setup.cashFlowEntry.create({
    data: {
      id: `${PURCHASE_ID}-entry`,
      tenantId: TENANT,
      projectId: PESSOAL,
      expenseId: PURCHASE_ID,
      valor: INVOICE_TOTAL_CENTS,
      tipo: "DESPESA",
      data: PURCHASE_DATE,
      categoria: "MATERIAL_CONSTRUCAO",
      formaPagamento: "CARTAO_CREDITO",
      status: "PLANEJADO",
      createdAt: PURCHASE_DATE,
      updatedAt: PURCHASE_DATE,
    },
  });
}

async function purchaseState() {
  const [expense, entry] = await Promise.all([
    setup.expense.findUnique({
      where: { id: PURCHASE_ID },
      select: { status: true, paidParcelas: true, valorTotal: true },
    }),
    setup.cashFlowEntry.findUnique({
      where: { id: `${PURCHASE_ID}-entry` },
      select: { status: true, valor: true },
    }),
  ]);
  return { expense, entry };
}

describe("Fatura de cartão pelo cockpit — gate por módulo do caller (#480 SEC-1)", () => {
  let monthly: MonthlyOverviewService;
  let bank: BankAccountService;

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "setInterval",
        "setTimeout",
      ],
    });
    jest.setSystemTime(FIXED_CLOCK);

    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.create({
      data: { id: TENANT, name: "SEC-1 invoice module gate" },
    });
    await setup.project.create({
      data: { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
    });
    await setup.creditCard.create({
      data: {
        id: CARD_ID,
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão cockpit",
        last4: CARD_LAST4,
        closingDay: 3,
        dueDay: 10,
      },
    });
    await setup.bankAccount.create({
      data: {
        id: ACCOUNT_ID,
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        nickname: "Conta cockpit",
        last4: BANK_LAST4,
      },
    });

    const settlement = new CardInvoiceSettlementService(prisma);
    monthly = new MonthlyOverviewService(prisma, settlement);
    bank = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      settlement,
    );
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  it("mantém pagar/desfazer fatura para quem tem monthlyOverview sem creditCards, sem abrir o candidato de cartão na importação", async () => {
    await createPurchase();

    // 1) Rota @RequireModule('monthlyOverview'): segue funcionando.
    const paid = await monthly.payInvoice(
      TENANT,
      PESSOAL,
      {
        cardId: CARD_ID,
        cardLast4: CARD_LAST4,
        month: DUE_MONTH,
        amountCents: INVOICE_TOTAL_CENTS,
        accountId: ACCOUNT_ID,
        bankLast4: BANK_LAST4,
        paymentDate: PAYMENT_DATE.toISOString(),
      },
      MONTHLY_OVERVIEW_REQUESTER,
    );
    const afterPayment = await purchaseState();

    expect(paid).toEqual({
      ok: true,
      paymentExpenseId: expect.any(String),
      cardId: CARD_ID,
      cardLast4: CARD_LAST4,
      accountId: ACCOUNT_ID,
      month: DUE_MONTH,
      amountCents: INVOICE_TOTAL_CENTS,
      settledExpenses: 1,
      settledParcelas: 1,
    });
    expect(afterPayment).toEqual({
      // À vista: `applyPaid` quita a despesa inteira e zera `paidParcelas`.
      expense: {
        status: "PAGO",
        paidParcelas: null,
        valorTotal: INVOICE_TOTAL_CENTS,
      },
      entry: { status: "PAGO", valor: INVOICE_TOTAL_CENTS },
    });

    // 2) O inverso (undo-invoice-payment) também.
    const undone = await monthly.undoInvoicePayment(
      TENANT,
      PESSOAL,
      { cardId: CARD_ID, cardLast4: CARD_LAST4, dueMonth: DUE_MONTH },
      MONTHLY_OVERVIEW_REQUESTER,
    );
    const afterUndo = await purchaseState();
    const payment = await setup.expense.findUnique({
      where: { id: paid.paymentExpenseId },
      select: { deletedAt: true },
    });

    expect(undone).toMatchObject({
      ok: true,
      undonePaymentExpenseId: paid.paymentExpenseId,
      revertedExpenses: 1,
      revertedParcelas: 1,
    });
    expect(afterUndo).toEqual({
      expense: {
        status: "PLANEJADO",
        paidParcelas: null,
        valorTotal: INVOICE_TOTAL_CENTS,
      },
      entry: { status: "PLANEJADO", valor: INVOICE_TOTAL_CENTS },
    });
    expect(payment?.deletedAt).not.toBeNull();

    // 3) A superfície de IMPORTAÇÃO continua fechada para o MESMO requester:
    //    o cartão é recurso de `creditCards`, que ele não tem.
    const preview = await bank.previewImport(
      TENANT,
      PESSOAL,
      ACCOUNT_ID,
      [bankOfx()],
      "sec1-gate.ofx",
      "OFX",
      undefined,
      MONTHLY_OVERVIEW_REQUESTER,
    );

    expect(
      preview.preview.map((row: any) => ({
        isCardPayment: row.isCardPayment,
        cardCandidates: row.cardCandidates,
        suggestedCardLast4: row.suggestedCardLast4,
      })),
    ).toEqual([
      { isCardPayment: true, cardCandidates: [], suggestedCardLast4: null },
    ]);
    expect(JSON.stringify(preview)).not.toContain(CARD_LAST4);
    expect(JSON.stringify(preview)).not.toContain(CARD_ID);
  });
});
