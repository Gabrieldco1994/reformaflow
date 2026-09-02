// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { BankAccountController } from "../bank-account.controller";
import { BankAccountService } from "../bank-account.service";
import { CardInvoiceSettlementService } from "../../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import type { RateioRequester } from "../../expense/rateio.types";
import { MerchantClassifierService } from "../../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../../prisma/prisma.service";

const CLOCK = new Date("2026-08-19T15:00:00.000Z");
const TRANSACTION_DATE = new Date("2026-08-10T12:00:00.000Z");

const IDS = {
  tenant: "qa480-bank-tenant-a",
  otherTenant: "qa480-bank-tenant-b",
  source: "qa480-bank-pessoal",
  allowed: "qa480-bank-allowed",
  hidden: "qa480-bank-hidden",
  typeHidden: "qa480-bank-type-hidden",
  deletedProject: "qa480-bank-deleted-project",
  crossProject: "qa480-bank-cross-project",
  account: "qa480-bank-account",
  allowedCard: "qa480-bank-card-allowed",
  hiddenCard: "qa480-bank-card-hidden",
  hiddenDuplicateCard: "qa480-bank-card-hidden-duplicate-sentinel",
  deletedCard: "qa480-bank-card-deleted",
  crossCard: "qa480-bank-card-cross",
  allowedExpense: "qa480-bank-expense-allowed",
  hiddenExpense: "qa480-bank-expense-hidden-sentinel",
  typeExpense: "qa480-bank-expense-type-sentinel",
  deletedExpense: "qa480-bank-expense-deleted-sentinel",
  crossExpense: "qa480-bank-expense-cross-sentinel",
  allowedReceipt: "qa480-bank-receipt-allowed",
  hiddenReceipt: "qa480-bank-receipt-hidden-sentinel",
  typeReceipt: "qa480-bank-receipt-type-sentinel",
  deletedReceipt: "qa480-bank-receipt-deleted-sentinel",
  crossReceipt: "qa480-bank-receipt-cross-sentinel",
  importedExpense: "qa480-bank-imported-expense",
  importedReceipt: "qa480-bank-imported-receipt",
  // #480 SEC-1: projeto de tipo SEM o módulo do recurso (PLANTAS não tem
  // `expenses`); alcançável só por um módulo não relacionado (`plantsAi`).
  moduleHiddenProject: "qa480-bank-module-hidden-project",
  moduleHiddenExpense: "qa480-bank-expense-module-sentinel",
  moduleHiddenReceipt: "qa480-bank-receipt-module-sentinel",
} as const;

const HIDDEN_SENTINELS = [
  IDS.hidden,
  IDS.hiddenExpense,
  IDS.hiddenReceipt,
  IDS.hiddenCard,
  IDS.hiddenDuplicateCard,
  "Projeto bancário oculto SENTINELA",
  "Despesa bancária oculta SENTINELA",
  "Receita bancária oculta SENTINELA",
  "Cartão bancário oculto SENTINELA",
  "Cartão bancário duplicado oculto SENTINELA",
  "9002",
] as const;

const projectRestrictedRequester: RateioRequester & { id: string } = {
  id: "qa480-bank-user-project",
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed],
  allowedProjectTypes: ["PESSOAL", "REFORMA", "CASA"],
  allowedModules: ["bankAccounts", "creditCards", "expenses", "receipts"],
};

const typeRestrictedRequester: RateioRequester & { id: string } = {
  id: "qa480-bank-user-type",
  role: "USER",
  allowedProjects: [],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["bankAccounts", "creditCards", "expenses", "receipts"],
};

const moduleRestrictedRequester: RateioRequester & { id: string } = {
  id: "qa480-bank-user-module",
  role: "USER",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: ["bankAccounts"],
};

const ownerRequester: RateioRequester & { id: string } = {
  id: "qa480-bank-owner",
  role: "OWNER",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

/**
 * #480 SEC-1 — alcança o projeto REFORMA por módulos NÃO relacionados ao
 * recurso (`bankAccounts` para a própria conta, `creditCards` para o cartão).
 * Sem `expenses`/`receipts` não pode ver candidato Expense nem Receipt.
 */
const unrelatedModuleRequester: RateioRequester & { id: string } = {
  id: "qa480-bank-user-unrelated-module",
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["bankAccounts", "creditCards"],
};

/** Alcança REFORMA por `pendencias`; sem `creditCards` não vê cartão/fatura. */
const noCardModuleRequester: RateioRequester & { id: string } = {
  id: "qa480-bank-user-no-card-module",
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["bankAccounts", "pendencias"],
};

/** Alcança PLANTAS por `plantsAi` — tipo que NÃO tem o módulo `expenses`. */
const expenseRankRequester: RateioRequester & { id: string } = {
  id: "qa480-bank-user-expense-rank",
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed, IDS.moduleHiddenProject],
  allowedProjectTypes: ["PESSOAL", "REFORMA", "PLANTAS"],
  allowedModules: ["bankAccounts", "expenses", "plantsAi"],
};

