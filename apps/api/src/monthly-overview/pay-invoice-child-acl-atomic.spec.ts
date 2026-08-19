// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  MonthlyOverviewMutationRequester,
  MonthlyOverviewService,
} from "./monthly-overview.service";

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "sec4-pay-invoice-tenant";
const PESSOAL = "sec4-pay-invoice-pessoal";
const ALLOWED = "sec4-pay-invoice-allowed";
const HIDDEN = "sec4-pay-invoice-hidden";
const CARD_ID = "sec4-pay-invoice-card";
const ACCOUNT_ID = "sec4-pay-invoice-account";
const CARD_LAST4 = "4488";
const BANK_LAST4 = "1881";
const FAILURE_TRIGGER = "sec4_pay_invoice_apply_failure";

const FIXED_CLOCK = new Date("2026-08-19T15:00:00.000Z");
const PURCHASE_DATE = new Date("2026-06-15T12:00:00.000Z");
const PAYMENT_DATE = new Date("2026-07-10T12:00:00.000Z");

const REQUESTER: MonthlyOverviewMutationRequester = {
  id: "sec4-pay-invoice-user",
  role: "USER",
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses"],
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

async function dropFailureTrigger(): Promise<void> {
  await setup.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${FAILURE_TRIGGER}"`);
}

async function cleanupTransient(): Promise<void> {
  await dropFailureTrigger();
  await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setup.expense.deleteMany({ where: { tenantId: TENANT } });
}

async function cleanupAll(): Promise<void> {
  await cleanupTransient();
  await setup.creditCard.deleteMany({ where: { tenantId: TENANT } });
  await setup.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  await setup.project.deleteMany({ where: { tenantId: TENANT } });
  await setup.tenant.deleteMany({ where: { id: TENANT } });
}

async function createPurchase(
  id: string,
  projectId: string,
  amountCents = 10_000,
): Promise<void> {
  await setup.expense.create({
    data: {
      id,
      tenantId: TENANT,
      projectId,
      tipoDespesa: "MATERIAL_CONSTRUCAO",
      titulo: id,
      valor: amountCents,
      quantidade: 1,
      valorTotal: amountCents,
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
      id: `${id}-entry`,
      tenantId: TENANT,
      projectId,
      expenseId: id,
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

async function financialSnapshot() {
  const [expenses, entries] = await Promise.all([
    setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      select: {
        id: true,
        projectId: true,
        tipoDespesa: true,
        valor: true,
        valorTotal: true,
        status: true,
        paidParcelas: true,
        cardLast4: true,
        bankLast4: true,
        createdByUserId: true,
        dataPagamento: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      select: {
        id: true,
        projectId: true,
        expenseId: true,
        valor: true,
        status: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);
  return { expenses, entries };
}

function payInvoice(service: MonthlyOverviewService, amountCents: number) {
  return service.payInvoice(
    TENANT,
    PESSOAL,
    {
      cardId: CARD_ID,
      cardLast4: CARD_LAST4,
      month: "2026-07",
      amountCents,
      accountId: ACCOUNT_ID,
      bankLast4: BANK_LAST4,
      paymentDate: PAYMENT_DATE.toISOString(),
    },
    REQUESTER,
  );
}

describe("MonthlyOverviewService.payInvoice — child ACL and atomicity (SEC-4)", () => {
  let service: MonthlyOverviewService;

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
      data: { id: TENANT, name: "SEC-4 pay invoice tenant" },
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
    await setup.creditCard.create({
      data: {
        id: CARD_ID,
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão SEC-4",
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
        nickname: "Conta SEC-4",
        last4: BANK_LAST4,
      },
    });

    service = new MonthlyOverviewService(
      prisma,
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

  it("R$100 visível + R$100 oculto com pagamento de R$100 retorna o 404 uniforme e faz zero writes", async () => {
    await createPurchase("sec4-pay-allowed-100", ALLOWED);
    await createPurchase("sec4-pay-hidden-100", HIDDEN);
    const before = await financialSnapshot();

    const error = await captureError(() => payInvoice(service, 10_000));
    const after = await financialSnapshot();

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
    expect(
      after.expenses.filter(
        (expense) => expense.tipoDespesa === "PAGAMENTO_FATURA_CARTAO",
      ),
    ).toHaveLength(0);
  });

  it("pagamento parcial autorizado persiste, mas não liquida nenhuma despesa ou parcela", async () => {
    await createPurchase("sec4-partial-allowed-a", ALLOWED);
    await createPurchase("sec4-partial-allowed-b", ALLOWED);
    const before = await financialSnapshot();

    const result = await payInvoice(service, 10_000);
    const after = await financialSnapshot();
    const payment = after.expenses.find(
      (expense) => expense.id === result.paymentExpenseId,
    );

    expect(result).toEqual({
      ok: true,
      paymentExpenseId: expect.any(String),
      cardId: CARD_ID,
      cardLast4: CARD_LAST4,
      accountId: ACCOUNT_ID,
      month: "2026-07",
      amountCents: 10_000,
      settledExpenses: 0,
      settledParcelas: 0,
    });
    expect(payment).toMatchObject({
      projectId: PESSOAL,
      tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
      valor: 10_000,
      valorTotal: 10_000,
      status: "PAGO",
      paidParcelas: null,
      cardLast4: CARD_LAST4,
      bankLast4: BANK_LAST4,
      createdByUserId: REQUESTER.id,
      dataPagamento: PAYMENT_DATE,
      deletedAt: null,
    });
    expect(
      after.expenses
        .filter((expense) => expense.tipoDespesa !== "PAGAMENTO_FATURA_CARTAO")
        .map(({ id, status, paidParcelas, updatedAt }) => ({
          id,
          status,
          paidParcelas,
          updatedAt,
        })),
    ).toEqual(
      before.expenses.map(({ id, status, paidParcelas, updatedAt }) => ({
        id,
        status,
        paidParcelas,
        updatedAt,
      })),
    );
    expect(after.entries).toEqual(before.entries);
  });

  it("falha forçada durante apply da liquidação reverte também a despesa de pagamento", async () => {
    const purchaseId = "sec4-forced-apply-purchase";
    await createPurchase(purchaseId, ALLOWED);
    const before = await financialSnapshot();

    await setup.$executeRawUnsafe(`
      CREATE TRIGGER "${FAILURE_TRIGGER}"
      BEFORE UPDATE OF "status" ON "cash_flow_entries"
      WHEN OLD."id" = '${purchaseId}-entry' AND NEW."status" = 'PAGO'
      BEGIN
        SELECT RAISE(ABORT, 'sec4 forced apply failure');
      END
    `);

    let error: unknown;
    try {
      error = await captureError(() => payInvoice(service, 10_000));
    } finally {
      await dropFailureTrigger();
    }
    const after = await financialSnapshot();

    expect(error).toBeInstanceOf(Error);
    expect(after).toEqual(before);
    expect(
      after.expenses.filter(
        (expense) => expense.tipoDespesa === "PAGAMENTO_FATURA_CARTAO",
      ),
    ).toHaveLength(0);
  });
});
