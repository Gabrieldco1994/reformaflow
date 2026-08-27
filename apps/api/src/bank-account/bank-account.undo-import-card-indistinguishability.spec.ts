// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { ConflictException, HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "./bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "../expense/rateio.types";

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "bank-undo-card-indistinguishable-tenant";
const CROSS_TENANT = "bank-undo-card-indistinguishable-cross";
const PESSOAL = "bank-undo-card-indistinguishable-pessoal";
const ALLOWED = "bank-undo-card-indistinguishable-allowed";
const HIDDEN = "bank-undo-card-indistinguishable-hidden";
const CROSS_PROJECT = "bank-undo-card-indistinguishable-cross-project";
const LAST4 = "4488";
const IMPORT_CREATED = new Date("2026-08-18T12:00:00.000Z");
const PAYMENT_CREATED = new Date("2026-08-18T12:01:00.000Z");
const PAYMENT_DATE = new Date("2026-08-10T12:00:00.000Z");

const MANAGED: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses"],
};

type CardScenario = "missing" | "ambiguous" | "cross-tenant" | "hidden";

function rejectionShape(error: unknown) {
  if (!(error instanceof HttpException)) {
    return {
      name: error instanceof Error ? error.name : typeof error,
      status: null,
      message: error instanceof Error ? error.message : String(error),
      body: null,
    };
  }
  return {
    name: error.constructor.name,
    status: error.getStatus(),
    message: error.message,
    body: error.getResponse(),
  };
}

