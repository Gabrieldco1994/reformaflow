// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import type { RateioRequester } from "../expense/rateio.types";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { BankAccountService } from "./bank-account.service";
import { parseBankStatementBuffers } from "./parsers";

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "sec4-bank-commit-tenant";
const PESSOAL = "sec4-bank-commit-pessoal";
const ALLOWED = "sec4-bank-commit-allowed";
const HIDDEN = "sec4-bank-commit-hidden";
const ACCOUNT_ID = "sec4-bank-commit-account";
const BANK_LAST4 = "1881";
const VISIBLE_CARD_ID = "sec4-bank-visible-card";
const VISIBLE_LAST4 = "4488";
const HIDDEN_CARD_ID = "sec4-bank-hidden-card";
const HIDDEN_LAST4 = "5599";
const CREATED_BY = "sec4-bank-commit-user";

const FIXED_CLOCK = new Date("2026-08-19T15:00:00.000Z");
const PURCHASE_DATE = new Date("2026-06-15T12:00:00.000Z");
const PAYMENT_DATE = new Date("2026-07-10T00:00:00.000Z");

const REQUESTER: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  // Pagamento de fatura toca o recurso CARTÃO: exige `creditCards` além de
  // `expenses` (#480 SEC-1).
  allowedModules: ["expenses", "creditCards"],
};