/** Alcança CASA por `maintenance` — tipo que NÃO tem o módulo `receipts`. */
const receiptRankRequester: RateioRequester & { id: string } = {
  id: "qa480-bank-user-receipt-rank",
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed, IDS.typeHidden],
  allowedProjectTypes: ["PESSOAL", "REFORMA", "CASA"],
  allowedModules: ["bankAccounts", "receipts", "maintenance"],
};

const adminRequester: RateioRequester & { id: string } = {
  ...ownerRequester,
  id: "qa480-bank-admin",
  role: "ADMIN",
};

function bankOfx(): Buffer {
  const transaction = (
    type: "DEBIT" | "CREDIT",
    amount: string,
    memo: string,
    fitId: string,
  ) =>
    [
      "<STMTTRN>",
      `<TRNTYPE>${type}</TRNTYPE>`,
      "<DTPOSTED>20260810</DTPOSTED>",
      `<TRNAMT>${amount}</TRNAMT>`,
      `<FITID>${fitId}</FITID>`,
      `<MEMO>${memo}</MEMO>`,
      "</STMTTRN>",
    ].join("");

  return Buffer.from(
    [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
      "<BANKACCTFROM><ACCTID>4801</ACCTID></BANKACCTFROM>",
      "<BANKTRANLIST>",
      transaction("DEBIT", "-100.00", "MATERIAL QA 480", "QA480-BANK-DEBIT"),
      transaction("CREDIT", "200.00", "RECEITA QA 480", "QA480-BANK-CREDIT"),
      transaction("DEBIT", "-300.00", "PAGTO CART CRED", "QA480-BANK-INVOICE"),
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
    ].join("\n"),
  );
}

function uploadFile(buffer: Buffer): Express.Multer.File {
  return {
    fieldname: "files",
    originalname: "qa480-extrato.ofx",
    encoding: "7bit",
    mimetype: "application/x-ofx",
    size: buffer.length,
    destination: "",
    filename: "qa480-extrato.ofx",
    path: "",
    buffer,
    stream: undefined as never,
  };
}