describe("BankAccountService.undoImport — cartão indistinguível e zero-write", () => {
  let service: BankAccountService;
  let accountId: string;

  async function cleanupTransient(): Promise<void> {
    await setupPrisma.rateioAllocation.deleteMany({
      where: { tenantId: TENANT },
    });
    await setupPrisma.crossProjectSettlement.deleteMany({
      where: { tenantId: TENANT },
    });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.receipt.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({
      where: { tenantId: TENANT },
    });
    await setupPrisma.creditCardStatementImport.deleteMany({
      where: { tenantId: { in: [TENANT, CROSS_TENANT] } },
    });
    await setupPrisma.creditCard.deleteMany({
      where: { tenantId: { in: [TENANT, CROSS_TENANT] } },
    });
  }

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupTransient();
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({
      where: { tenantId: { in: [TENANT, CROSS_TENANT] } },
    });
    await setupPrisma.tenant.deleteMany({
      where: { id: { in: [TENANT, CROSS_TENANT] } },
    });

    await setupPrisma.tenant.createMany({
      data: [
        { id: TENANT, name: "Bank undo card indistinguishability" },
        { id: CROSS_TENANT, name: "Cross tenant" },
      ],
    });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
        { id: ALLOWED, tenantId: TENANT, type: "REFORMA", name: "Permitido" },
        { id: HIDDEN, tenantId: TENANT, type: "REFORMA", name: "Oculto" },
        {
          id: CROSS_PROJECT,
          tenantId: CROSS_TENANT,
          type: "REFORMA",
          name: "Outro tenant",
        },
      ],
    });
    const account = await setupPrisma.bankAccount.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        nickname: "Conta SEC-4",
        last4: "1881",
      },
    });
    accountId = account.id;
    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupTransient();
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({
      where: { tenantId: { in: [TENANT, CROSS_TENANT] } },
    });
    await setupPrisma.tenant.deleteMany({
      where: { id: { in: [TENANT, CROSS_TENANT] } },
    });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  async function createCardScenario(scenario: CardScenario): Promise<void> {
    if (scenario === "missing") return;
    const cards =
      scenario === "ambiguous"
        ? [
            { id: "ambiguous-card-a", projectId: ALLOWED },
            { id: "ambiguous-card-b", projectId: ALLOWED },
          ]
        : scenario === "cross-tenant"
          ? [{ id: "cross-tenant-card", projectId: CROSS_PROJECT }]
          : [{ id: "hidden-card", projectId: HIDDEN }];

    await setupPrisma.creditCard.createMany({
      data: cards.map(({ id, projectId }) => ({
        id,
        tenantId: scenario === "cross-tenant" ? CROSS_TENANT : TENANT,
        projectId,
        institution: "ITAU",
        brand: "Visa",
        nickname: id,
        last4: LAST4,
        closingDay: 20,
        dueDay: 10,
      })),
    });
  }

  async function createImportedPayment(key: CardScenario): Promise<string> {
    const importId = `sec4-${key}-import`;
    const paymentId = `sec4-${key}-payment`;
    await setupPrisma.bankStatementImport.create({
      data: {
        id: importId,
        tenantId: TENANT,
        accountId,
        periodLabel: "2026-08",
        source: "OFX",
        inserted: 1,
        totalAmountCents: 10_000,
        createdAt: IMPORT_CREATED,
        updatedAt: IMPORT_CREATED,
      },
    });
    await setupPrisma.expense.create({
      data: {
        id: paymentId,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "Pagamento de fatura",
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        formaPagamento: "A_VISTA",
        dataPagamento: PAYMENT_DATE,
        status: "PAGO",
        cardLast4: LAST4,
        bankLast4: "1881",
        accountId,
        importId,
        origin: "import",
        createdAt: PAYMENT_CREATED,
        updatedAt: PAYMENT_CREATED,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${paymentId}-entry`,
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: paymentId,
        valor: 10_000,
        tipo: "DESPESA",
        data: PAYMENT_DATE,
        categoria: "Pagamento de fatura",
        formaPagamento: "A_VISTA",
        status: "PAGO",
        createdAt: PAYMENT_CREATED,
        updatedAt: PAYMENT_CREATED,
      },
    });
    return importId;
  }

  async function snapshot() {
    const [
      imports,
      expenses,
      entries,
      receipts,
      allocations,
      settlements,
      cards,
    ] = await Promise.all([
      setupPrisma.bankStatementImport.findMany({
        where: { tenantId: TENANT },
        select: { id: true, deletedAt: true },
        orderBy: { id: "asc" },
      }),
      setupPrisma.expense.findMany({
        where: { tenantId: TENANT },
        select: {
          id: true,
          deletedAt: true,
          importId: true,
          externalId: true,
          status: true,
          paidParcelas: true,
          linkedExpenseId: true,
          settledByExpenseId: true,
        },
        orderBy: { id: "asc" },
      }),
      setupPrisma.cashFlowEntry.findMany({
        where: { tenantId: TENANT },
        select: { id: true, expenseId: true, deletedAt: true, status: true },
        orderBy: { id: "asc" },
      }),
      setupPrisma.receipt.findMany({
        where: { tenantId: TENANT },
        select: { id: true, deletedAt: true, linkedReceiptId: true },
        orderBy: { id: "asc" },
      }),
      setupPrisma.rateioAllocation.findMany({
        where: { tenantId: TENANT },
        select: { id: true },
        orderBy: { id: "asc" },
      }),
      setupPrisma.crossProjectSettlement.findMany({
        where: { tenantId: TENANT },
        select: { id: true },
        orderBy: { id: "asc" },
      }),
      setupPrisma.creditCard.findMany({
        where: { tenantId: { in: [TENANT, CROSS_TENANT] } },
        select: {
          id: true,
          tenantId: true,
          projectId: true,
          last4: true,
          deletedAt: true,
        },
        orderBy: { id: "asc" },
      }),
    ]);
    return {
      imports,
      expenses,
      entries,
      receipts,
      allocations,
      settlements,
      cards,
    };
  }

  it.each([
    ["same-last4 missing", "missing"],
    ["same-last4 ambíguo", "ambiguous"],
    ["same-last4 cross-tenant", "cross-tenant"],
    ["same-last4 hidden", "hidden"],
  ] as const)(
    // #569 (hotfix fail-closed): o undo não consulta mais cartão por `last4`.
    // Basta o lote conter um `PAGAMENTO_FATURA_CARTAO` para o undo em lote ser
    // barrado com 409, ANTES de qualquer escrita — o estado do cartão
    // (ausente/ambíguo/cross-tenant/oculto) é literalmente inobservável, e o
    // snapshot fica integralmente idêntico nos quatro cenários.
    "%s retorna o mesmo 409 fail-closed e preserva snapshot integral",
    async (_label, scenario) => {
      await createCardScenario(scenario);
      const importId = await createImportedPayment(scenario);
      const before = await snapshot();

      let error: unknown;
      try {
        await service.undoImport(TENANT, PESSOAL, accountId, importId, MANAGED);
      } catch (caught) {
        error = caught;
      }
      const after = await snapshot();

      const expectedMessage =
        "Esta importação contém pagamento de fatura de cartão. Lotes com " +
        "pagamento de fatura permanecem intactos por segurança e não podem " +
        "ser desfeitos automaticamente.";
      expect(rejectionShape(error)).toEqual({
        name: ConflictException.name,
        status: 409,
        message: expectedMessage,
        body: {
          message: expectedMessage,
          error: "Conflict",
          statusCode: 409,
        },
      });
      expect(after).toEqual(before);
    },
  );
});
