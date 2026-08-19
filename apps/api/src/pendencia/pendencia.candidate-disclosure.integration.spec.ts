// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "../bank-account/bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import type { RateioRequester } from "../expense/rateio.types";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { PendenciaController } from "./pendencia.controller";
import { PendenciaService } from "./pendencia.service";

const CLOCK = new Date("2026-08-19T15:00:00.000Z");
const PAYMENT_DATE = new Date("2026-08-10T12:00:00.000Z");

const IDS = {
  tenant: "qa480-pendencia-tenant-a",
  otherTenant: "qa480-pendencia-tenant-b",
  source: "qa480-pendencia-pessoal",
  allowed: "qa480-pendencia-allowed",
  hidden: "qa480-pendencia-hidden",
  deletedProject: "qa480-pendencia-deleted-project",
  crossProject: "qa480-pendencia-cross-project",
  orphanPayment: "qa480-pendencia-orphan-payment",
  allowedCard: "qa480-pendencia-card-allowed",
  hiddenCard: "qa480-pendencia-card-hidden-sentinel",
  deletedCard: "qa480-pendencia-card-deleted-sentinel",
  crossCard: "qa480-pendencia-card-cross-sentinel",
  allowedPurchase: "qa480-pendencia-purchase-allowed",
  hiddenPurchase: "qa480-pendencia-purchase-hidden-sentinel",
  deletedPurchase: "qa480-pendencia-purchase-deleted-sentinel",
  crossPurchase: "qa480-pendencia-purchase-cross-sentinel",
} as const;

const restrictedRequester: RateioRequester = {
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["pendencias", "bankAccounts", "creditCards", "expenses"],
};

/**
 * #480 SEC-1 — alcança REFORMA só por `pendencias`. O candidato de cartão é um
 * recurso do módulo `creditCards`: sem ele, nada de cartão pode vazar.
 */
const pendenciasOnlyRequester: RateioRequester = {
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["pendencias"],
};