function errorContract(error: unknown) {
  if (!(error instanceof HttpException)) {
    return {
      name: (error as Error)?.constructor.name,
      status: null,
      message: (error as Error)?.message,
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

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("bank candidate disclosure integration (#480)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const service = new BankAccountService(
    prisma,
    new MerchantClassifierService(prisma),
    new ConciliacaoService(prisma),
    new CardInvoiceSettlementService(prisma),
  );
  const controller = new BankAccountController(service);

  async function cleanupTransient() {
    await setup.rateioAllocation.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.crossProjectSettlement.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.cashFlowEntry.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.expense.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.receipt.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.bankStatementImport.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.creditCardStatementImport.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
  }

  async function cleanupAll() {
    await cleanupTransient();
    await setup.bankAccount.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.creditCard.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.project.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.tenant.deleteMany({
      where: { id: { in: [IDS.tenant, IDS.otherTenant] } },
    });
  }

  async function createExpense(input: {
    id: string;
    tenantId?: string;
    projectId: string;
    title: string;
    amount?: number;
    date?: Date;
    status?: string;
    deletedAt?: Date | null;
    bankLast4?: string | null;
    cardLast4?: string | null;
  }) {
    const amount = input.amount ?? 10_000;
    const date = input.date ?? TRANSACTION_DATE;
    await setup.expense.create({
      data: {
        id: input.id,
        tenantId: input.tenantId ?? IDS.tenant,
        projectId: input.projectId,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        titulo: input.title,
        fornecedor: input.title,
        valor: amount,
        quantidade: 1,
        valorTotal: amount,
        formaPagamento: "A_VISTA",
        dataPagamento: date,
        status: input.status ?? "PLANEJADO",
        bankLast4: input.bankLast4,
        cardLast4: input.cardLast4,
        createdAt: date,
        updatedAt: date,
        deletedAt: input.deletedAt,
      },
    });
  }

  async function createReceipt(input: {
    id: string;
    tenantId?: string;
    projectId: string;
    description: string;
    amount?: number;
    date?: Date;
    status?: string;
    deletedAt?: Date | null;
    bankLast4?: string | null;
  }) {
    const date = input.date ?? TRANSACTION_DATE;
    await setup.receipt.create({
      data: {
        id: input.id,
        tenantId: input.tenantId ?? IDS.tenant,
        projectId: input.projectId,
        valor: input.amount ?? 20_000,
        data: date,
        tipo: "PAGAMENTO",
        status: input.status ?? "PREVISTO",
        descricao: input.description,
        bankLast4: input.bankLast4,
        createdAt: date,
        updatedAt: date,
        deletedAt: input.deletedAt,
      },
    });
  }

  async function createInvoicePurchase(input: {
    id: string;
    tenantId?: string;
    projectId: string;
    cardLast4: string;
    amount: number;
    deletedAt?: Date | null;
  }) {
    const tenantId = input.tenantId ?? IDS.tenant;
    await createExpense({
      id: input.id,
      tenantId,
      projectId: input.projectId,
      title: `${input.id} purchase`,
      amount: input.amount,
      cardLast4: input.cardLast4,
      status: "PAGO",
      deletedAt: input.deletedAt,
    });
    await setup.cashFlowEntry.create({
      data: {
        id: `${input.id}-cash`,
        tenantId,
        projectId: input.projectId,
        expenseId: input.id,
        valor: input.amount,
        tipo: "DESPESA",
        data: TRANSACTION_DATE,
        categoria: "MATERIAL_CONSTRUCAO",
        formaPagamento: "CARTAO_CREDITO",
        status: "PAGO",
        createdAt: TRANSACTION_DATE,
        updatedAt: TRANSACTION_DATE,
        deletedAt: input.deletedAt,
      },
    });
  }

  async function seedDisclosureCandidates() {
    await Promise.all([
      createExpense({
        id: IDS.allowedExpense,
        projectId: IDS.allowed,
        title: "Despesa bancária permitida",
        amount: 10_001,
      }),
      createExpense({
        id: IDS.hiddenExpense,
        projectId: IDS.hidden,
        title: "Despesa bancária oculta SENTINELA",
      }),
      createExpense({
        id: IDS.typeExpense,
        projectId: IDS.typeHidden,
        title: "Despesa bancária tipo oculto SENTINELA",
      }),
      createExpense({
        id: IDS.deletedExpense,
        projectId: IDS.deletedProject,
        title: "Despesa bancária deletada SENTINELA",
        deletedAt: CLOCK,
      }),
      createExpense({
        id: IDS.crossExpense,
        tenantId: IDS.otherTenant,
        projectId: IDS.crossProject,
        title: "Despesa bancária cross-tenant SENTINELA",
      }),
      createReceipt({
        id: IDS.allowedReceipt,
        projectId: IDS.allowed,
        description: "Receita bancária permitida",
        amount: 20_001,
      }),
      createReceipt({
        id: IDS.hiddenReceipt,
        projectId: IDS.hidden,
        description: "Receita bancária oculta SENTINELA",
      }),
      createReceipt({
        id: IDS.typeReceipt,
        projectId: IDS.typeHidden,
        description: "Receita bancária tipo oculto SENTINELA",
      }),
      createReceipt({
        id: IDS.deletedReceipt,
        projectId: IDS.deletedProject,
        description: "Receita bancária deletada SENTINELA",
        deletedAt: CLOCK,
      }),
      createReceipt({
        id: IDS.crossReceipt,
        tenantId: IDS.otherTenant,
        projectId: IDS.crossProject,
        description: "Receita bancária cross-tenant SENTINELA",
      }),
      createInvoicePurchase({
        id: "qa480-bank-invoice-allowed",
        projectId: IDS.allowed,
        cardLast4: "9001",
        amount: 30_000,
      }),
      createInvoicePurchase({
        id: "qa480-bank-invoice-hidden",
        projectId: IDS.hidden,
        cardLast4: "9002",
        amount: 30_000,
      }),
      createInvoicePurchase({
        id: "qa480-bank-invoice-deleted",
        projectId: IDS.deletedProject,
        cardLast4: "9003",
        amount: 30_000,
        deletedAt: CLOCK,
      }),
      createInvoicePurchase({
        id: "qa480-bank-invoice-cross",
        tenantId: IDS.otherTenant,
        projectId: IDS.crossProject,
        cardLast4: "9004",
        amount: 30_000,
      }),
    ]);
  }

  async function setHiddenActive(active: boolean) {
    const deletedAt = active ? null : CLOCK;
    await setup.project.update({
      where: { id: IDS.hidden },
      data: { deletedAt },
    });
    await setup.creditCard.update({
      where: { id: IDS.hiddenCard },
      data: { deletedAt },
    });
  }

  /** Liga/desliga um candidato individual (presente × ausente) sem tocar no resto. */
  async function setExpenseActive(id: string, active: boolean) {
    await setup.expense.update({
      where: { id },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  async function setReceiptActive(id: string, active: boolean) {
    await setup.receipt.update({
      where: { id },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  async function setCardActive(id: string, active: boolean) {
    await setup.creditCard.update({
      where: { id },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  function candidateRefs(payload: { preview: any[] }) {
    return payload.preview.flatMap((row: any) =>
      row.crossProjectMatches.map((match: any) => ({
        kind: match.kind,
        id: match.kind === "expense" ? match.expenseId : match.receiptId,
      })),
    );
  }

  async function preview(requester: RateioRequester & { id: string }) {
    return (await controller.importStatement(
      IDS.tenant,
      requester,
      IDS.source,
      IDS.account,
      [uploadFile(bankOfx())],
      { mode: "preview", source: "OFX" },
      undefined,
    )) as Awaited<ReturnType<BankAccountService["previewImport"]>>;
  }

  async function suggestExpenses(requester: RateioRequester & { id: string }) {
    return (controller as any).suggestLinks(
      IDS.tenant,
      IDS.source,
      IDS.account,
      requester,
    );
  }

  async function suggestReceipts(requester: RateioRequester & { id: string }) {
    return (controller as any).suggestReceiptLinks(
      IDS.tenant,
      IDS.source,
      IDS.account,
      requester,
    );
  }

  async function financialState() {
    const where = { tenantId: IDS.tenant };
    const [
      imports,
      cardImports,
      expenses,
      receipts,
      cash,
      settlements,
      rateios,
    ] = await Promise.all([
      setup.bankStatementImport.findMany({
        where,
        select: { id: true, inserted: true, duplicated: true, skipped: true },
        orderBy: { id: "asc" },
      }),
      setup.creditCardStatementImport.findMany({
        where,
        select: { id: true, inserted: true, duplicated: true, skipped: true },
        orderBy: { id: "asc" },
      }),
      setup.expense.findMany({
        where,
        select: {
          id: true,
          status: true,
          linkedExpenseId: true,
          deletedAt: true,
        },
        orderBy: { id: "asc" },
      }),
      setup.receipt.findMany({
        where,
        select: {
          id: true,
          status: true,
          linkedReceiptId: true,
          deletedAt: true,
        },
        orderBy: { id: "asc" },
      }),
      setup.cashFlowEntry.findMany({
        where,
        select: { id: true, status: true, deletedAt: true },
        orderBy: { id: "asc" },
      }),
      setup.crossProjectSettlement.findMany({
        where,
        select: {
          id: true,
          sourceExpenseId: true,
          targetExpenseId: true,
        },
        orderBy: { id: "asc" },
      }),
      setup.rateioAllocation.findMany({
        where,
        select: {
          id: true,
          sourceExpenseId: true,
          targetExpenseId: true,
        },
        orderBy: { id: "asc" },
      }),
    ]);
    return {
      imports,
      cardImports,
      expenses,
      receipts,
      cash,
      settlements,
      rateios,
    };
  }

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
    jest.setSystemTime(CLOCK);
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.createMany({
      data: [
        { id: IDS.tenant, name: "QA 480 bank tenant A" },
        { id: IDS.otherTenant, name: "QA 480 bank tenant B" },
      ],
    });
    await setup.project.createMany({
      data: [
        {
          id: IDS.source,
          tenantId: IDS.tenant,
          type: "PESSOAL",
          name: "Pessoal bancário",
        },
        {
          id: IDS.allowed,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto bancário permitido",
        },
        {
          id: IDS.hidden,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto bancário oculto SENTINELA",
        },
        {
          id: IDS.typeHidden,
          tenantId: IDS.tenant,
          type: "CASA",
          name: "Projeto bancário tipo oculto SENTINELA",
        },
        {
          id: IDS.deletedProject,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto bancário deletado SENTINELA",
        },
        {
          id: IDS.crossProject,
          tenantId: IDS.otherTenant,
          type: "REFORMA",
          name: "Projeto bancário cross-tenant SENTINELA",
        },
        {
          id: IDS.moduleHiddenProject,
          tenantId: IDS.tenant,
          type: "PLANTAS",
          name: "Projeto bancário módulo oculto SENTINELA",
        },
      ],
    });
    await setup.bankAccount.create({
      data: {
        id: IDS.account,
        tenantId: IDS.tenant,
        projectId: IDS.source,
        institution: "ITAU",
        nickname: "Conta QA 480",
        last4: "4801",
      },
    });
    await setup.creditCard.createMany({
      data: [
        {
          id: IDS.allowedCard,
          tenantId: IDS.tenant,
          projectId: IDS.allowed,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Cartão bancário permitido",
          last4: "9001",
          closingDay: null,
          dueDay: 10,
        },
        {
          id: IDS.hiddenCard,
          tenantId: IDS.tenant,
          projectId: IDS.hidden,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Cartão bancário oculto SENTINELA",
          last4: "9002",
          closingDay: null,
          dueDay: 10,
        },
        {
          id: IDS.hiddenDuplicateCard,
          tenantId: IDS.tenant,
          projectId: IDS.hidden,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Cartão bancário duplicado oculto SENTINELA",
          last4: "9001",
          closingDay: null,
          dueDay: 10,
        },
        {
          id: IDS.deletedCard,
          tenantId: IDS.tenant,
          projectId: IDS.deletedProject,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Cartão bancário deletado SENTINELA",
          last4: "9003",
          closingDay: null,
          dueDay: 10,
          deletedAt: CLOCK,
        },
        {
          id: IDS.crossCard,
          tenantId: IDS.otherTenant,
          projectId: IDS.crossProject,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Cartão bancário cross-tenant SENTINELA",
          last4: "9004",
          closingDay: null,
          dueDay: 10,
        },
      ],
    });
  });

  beforeEach(async () => {
    await cleanupTransient();
    await setHiddenActive(true);
    await seedDisclosureCandidates();
  });

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  it("makes hidden (including duplicate last4), absent, cross-tenant and deleted candidates deep-equal before ranking, auto-selection and totals", async () => {
    const before = await financialState();
    const hiddenPresent = await preview(projectRestrictedRequester);
    const afterHiddenPreview = await financialState();

    await setHiddenActive(false);
    const hiddenAbsent = await preview(projectRestrictedRequester);
    const afterAbsentPreview = await financialState();

    expect(hiddenPresent).toEqual(hiddenAbsent);
    expect(afterHiddenPreview).toEqual(before);
    expect(afterAbsentPreview).toEqual(before);
    expect(hiddenPresent).toEqual({
      source: "OFX",
      periodLabel: "2026-08",
      totalAmountCents: 40_000,
      total: 3,
      totalDebits: 2,
      totalCredits: 1,
      duplicated: 0,
      inserted: 0,
      classificationStatus: 'unavailable',
      preview: [
        expect.objectContaining({
          merchant: "MATERIAL QA 480",
          amountCents: 10_000,
          date: "2026-08-10",
          isCredit: false,
          crossProjectMatches: [
            expect.objectContaining({
              kind: "expense",
              expenseId: IDS.allowedExpense,
              projectId: IDS.allowed,
              projectName: "Projeto bancário permitido",
              valorCents: 10_001,
              deltaCents: -1,
            }),
          ],
        }),
        expect.objectContaining({
          merchant: "RECEITA QA 480",
          amountCents: -20_000,
          date: "2026-08-10",
          isCredit: true,
          crossProjectMatches: [
            expect.objectContaining({
              kind: "receipt",
              receiptId: IDS.allowedReceipt,
              projectId: IDS.allowed,
              projectName: "Projeto bancário permitido",
              valorCents: 20_001,
              deltaCents: -1,
            }),
          ],
        }),
        expect.objectContaining({
          merchant: "PAGTO CART CRED",
          amountCents: 30_000,
          date: "2026-08-10",
          isCardPayment: true,
          suggestedCardLast4: "9001",
          cardCandidates: [
            {
              cardLast4: "9001",
              nickname: "Cartão bancário permitido",
              dueMonth: "2026-08",
              invoiceTotalCents: 30_000,
              deltaCents: 0,
            },
          ],
        }),
      ],
    });
    const serialized = JSON.stringify(hiddenPresent);
    for (const sentinel of HIDDEN_SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("enforces USER project, type and module grants while OWNER and ADMIN retain same-tenant candidates", async () => {
    const projectScoped = await preview(projectRestrictedRequester);
    const typeScoped = await preview(typeRestrictedRequester);
    const moduleScoped = await preview(moduleRestrictedRequester);
    const owner = await preview(ownerRequester);
    const admin = await preview(adminRequester);

    expect(JSON.stringify(projectScoped)).not.toContain(IDS.hiddenExpense);
    expect(JSON.stringify(typeScoped)).not.toContain(IDS.typeExpense);
    expect(JSON.stringify(typeScoped)).not.toContain(IDS.typeReceipt);
    expect(
      moduleScoped.preview.flatMap((row: any) => row.crossProjectMatches),
    ).toEqual([]);
    expect(JSON.stringify(owner)).toContain(IDS.hiddenExpense);
    expect(JSON.stringify(owner)).toContain(IDS.hiddenReceipt);
    expect(JSON.stringify(owner)).toContain("9002");
    expect(admin).toEqual(owner);
    expect(JSON.stringify(owner)).not.toContain(IDS.crossExpense);
    expect(JSON.stringify(owner)).not.toContain(IDS.deletedExpense);
  });

  it("keeps expense and receipt suggestion endpoint limits and ordering independent of a hidden competitor", async () => {
    await createExpense({
      id: IDS.importedExpense,
      projectId: IDS.source,
      title: "Despesa importada para sugestão",
      amount: 10_000,
      status: "PAGO",
      bankLast4: "4801",
    });
    await createReceipt({
      id: IDS.importedReceipt,
      projectId: IDS.source,
      description: "Receita importada para sugestão",
      amount: 20_000,
      status: "EM_CAIXA",
      bankLast4: "4801",
    });
    for (let index = 2; index <= 5; index += 1) {
      await createExpense({
        id: `qa480-bank-expense-allowed-${index}`,
        projectId: IDS.allowed,
        title: `Despesa permitida ${index}`,
        amount: 10_000 + index,
      });
      await createReceipt({
        id: `qa480-bank-receipt-allowed-${index}`,
        projectId: IDS.allowed,
        description: `Receita permitida ${index}`,
        amount: 20_000 + index,
        date: new Date(
          TRANSACTION_DATE.getTime() - index * 24 * 60 * 60 * 1000,
        ),
      });
    }

    const expensesWithHidden = await suggestExpenses(
      projectRestrictedRequester,
    );
    const receiptsWithHidden = await suggestReceipts(
      projectRestrictedRequester,
    );
    await setHiddenActive(false);
    const expensesWithoutHidden = await suggestExpenses(
      projectRestrictedRequester,
    );
    const receiptsWithoutHidden = await suggestReceipts(
      projectRestrictedRequester,
    );

    expect(expensesWithHidden).toEqual(expensesWithoutHidden);
    expect(receiptsWithHidden).toEqual(receiptsWithoutHidden);
    expect(expensesWithHidden).toEqual([
      {
        expense: expect.objectContaining({
          id: IDS.importedExpense,
          valorTotal: 10_000,
          bankLast4: "4801",
        }),
        suggestions: expect.arrayContaining([
          expect.objectContaining({
            expenseId: IDS.allowedExpense,
            projectId: IDS.allowed,
            deltaCents: -1,
          }),
        ]),
      },
    ]);
    expect(expensesWithHidden[0].suggestions).toHaveLength(5);
    expect(receiptsWithHidden).toEqual([
      {
        receipt: expect.objectContaining({
          id: IDS.importedReceipt,
          valor: 20_000,
          bankLast4: "4801",
        }),
        suggestions: expect.arrayContaining([
          expect.objectContaining({
            receiptId: IDS.allowedReceipt,
            projectId: IDS.allowed,
            deltaCents: -1,
          }),
        ]),
      },
    ]);
    expect(receiptsWithHidden[0].suggestions).toHaveLength(5);
    const serialized = JSON.stringify({
      expensesWithHidden,
      receiptsWithHidden,
    });
    for (const sentinel of HIDDEN_SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("returns uniform 404 and exact zero writes for crafted hidden and missing Expense/Receipt commits", async () => {
    const parsed = await preview(ownerRequester);
    const debit = parsed.preview.find(
      (row: any) => row.merchant === "MATERIAL QA 480",
    );
    const credit = parsed.preview.find(
      (row: any) => row.merchant === "RECEITA QA 480",
    );
    if (!debit || !credit) {
      throw new Error(
        "fixture OFX deve produzir débito e crédito determinísticos",
      );
    }
    expect(debit?.externalId).toEqual(expect.any(String));
    expect(credit?.externalId).toEqual(expect.any(String));
    const before = await financialState();

    const commit = (
      decision: Record<string, unknown>,
      requester = projectRestrictedRequester,
    ) =>
      controller.importStatement(
        IDS.tenant,
        requester,
        IDS.source,
        IDS.account,
        [uploadFile(bankOfx())],
        { mode: "commit", source: "OFX", periodLabel: "2026-08" },
        { decisions: JSON.stringify([decision]) },
      );

    const hiddenExpenseError = await captureError(() =>
      commit({
        externalId: debit.externalId,
        action: "link",
        linkToExpenseId: IDS.hiddenExpense,
      }),
    );
    expect(await financialState()).toEqual(before);
    const missingExpenseError = await captureError(() =>
      commit({
        externalId: debit.externalId,
        action: "link",
        linkToExpenseId: "qa480-bank-expense-absent",
      }),
    );
    expect(await financialState()).toEqual(before);
    const hiddenReceiptError = await captureError(() =>
      commit({
        externalId: credit.externalId,
        action: "link",
        linkToReceiptId: IDS.hiddenReceipt,
      }),
    );
    expect(await financialState()).toEqual(before);
    const missingReceiptError = await captureError(() =>
      commit({
        externalId: credit.externalId,
        action: "link",
        linkToReceiptId: "qa480-bank-receipt-absent",
      }),
    );
    expect(await financialState()).toEqual(before);

    expect(errorContract(hiddenExpenseError)).toEqual(
      errorContract(missingExpenseError),
    );
    expect(errorContract(hiddenExpenseError)).toEqual({
      name: "NotFoundException",
      status: 404,
      message: "Despesa alvo não encontrada",
      body: {
        message: "Despesa alvo não encontrada",
        error: "Not Found",
        statusCode: 404,
      },
    });
    expect(errorContract(hiddenReceiptError)).toEqual(
      errorContract(missingReceiptError),
    );
    expect(errorContract(hiddenReceiptError)).toEqual({
      name: "NotFoundException",
      status: 404,
      message: "Recebimento alvo não encontrado",
      body: {
        message: "Recebimento alvo não encontrado",
        error: "Not Found",
        statusCode: 404,
      },
    });
    expect((await financialState()).imports).toEqual([]);
  });

  it("makes same-project-type Expense and Receipt candidates hidden when only an unrelated module is granted", async () => {
    const beforePresent = await financialState();
    const sentinelsPresent = await preview(unrelatedModuleRequester);
    const afterPresent = await financialState();

    await setExpenseActive(IDS.allowedExpense, false);
    await setReceiptActive(IDS.allowedReceipt, false);
    const beforeAbsent = await financialState();
    const sentinelsAbsent = await preview(unrelatedModuleRequester);
    const afterAbsent = await financialState();

    expect(sentinelsPresent).toEqual(sentinelsAbsent);
    // Preview é read-only nos dois estados (o único delta é o soft-delete que
    // o próprio teste aplicou entre as duas leituras).
    expect(afterPresent).toEqual(beforePresent);
    expect(afterAbsent).toEqual(beforeAbsent);
    expect(candidateRefs(sentinelsPresent)).toEqual([]);
    expect(
      sentinelsPresent.preview.map((row: any) => ({
        merchant: row.merchant,
        crossProjectMatches: row.crossProjectMatches,
      })),
    ).toEqual([
      { merchant: "MATERIAL QA 480", crossProjectMatches: [] },
      { merchant: "RECEITA QA 480", crossProjectMatches: [] },
      { merchant: "PAGTO CART CRED", crossProjectMatches: [] },
    ]);
    // `creditCards` continua valendo — o corte é por recurso, não por projeto.
    expect(
      sentinelsPresent.preview.find(
        (row: any) => row.merchant === "PAGTO CART CRED",
      )?.cardCandidates,
    ).toEqual([
      {
        cardLast4: "9001",
        nickname: "Cartão bancário permitido",
        dueMonth: "2026-08",
        invoiceTotalCents: 30_000,
        deltaCents: 0,
      },
    ]);
    const serialized = JSON.stringify(sentinelsPresent);
    for (const sentinel of [
      ...HIDDEN_SENTINELS,
      IDS.allowedExpense,
      IDS.allowedReceipt,
      "Despesa bancária permitida",
      "Receita bancária permitida",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("scopes Expense and Receipt candidates independently", async () => {
    const cases: Array<{
      label: string;
      modules: string[];
      expected: Array<{ kind: string; id: string }>;
    }> = [
      {
        label: "expenses only",
        modules: ["bankAccounts", "expenses"],
        expected: [{ kind: "expense", id: IDS.allowedExpense }],
      },
      {
        label: "receipts only",
        modules: ["bankAccounts", "receipts"],
        expected: [{ kind: "receipt", id: IDS.allowedReceipt }],
      },
      {
        label: "expenses + receipts",
        modules: ["bankAccounts", "expenses", "receipts"],
        expected: [
          { kind: "expense", id: IDS.allowedExpense },
          { kind: "receipt", id: IDS.allowedReceipt },
        ],
      },
      {
        label: "neither",
        modules: ["bankAccounts", "pendencias"],
        expected: [],
      },
    ];

    for (const scenario of cases) {
      const payload = await preview({
        id: `qa480-bank-user-${scenario.label.replace(/\W+/g, "-")}`,
        role: "USER",
        allowedProjects: [IDS.source, IDS.allowed],
        allowedProjectTypes: ["PESSOAL", "REFORMA"],
        allowedModules: scenario.modules,
      });
      expect({ label: scenario.label, refs: candidateRefs(payload) }).toEqual({
        label: scenario.label,
        refs: scenario.expected,
      });
    }
  });

  it("does not expose card or invoice candidates to a same-type requester without the creditCards module", async () => {
    const before = await financialState();
    const cardPresent = await preview(noCardModuleRequester);
    const afterPresent = await financialState();

    await setCardActive(IDS.allowedCard, false);
    const beforeAbsent = await financialState();
    const cardAbsent = await preview(noCardModuleRequester);
    const afterAbsent = await financialState();

    expect(cardPresent).toEqual(cardAbsent);
    expect(afterPresent).toEqual(before);
    expect(afterAbsent).toEqual(beforeAbsent);
    expect(
      cardPresent.preview.map((row: any) => ({
        merchant: row.merchant,
        cardCandidates: row.cardCandidates,
        suggestedCardLast4: row.suggestedCardLast4,
        crossProjectMatches: row.crossProjectMatches,
      })),
    ).toEqual([
      {
        merchant: "MATERIAL QA 480",
        cardCandidates: [],
        suggestedCardLast4: null,
        crossProjectMatches: [],
      },
      {
        merchant: "RECEITA QA 480",
        cardCandidates: [],
        suggestedCardLast4: null,
        crossProjectMatches: [],
      },
      {
        merchant: "PAGTO CART CRED",
        cardCandidates: [],
        suggestedCardLast4: null,
        crossProjectMatches: [],
      },
    ]);
    const serialized = JSON.stringify(cardPresent);
    for (const sentinel of [
      ...HIDDEN_SENTINELS,
      IDS.allowedCard,
      "9001",
      "Cartão bancário permitido",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("applies resource modules before the five-item take in both suggestion endpoints", async () => {
    await createExpense({
      id: IDS.importedExpense,
      projectId: IDS.source,
      title: "Despesa importada para sugestão",
      amount: 10_000,
      status: "PAGO",
      bankLast4: "4801",
    });
    await createReceipt({
      id: IDS.importedReceipt,
      projectId: IDS.source,
      description: "Receita importada para sugestão",
      amount: 20_000,
      status: "EM_CAIXA",
      bankLast4: "4801",
    });
    for (let index = 2; index <= 5; index += 1) {
      await createExpense({
        id: `qa480-bank-expense-allowed-${index}`,
        projectId: IDS.allowed,
        title: `Despesa permitida ${index}`,
        amount: 10_000 + index,
      });
      await createReceipt({
        id: `qa480-bank-receipt-allowed-${index}`,
        projectId: IDS.allowed,
        description: `Receita permitida ${index}`,
        amount: 20_000 + index,
        date: new Date(
          TRANSACTION_DATE.getTime() - index * 24 * 60 * 60 * 1000,
        ),
      });
    }
    // Competidores MELHOR ranqueados, ocultos SÓ pelo módulo do recurso:
    // PLANTAS não tem `expenses`, CASA não tem `receipts`.
    await createExpense({
      id: IDS.moduleHiddenExpense,
      projectId: IDS.moduleHiddenProject,
      title: "Despesa bancária módulo oculto SENTINELA",
      amount: 10_000,
    });
    await createReceipt({
      id: IDS.moduleHiddenReceipt,
      projectId: IDS.typeHidden,
      description: "Receita bancária módulo oculto SENTINELA",
      amount: 20_000,
      date: new Date(TRANSACTION_DATE.getTime() + 24 * 60 * 60 * 1000),
    });

    const expensesWithHidden = await suggestExpenses(expenseRankRequester);
    const receiptsWithHidden = await suggestReceipts(receiptRankRequester);
    await setExpenseActive(IDS.moduleHiddenExpense, false);
    await setReceiptActive(IDS.moduleHiddenReceipt, false);
    await setReceiptActive(IDS.typeReceipt, false);
    const expensesWithoutHidden = await suggestExpenses(expenseRankRequester);
    const receiptsWithoutHidden = await suggestReceipts(receiptRankRequester);

    expect(expensesWithHidden).toEqual(expensesWithoutHidden);
    expect(receiptsWithHidden).toEqual(receiptsWithoutHidden);
    expect(
      expensesWithHidden[0].suggestions.map((s: any) => s.expenseId),
    ).toEqual([
      IDS.allowedExpense,
      "qa480-bank-expense-allowed-2",
      "qa480-bank-expense-allowed-3",
      "qa480-bank-expense-allowed-4",
      "qa480-bank-expense-allowed-5",
    ]);
    expect(
      receiptsWithHidden[0].suggestions.map((s: any) => s.receiptId),
    ).toEqual([
      IDS.allowedReceipt,
      "qa480-bank-receipt-allowed-2",
      "qa480-bank-receipt-allowed-3",
      "qa480-bank-receipt-allowed-4",
      "qa480-bank-receipt-allowed-5",
    ]);
    const serialized = JSON.stringify({
      expensesWithHidden,
      receiptsWithHidden,
    });
    for (const sentinel of [
      ...HIDDEN_SENTINELS,
      IDS.moduleHiddenExpense,
      IDS.moduleHiddenReceipt,
      IDS.typeExpense,
      IDS.typeReceipt,
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});