function rejectionShape(error: unknown) {
  if (!(error instanceof HttpException)) {
    return error
      ? {
          name: (error as Error).constructor.name,
          status: null,
          message: (error as Error).message,
          body: null,
        }
      : null;
  }
  return {
    name: error.constructor.name,
    status: error.getStatus(),
    message: error.message,
    body: error.getResponse(),
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function ofxTransaction(
  date: string,
  amountCents: number,
  memo: string,
  fitId: string,
): string {
  // Same normalized convention used by bank-account.service.spec.ts:
  // positive means an outbound bank debit, while OFX stores it as negative.
  const ofxAmountCents = -amountCents;
  const sign = ofxAmountCents >= 0 ? "" : "-";
  const amount = Math.abs(ofxAmountCents / 100).toFixed(2);
  const type = amountCents >= 0 ? "DEBIT" : "CREDIT";
  return [
    "<STMTTRN>",
    `<TRNTYPE>${type}</TRNTYPE>`,
    `<DTPOSTED>${date}</DTPOSTED>`,
    `<TRNAMT>${sign}${amount}</TRNAMT>`,
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
      "<BANKACCTFROM><ACCTID>1881</ACCTID></BANKACCTFROM>",
      "<BANKTRANLIST>",
      ...transactions,
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
    ].join("\n"),
  );
}

async function cleanupTransient(): Promise<void> {
  await setup.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
  await setup.crossProjectSettlement.deleteMany({
    where: { tenantId: TENANT },
  });
  await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setup.expense.deleteMany({ where: { tenantId: TENANT } });
  await setup.receipt.deleteMany({ where: { tenantId: TENANT } });
  await setup.recurringBill.deleteMany({ where: { tenantId: TENANT } });
  await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setup.creditCardStatementImport.deleteMany({
    where: { tenantId: TENANT },
  });
  await setup.creditCard.deleteMany({ where: { tenantId: TENANT } });
}

async function cleanupAll(): Promise<void> {
  await cleanupTransient();
  await setup.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  await setup.project.deleteMany({ where: { tenantId: TENANT } });
  await setup.tenant.deleteMany({ where: { id: TENANT } });
}

async function createCard(params: {
  id: string;
  projectId: string;
  last4: string;
  nickname: string;
}) {
  return setup.creditCard.create({
    data: {
      ...params,
      tenantId: TENANT,
      institution: "ITAU",
      brand: "Visa",
      closingDay: 3,
      dueDay: 10,
    },
  });
}

async function createPurchase(params: {
  id: string;
  projectId: string;
  cardLast4?: string;
  amountCents?: number;
}): Promise<void> {
  const amountCents = params.amountCents ?? 10_000;
  await setup.expense.create({
    data: {
      id: params.id,
      tenantId: TENANT,
      projectId: params.projectId,
      tipoDespesa: "MATERIAL_CONSTRUCAO",
      titulo: params.id,
      valor: amountCents,
      quantidade: 1,
      valorTotal: amountCents,
      formaPagamento: "A_VISTA",
      dataPagamento: PURCHASE_DATE,
      status: "PLANEJADO",
      cardLast4: params.cardLast4 ?? VISIBLE_LAST4,
      createdAt: PURCHASE_DATE,
      updatedAt: PURCHASE_DATE,
    },
  });
  await setup.cashFlowEntry.create({
    data: {
      id: `${params.id}-entry`,
      tenantId: TENANT,
      projectId: params.projectId,
      expenseId: params.id,
      valor: amountCents,
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

async function completeFinancialSnapshot() {
  const [
    imports,
    cardImports,
    expenses,
    receipts,
    entries,
    settlements,
    allocations,
    recurringBills,
  ] = await Promise.all([
    setup.bankStatementImport.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    setup.creditCardStatementImport.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    setup.receipt.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    setup.crossProjectSettlement.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    setup.rateioAllocation.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    setup.recurringBill.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
  ]);
  return {
    imports,
    cardImports,
    expenses,
    receipts,
    entries,
    settlements,
    allocations,
    recurringBills,
  };
}

function commit(
  service: BankAccountService,
  statement: Buffer,
  period: string,
) {
  return service.commitImport(
    TENANT,
    PESSOAL,
    ACCOUNT_ID,
    statement,
    "sec4-bank.ofx",
    "OFX",
    period,
    undefined,
    undefined,
    CREATED_BY,
    REQUESTER,
  );
}

async function expectSingleAuthorizedPayment(
  result: Awaited<ReturnType<typeof commit>>,
  expectedExternalId: string,
): Promise<void> {
  // #569 (blocker 5): cartão AUTORIZADO mas SEM compra participante ⇒ nenhuma
  // parcela liquidada ⇒ resultado honesto: não conta como `cardPayments`
  // (vinculado), cai no aviso de "saiu do saldo, nenhuma fatura quitada". O
  // pagamento continua criado — o teste segue provando que o lote NÃO foi
  // rejeitado por ACL.
  expect(result).toEqual(
    expect.objectContaining({
      source: "OFX",
      total: 1,
      inserted: 0,
      duplicated: 0,
      failedItems: [],
      receiptsInserted: 0,
      cardPayments: 0,
      unlinkedCardPayments: 1,
      skipped: 0,
      linked: 0,
    }),
  );

  const [payments, entries, storedImport] = await Promise.all([
    setup.expense.findMany({
      where: { tenantId: TENANT, importId: result.importId },
      select: {
        id: true,
        projectId: true,
        tipoDespesa: true,
        valor: true,
        valorTotal: true,
        status: true,
        importId: true,
        externalId: true,
        cardLast4: true,
        bankLast4: true,
        createdByUserId: true,
        dataPagamento: true,
        deletedAt: true,
      },
    }),
    setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT },
      select: { id: true, expenseId: true },
    }),
    setup.bankStatementImport.findUnique({
      where: { id: result.importId },
      select: {
        id: true,
        accountId: true,
        tenantId: true,
        periodLabel: true,
        source: true,
        status: true,
        inserted: true,
        duplicated: true,
        skipped: true,
        totalAmountCents: true,
        deletedAt: true,
      },
    }),
  ]);

  expect(payments).toEqual([
    {
      id: expect.any(String),
      projectId: PESSOAL,
      tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
      valor: 10_000,
      valorTotal: 10_000,
      status: "PAGO",
      importId: result.importId,
      externalId: expectedExternalId,
      // #569 (fix 2): cartão autorizado mas SEM compra participante ⇒ zero flip
      // ⇒ o pagamento NUNCA ganha `cardLast4` (sai do caixa, não abate fatura).
      cardLast4: null,
      bankLast4: BANK_LAST4,
      createdByUserId: CREATED_BY,
      dataPagamento: PAYMENT_DATE,
      deletedAt: null,
    },
  ]);
  expect(entries).toEqual([]);
  expect(storedImport).toEqual({
    id: result.importId,
    accountId: ACCOUNT_ID,
    tenantId: TENANT,
    periodLabel: "2026-07",
    source: "OFX",
    status: "COMPLETED",
    inserted: 0,
    duplicated: 0,
    skipped: 0,
    totalAmountCents: 10_000,
    deletedAt: null,
  });
}

describe("BankAccountService.commitImport — invoice child ACL and atomicity (SEC-4)", () => {
  let service: BankAccountService;

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
      data: { id: TENANT, name: "SEC-4 bank commit tenant" },
    });
    await setup.project.createMany({
      data: [
        {
          id: PESSOAL,
          tenantId: TENANT,
          type: "PESSOAL",
          name: "Pessoal",
        },
        {
          id: ALLOWED,
          tenantId: TENANT,
          type: "REFORMA",
          name: "Permitido",
        },
        {
          id: HIDDEN,
          tenantId: TENANT,
          type: "REFORMA",
          name: "Oculto",
        },
      ],
    });
    await setup.bankAccount.create({
      data: {
        id: ACCOUNT_ID,
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        nickname: "Conta SEC-4",
        last4: BANK_LAST4,
      },
    });

    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  it("linha normal antes de pagamento de fatura hidden rejeita o lote inteiro e preserva snapshot zero, inclusive import", async () => {
    await createCard({
      id: VISIBLE_CARD_ID,
      projectId: PESSOAL,
      last4: VISIBLE_LAST4,
      nickname: "Cartão visível",
    });
    await createPurchase({
      id: "sec4-bank-allowed-100",
      projectId: ALLOWED,
    });
    await createPurchase({
      id: "sec4-bank-hidden-100",
      projectId: HIDDEN,
    });
    const statement = bankOfx(
      ofxTransaction(
        "20260709",
        2_500,
        "MERCADO NORMAL PRIMEIRO",
        "SEC4-NORMAL-FIRST",
      ),
      ofxTransaction(
        "20260710",
        10_000,
        `PAGTO CART CRED ${VISIBLE_LAST4}`,
        "SEC4-HIDDEN-INVOICE",
      ),
    );
    const parsed = await parseBankStatementBuffers(
      [statement],
      ACCOUNT_ID,
      "OFX",
      "sec4-bank.ofx",
    );
    expect(
      parsed.transactions.map(({ merchant, amountCents }) => ({
        merchant,
        amountCents,
      })),
    ).toEqual([
      { merchant: "MERCADO NORMAL PRIMEIRO", amountCents: 2_500 },
      { merchant: `PAGTO CART CRED ${VISIBLE_LAST4}`, amountCents: 10_000 },
    ]);
    const before = await completeFinancialSnapshot();

    const error = await captureError(() =>
      commit(service, statement, "2026-07"),
    );
    const after = await completeFinancialSnapshot();

    expect({ rejection: rejectionShape(error), state: after }).toEqual({
      rejection: {
        name: "NotFoundException",
        status: 404,
        message: "Fatura não encontrada",
        body: {
          message: "Fatura não encontrada",
          error: "Not Found",
          statusCode: 404,
        },
      },
      state: before,
    });
    expect(after.imports).toEqual([]);
  });

  it("candidato hidden por valor não influencia o match nem impede fallback para o único cartão autorizado", async () => {
    await createCard({
      id: VISIBLE_CARD_ID,
      projectId: PESSOAL,
      last4: VISIBLE_LAST4,
      nickname: "Cartão autorizado sem participantes",
    });
    await createCard({
      id: HIDDEN_CARD_ID,
      projectId: HIDDEN,
      last4: HIDDEN_LAST4,
      nickname: "Cartão oculto",
    });
    await setup.creditCardStatementImport.create({
      data: {
        id: "sec4-hidden-amount-candidate",
        tenantId: TENANT,
        cardId: HIDDEN_CARD_ID,
        periodLabel: "2026-07",
        source: "OFX",
        totalAmountCents: 10_000,
        createdAt: PAYMENT_DATE,
        updatedAt: PAYMENT_DATE,
      },
    });
    const statement = bankOfx(
      ofxTransaction(
        "20260710",
        10_000,
        "FATURA PAGA CARTAO",
        "SEC4-HIDDEN-AMOUNT-CANDIDATE",
      ),
    );
    const parsed = await parseBankStatementBuffers(
      [statement],
      ACCOUNT_ID,
      "OFX",
      "sec4-bank.ofx",
    );

    const result = await commit(service, statement, "2026-07");

    await expectSingleAuthorizedPayment(
      result,
      parsed.transactions[0].externalId,
    );
    const hiddenImport = await setup.creditCardStatementImport.findUnique({
      where: { id: "sec4-hidden-amount-candidate" },
      select: { cardId: true, totalAmountCents: true, deletedAt: true },
    });
    expect(hiddenImport).toEqual({
      cardId: HIDDEN_CARD_ID,
      totalAmountCents: 10_000,
      deletedAt: null,
    });
  });

  it("pagamento reconhecido com cartão autorizado e nenhuma compra participante continua válido", async () => {
    await createCard({
      id: VISIBLE_CARD_ID,
      projectId: PESSOAL,
      last4: VISIBLE_LAST4,
      nickname: "Cartão autorizado sem participantes",
    });
    const statement = bankOfx(
      ofxTransaction(
        "20260710",
        10_000,
        "FATURA PAGA CARTAO",
        "SEC4-AUTHORIZED-NO-PARTICIPANT",
      ),
    );
    const parsed = await parseBankStatementBuffers(
      [statement],
      ACCOUNT_ID,
      "OFX",
      "sec4-bank.ofx",
    );

    const result = await commit(service, statement, "2026-07");

    await expectSingleAuthorizedPayment(
      result,
      parsed.transactions[0].externalId,
    );
  });
});