const ownerRequester: RateioRequester = {
  role: "OWNER",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

const adminRequester: RateioRequester = {
  ...ownerRequester,
  role: "ADMIN",
};

describe("Pendencia card candidate disclosure integration (#480)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const merchantClassifier = new MerchantClassifierService(prisma);
  const bank = new BankAccountService(
    prisma,
    merchantClassifier,
    new ConciliacaoService(prisma),
    new CardInvoiceSettlementService(prisma),
  );
  const monthlyOverview = {
    getAccountView: jest
      .fn()
      .mockImplementation(
        async (
          tenantId: string,
          projectId: string,
          month: string,
          requester: RateioRequester,
        ) => {
          expect({ tenantId, projectId, month, requester }).toEqual({
            tenantId: IDS.tenant,
            projectId: IDS.source,
            month: "2026-08",
            requester: expect.any(Object),
          });
          return {
            mesSelecionado: "2026-08",
            saidas: [],
            entradas: [],
            cartoes: [],
          };
        },
      ),
  };
  const pendencia = new PendenciaService(
    prisma,
    monthlyOverview as any,
    merchantClassifier,
    bank,
  );
  const controller = new PendenciaController(pendencia);

  async function cleanupTransient() {
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
    amount: number;
    type?: string;
    status?: string;
    cardLast4?: string | null;
    deletedAt?: Date | null;
  }) {
    const tenantId = input.tenantId ?? IDS.tenant;
    await setup.expense.create({
      data: {
        id: input.id,
        tenantId,
        projectId: input.projectId,
        tipoDespesa: input.type ?? "MATERIAL_CONSTRUCAO",
        titulo: input.title,
        fornecedor: input.title,
        valor: input.amount,
        quantidade: 1,
        valorTotal: input.amount,
        formaPagamento: "A_VISTA",
        dataPagamento: PAYMENT_DATE,
        status: input.status ?? "PAGO",
        cardLast4: input.cardLast4,
        createdAt: PAYMENT_DATE,
        updatedAt: PAYMENT_DATE,
        deletedAt: input.deletedAt,
      },
    });
  }

  async function createPurchase(input: {
    id: string;
    tenantId?: string;
    projectId: string;
    cardLast4: string;
    amount: number;
    deletedAt?: Date | null;
  }) {
    const tenantId = input.tenantId ?? IDS.tenant;
    await createExpense({
      ...input,
      tenantId,
      title: `${input.id} purchase`,
    });
    await setup.cashFlowEntry.create({
      data: {
        id: `${input.id}-cash`,
        tenantId,
        projectId: input.projectId,
        expenseId: input.id,
        valor: input.amount,
        tipo: "DESPESA",
        data: PAYMENT_DATE,
        categoria: "MATERIAL_CONSTRUCAO",
        formaPagamento: "CARTAO_CREDITO",
        status: "PAGO",
        createdAt: PAYMENT_DATE,
        updatedAt: PAYMENT_DATE,
        deletedAt: input.deletedAt,
      },
    });
  }

  async function seedQueue() {
    await Promise.all([
      createExpense({
        id: IDS.orphanPayment,
        projectId: IDS.source,
        title: "Pagamento de fatura QA 480",
        amount: 30_000,
        type: "PAGAMENTO_FATURA_CARTAO",
        cardLast4: null,
      }),
      createPurchase({
        id: IDS.allowedPurchase,
        projectId: IDS.allowed,
        cardLast4: "9101",
        amount: 30_001,
      }),
      createPurchase({
        id: IDS.hiddenPurchase,
        projectId: IDS.hidden,
        cardLast4: "9102",
        amount: 30_000,
      }),
      createPurchase({
        id: IDS.deletedPurchase,
        projectId: IDS.deletedProject,
        cardLast4: "9103",
        amount: 30_000,
        deletedAt: CLOCK,
      }),
      createPurchase({
        id: IDS.crossPurchase,
        tenantId: IDS.otherTenant,
        projectId: IDS.crossProject,
        cardLast4: "9104",
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

  /** Liga/desliga o cartão autorizado (candidato presente × ausente). */
  async function setAllowedCardActive(active: boolean) {
    await setup.creditCard.update({
      where: { id: IDS.allowedCard },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  async function queue(requester: RateioRequester) {
    return controller.findFinancialQueue(
      IDS.tenant,
      IDS.source,
      "2026-08",
      requester,
    );
  }

  async function financialState() {
    const where = { tenantId: IDS.tenant };
    const [bankImports, cardImports, expenses, receipts, cash] =
      await Promise.all([
        setup.bankStatementImport.findMany({
          where,
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        setup.creditCardStatementImport.findMany({
          where,
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        setup.expense.findMany({
          where,
          select: { id: true, status: true, deletedAt: true },
          orderBy: { id: "asc" },
        }),
        setup.receipt.findMany({
          where,
          select: { id: true, status: true, deletedAt: true },
          orderBy: { id: "asc" },
        }),
        setup.cashFlowEntry.findMany({
          where,
          select: { id: true, status: true, deletedAt: true },
          orderBy: { id: "asc" },
        }),
      ]);
    return { bankImports, cardImports, expenses, receipts, cash };
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
        { id: IDS.tenant, name: "QA 480 pendencia tenant A" },
        { id: IDS.otherTenant, name: "QA 480 pendencia tenant B" },
      ],
    });
    await setup.project.createMany({
      data: [
        {
          id: IDS.source,
          tenantId: IDS.tenant,
          type: "PESSOAL",
          name: "Pessoal pendencia",
        },
        {
          id: IDS.allowed,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto pendencia permitido",
        },
        {
          id: IDS.hidden,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto pendencia oculto SENTINELA",
        },
        {
          id: IDS.deletedProject,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto pendencia deletado SENTINELA",
        },
        {
          id: IDS.crossProject,
          tenantId: IDS.otherTenant,
          type: "REFORMA",
          name: "Projeto pendencia cross-tenant SENTINELA",
        },
      ],
    });
    await setup.creditCard.createMany({
      data: [
        {
          id: IDS.allowedCard,
          tenantId: IDS.tenant,
          projectId: IDS.allowed,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Cartão pendencia permitido",
          last4: "9101",
          closingDay: null,
          dueDay: 10,
        },
        {
          id: IDS.hiddenCard,
          tenantId: IDS.tenant,
          projectId: IDS.hidden,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Cartão pendencia oculto SENTINELA",
          last4: "9102",
          closingDay: null,
          dueDay: 10,
        },
        {
          id: IDS.deletedCard,
          tenantId: IDS.tenant,
          projectId: IDS.deletedProject,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Cartão pendencia deletado SENTINELA",
          last4: "9103",
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
          nickname: "Cartão pendencia cross-tenant SENTINELA",
          last4: "9104",
          closingDay: null,
          dueDay: 10,
        },
      ],
    });
  });

  beforeEach(async () => {
    monthlyOverview.getAccountView.mockClear();
    await cleanupTransient();
    await setHiddenActive(true);
    await setAllowedCardActive(true);
    await seedQueue();
  });

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  it("makes hidden, absent, cross-tenant and deleted card candidates deep-equal before queue ranking and totals", async () => {
    const before = await financialState();
    const hiddenPresent = await queue(restrictedRequester);
    const afterHiddenRead = await financialState();
    await setHiddenActive(false);
    const hiddenAbsent = await queue(restrictedRequester);
    const afterAbsentRead = await financialState();

    expect(hiddenPresent).toEqual(hiddenAbsent);
    expect(afterHiddenRead).toEqual(before);
    expect(afterAbsentRead).toEqual(before);
    expect(hiddenPresent).toEqual({
      total: 1,
      grupos: [
        {
          tipo: "PAGAMENTO_FATURA_SEM_CARTAO",
          label: "Pagamento de fatura sem cartão",
          count: 1,
          valorTotal: 30_000,
          itens: [
            {
              id: `fatura-sem-cartao-${IDS.orphanPayment}`,
              tipo: "PAGAMENTO_FATURA_SEM_CARTAO",
              label: "Escolher cartão",
              descricao: "Pagamento de fatura QA 480",
              valor: 30_000,
              data: PAYMENT_DATE.toISOString(),
              expenseId: IDS.orphanPayment,
              cardCandidates: [
                {
                  cardLast4: "9101",
                  nickname: "Cartão pendencia permitido",
                  dueMonth: "2026-08",
                  invoiceTotalCents: 30_001,
                  deltaCents: 1,
                },
              ],
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(hiddenPresent);
    expect(serialized).not.toContain(IDS.hiddenCard);
    expect(serialized).not.toContain(IDS.hiddenPurchase);
    expect(serialized).not.toContain("9102");
    expect(serialized).not.toContain("SENTINELA");
    expect(serialized).not.toContain(IDS.crossCard);
    expect(serialized).not.toContain(IDS.deletedCard);
  });

  it("keeps OWNER and ADMIN visibility without allowing a hidden competitor to affect USER count, sum or auto-selection metadata", async () => {
    const restricted = await queue(restrictedRequester);
    const owner = await queue(ownerRequester);
    const admin = await queue(adminRequester);

    expect(restricted.total).toBe(1);
    expect(restricted.grupos[0]).toEqual(
      expect.objectContaining({ count: 1, valorTotal: 30_000 }),
    );
    expect(restricted.grupos[0].itens[0].cardCandidates).toEqual([
      expect.objectContaining({
        cardLast4: "9101",
        invoiceTotalCents: 30_001,
        deltaCents: 1,
      }),
    ]);
    expect(owner.grupos[0].itens[0].cardCandidates).toEqual([
      expect.objectContaining({
        cardLast4: "9102",
        invoiceTotalCents: 30_000,
        deltaCents: 0,
      }),
      expect.objectContaining({
        cardLast4: "9101",
        invoiceTotalCents: 30_001,
        deltaCents: 1,
      }),
    ]);
    expect(admin).toEqual(owner);
    expect(owner.total).toBe(restricted.total);
    expect(owner.grupos[0].count).toBe(restricted.grupos[0].count);
    expect(owner.grupos[0].valorTotal).toBe(restricted.grupos[0].valorTotal);
  });

  it("pendencias permission alone does not grant nested credit-card candidates", async () => {
    const beforePresent = await financialState();
    const cardPresent = await queue(pendenciasOnlyRequester);
    const afterPresent = await financialState();

    await setAllowedCardActive(false);
    const beforeAbsent = await financialState();
    const cardAbsent = await queue(pendenciasOnlyRequester);
    const afterAbsent = await financialState();

    expect(cardPresent).toEqual(cardAbsent);
    expect(afterPresent).toEqual(beforePresent);
    expect(afterAbsent).toEqual(beforeAbsent);
    // O item pai (pagamento órfão) é do módulo `pendencias` e continua visível —
    // o que some é o candidato de CARTÃO aninhado nele.
    expect(cardPresent).toEqual({
      total: 1,
      grupos: [
        {
          tipo: "PAGAMENTO_FATURA_SEM_CARTAO",
          label: "Pagamento de fatura sem cartão",
          count: 1,
          valorTotal: 30_000,
          itens: [
            {
              id: `fatura-sem-cartao-${IDS.orphanPayment}`,
              tipo: "PAGAMENTO_FATURA_SEM_CARTAO",
              label: "Escolher cartão",
              descricao: "Pagamento de fatura QA 480",
              valor: 30_000,
              data: PAYMENT_DATE.toISOString(),
              expenseId: IDS.orphanPayment,
              cardCandidates: [],
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(cardPresent);
    for (const sentinel of [
      IDS.allowedCard,
      IDS.allowedPurchase,
      IDS.hiddenCard,
      IDS.hiddenPurchase,
      "9101",
      "9102",
      "30001",
      "deltaCents",
      "invoiceTotalCents",
      "SENTINELA",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});
