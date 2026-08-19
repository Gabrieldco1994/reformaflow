// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "../expense/rateio.types";
import {
  CardInvoiceSettlementService,
  type SettleCard,
} from "./card-invoice-settlement.service";

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "settle-invoice-child-acl-tenant";
const OTHER_TENANT = "settle-invoice-child-acl-other-tenant";
const PESSOAL = "settle-invoice-child-acl-pessoal";
const ALLOWED = "settle-invoice-child-acl-allowed";
const HIDDEN = "settle-invoice-child-acl-hidden";
const REMOVED_PROJECT = "settle-invoice-child-acl-removed";
const OTHER_PROJECT = "settle-invoice-child-acl-other-project";
const PURCHASE_DATE = new Date("2026-06-15T12:00:00.000Z");
const PAYMENT_DATE = new Date("2026-07-10T12:00:00.000Z");
const DELETED_AT = new Date("2026-08-19T12:00:00.000Z");

const VISIBLE_CARD: SettleCard = {
  id: "settle-invoice-visible-card",
  last4: "4488",
  closingDay: 3,
  dueDay: 10,
};
const HIDDEN_CARD: SettleCard = {
  id: "settle-invoice-hidden-card",
  last4: "5599",
  closingDay: 3,
  dueDay: 10,
};
const CROSS_TENANT_CARD: SettleCard = {
  id: "settle-invoice-cross-card",
  last4: "6677",
  closingDay: 3,
  dueDay: 10,
};
const MISSING_CARD: SettleCard = {
  id: "settle-invoice-missing-card",
  last4: "7788",
  closingDay: 3,
  dueDay: 10,
};
const REMOVED_PROJECT_CARD: SettleCard = {
  id: "settle-invoice-removed-project-card",
  last4: "8899",
  closingDay: 3,
  dueDay: 10,
};

const MANAGED: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, ALLOWED, REMOVED_PROJECT],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  // Cartão exige o módulo do CARTÃO (#480 SEC-1); `expenses` sozinho não serve.
  allowedModules: ["expenses", "creditCards"],
};
/** Mesmos projetos/tipos, alcançados só por um módulo não relacionado. */
const EXPENSES_ONLY: RateioRequester = {
  ...MANAGED,
  allowedModules: ["expenses"],
};
const OWNER: RateioRequester = { role: "OWNER" };
const ADMIN: RateioRequester = { role: "ADMIN" };

function errorShape(error: unknown) {
  const http = error as HttpException;
  return error
    ? {
        name: (error as Error).constructor.name,
        status: http.getStatus?.(),
        message: (error as Error).message,
      }
    : null;
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

async function cleanupPurchases(): Promise<void> {
  await setup.cashFlowEntry.deleteMany({
    where: { tenantId: { in: [TENANT, OTHER_TENANT] } },
  });
  await setup.expense.deleteMany({
    where: { tenantId: { in: [TENANT, OTHER_TENANT] } },
  });
}

async function cleanupAll(): Promise<void> {
  await cleanupPurchases();
  await setup.creditCard.deleteMany({
    where: { tenantId: { in: [TENANT, OTHER_TENANT] } },
  });
  await setup.project.deleteMany({
    where: { tenantId: { in: [TENANT, OTHER_TENANT] } },
  });
  await setup.tenant.deleteMany({
    where: { id: { in: [TENANT, OTHER_TENANT] } },
  });
}

async function createPurchase(params: {
  id: string;
  projectId: string;
  cardLast4: string;
  value?: number;
}): Promise<void> {
  const value = params.value ?? 10_000;
  await setup.expense.create({
    data: {
      id: params.id,
      tenantId: TENANT,
      projectId: params.projectId,
      tipoDespesa: "MATERIAL_CONSTRUCAO",
      titulo: params.id,
      valor: value,
      quantidade: 1,
      valorTotal: value,
      formaPagamento: "A_VISTA",
      dataPagamento: PURCHASE_DATE,
      status: "PLANEJADO",
      cardLast4: params.cardLast4,
    },
  });
  await setup.cashFlowEntry.create({
    data: {
      id: `${params.id}-entry`,
      tenantId: TENANT,
      projectId: params.projectId,
      expenseId: params.id,
      valor: value,
      tipo: "DESPESA",
      data: PURCHASE_DATE,
      categoria: "MATERIAL_CONSTRUCAO",
      formaPagamento: "A_VISTA",
      status: "PLANEJADO",
    },
  });
}

async function snapshot() {
  const [expenses, entries] = await Promise.all([
    setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      select: {
        id: true,
        projectId: true,
        status: true,
        paidParcelas: true,
      },
    }),
    setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      select: { id: true, expenseId: true, status: true },
    }),
  ]);
  return { expenses, entries };
}

function settle(
  service: CardInvoiceSettlementService,
  card: SettleCard,
  requester: RateioRequester,
  amountCents = 10_000,
) {
  return service.settleInvoice({
    tenantId: TENANT,
    card,
    amountCents,
    paymentDate: PAYMENT_DATE,
    requester,
  });
}

describe("CardInvoiceSettlementService.settleInvoice — child ACL real SQLite", () => {
  let service: CardInvoiceSettlementService;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.createMany({
      data: [
        { id: TENANT, name: "Settle invoice ACL" },
        { id: OTHER_TENANT, name: "Settle invoice ACL other" },
      ],
    });
    await setup.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
        { id: ALLOWED, tenantId: TENANT, type: "REFORMA", name: "Permitido" },
        { id: HIDDEN, tenantId: TENANT, type: "REFORMA", name: "Oculto" },
        {
          id: REMOVED_PROJECT,
          tenantId: TENANT,
          type: "REFORMA",
          name: "Removido",
          deletedAt: DELETED_AT,
        },
        {
          id: OTHER_PROJECT,
          tenantId: OTHER_TENANT,
          type: "REFORMA",
          name: "Outro tenant",
        },
      ],
    });
    await setup.creditCard.createMany({
      data: [
        {
          ...VISIBLE_CARD,
          tenantId: TENANT,
          projectId: PESSOAL,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Visível",
        },
        {
          ...HIDDEN_CARD,
          tenantId: TENANT,
          projectId: HIDDEN,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Oculto",
        },
        {
          ...CROSS_TENANT_CARD,
          tenantId: OTHER_TENANT,
          projectId: OTHER_PROJECT,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Outro tenant",
        },
        {
          ...REMOVED_PROJECT_CARD,
          tenantId: TENANT,
          projectId: REMOVED_PROJECT,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Projeto removido",
        },
      ],
    });
    service = new CardInvoiceSettlementService(prisma);
  });

  afterEach(cleanupPurchases);

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  it.each([
    {
      label: "compra hidden com o mesmo last4",
      card: VISIBLE_CARD,
      prepare: () =>
        createPurchase({
          id: "hidden-only",
          projectId: HIDDEN,
          cardLast4: VISIBLE_CARD.last4,
        }),
    },
    {
      label: "cartão missing",
      card: MISSING_CARD,
      prepare: async () => undefined,
    },
    {
      label: "cartão cross-tenant",
      card: CROSS_TENANT_CARD,
      prepare: async () => undefined,
    },
  ])(
    "$label é indistinguível e produz zero writes",
    async ({ card, prepare }) => {
      await prepare();
      const before = await snapshot();

      const error = await captureError(() => settle(service, card, MANAGED));
      const after = await snapshot();

      expect({ error: errorShape(error), state: after }).toEqual({
        error: {
          name: "NotFoundException",
          status: 404,
          message: "Fatura não encontrada",
        },
        state: before,
      });
    },
  );

  it("mixed allowed+hidden faz preflight completo antes de pagar a primeira compra", async () => {
    await createPurchase({
      id: "a-allowed-first",
      projectId: ALLOWED,
      cardLast4: VISIBLE_CARD.last4,
    });
    await createPurchase({
      id: "z-hidden-second",
      projectId: HIDDEN,
      cardLast4: VISIBLE_CARD.last4,
    });
    const before = await snapshot();

    const error = await captureError(() =>
      settle(service, VISIBLE_CARD, MANAGED, 20_000),
    );
    const after = await snapshot();

    expect({ error: errorShape(error), state: after }).toEqual({
      error: {
        name: "NotFoundException",
        status: 404,
        message: "Fatura não encontrada",
      },
      state: before,
    });
  });

  it("pagamento igual ao subtotal visível não casa fatura com compra oculta", async () => {
    await createPurchase({
      id: "visible-100",
      projectId: ALLOWED,
      cardLast4: VISIBLE_CARD.last4,
    });
    await createPurchase({
      id: "hidden-100",
      projectId: HIDDEN,
      cardLast4: VISIBLE_CARD.last4,
    });
    const before = await snapshot();

    const error = await captureError(() =>
      settle(service, VISIBLE_CARD, MANAGED, 10_000),
    );
    const after = await snapshot();

    expect({ error: errorShape(error), state: after }).toEqual({
      error: {
        name: "NotFoundException",
        status: 404,
        message: "Fatura não encontrada",
      },
      state: before,
    });
  });

  it.each([
    ["USER autorizado", MANAGED],
    ["OWNER", OWNER],
  ])(
    "cartão ativo sob projeto removido rejeita %s com 404 e zero writes",
    async (_label, requester) => {
      const before = await snapshot();

      const error = await captureError(() =>
        settle(service, REMOVED_PROJECT_CARD, requester),
      );

      expect({ error: errorShape(error), state: await snapshot() }).toEqual({
        error: {
          name: "NotFoundException",
          status: 404,
          message: "Fatura não encontrada",
        },
        state: before,
      });
    },
  );

  it.each([
    ["USER autorizado", MANAGED],
    ["OWNER", OWNER],
  ])(
    "compra ativa sob projeto removido rejeita %s com 404 e zero writes",
    async (_label, requester) => {
      await createPurchase({
        id: `removed-project-purchase-${_label === "OWNER" ? "owner" : "user"}`,
        projectId: REMOVED_PROJECT,
        cardLast4: VISIBLE_CARD.last4,
      });
      const before = await snapshot();

      const error = await captureError(() =>
        settle(service, VISIBLE_CARD, requester),
      );

      expect({ error: errorShape(error), state: await snapshot() }).toEqual({
        error: {
          name: "NotFoundException",
          status: 404,
          message: "Fatura não encontrada",
        },
        state: before,
      });
    },
  );

  it.each([
    [
      "USER com cartão e compra visíveis",
      "user",
      MANAGED,
      VISIBLE_CARD,
      ALLOWED,
    ],
    ["OWNER same-tenant", "owner", OWNER, HIDDEN_CARD, HIDDEN],
    ["ADMIN same-tenant", "admin", ADMIN, HIDDEN_CARD, HIDDEN],
  ] as const)(
    "%s continua liquidando exatamente uma compra",
    async (_label, key, requester, card, projectId) => {
      await createPurchase({
        id: `control-${key}`,
        projectId,
        cardLast4: card.last4,
      });

      await expect(settle(service, card, requester)).resolves.toEqual({
        settledExpenses: 1,
        settledParcelas: 1,
      });

      const state = await snapshot();
      expect(state.expenses).toEqual([
        {
          id: `control-${key}`,
          projectId,
          status: "PAGO",
          paidParcelas: null,
        },
      ]);
      expect(state.entries).toEqual([
        {
          id: `control-${key}-entry`,
          expenseId: `control-${key}`,
          status: "PAGO",
        },
      ]);
    },
  );

  it("does not authorize a card through an unrelated same-project-type module", async () => {
    await createPurchase({
      id: "expenses-only-purchase",
      projectId: ALLOWED,
      cardLast4: VISIBLE_CARD.last4,
    });
    const before = await snapshot();

    const hiddenError = await captureError(() =>
      settle(service, VISIBLE_CARD, EXPENSES_ONLY),
    );
    const afterHidden = await snapshot();
    const missingError = await captureError(() =>
      settle(service, MISSING_CARD, EXPENSES_ONLY),
    );
    const afterMissing = await snapshot();

    expect(errorShape(hiddenError)).toEqual(errorShape(missingError));
    expect(errorShape(hiddenError)).toEqual({
      name: "NotFoundException",
      status: 404,
      message: "Fatura não encontrada",
    });
    expect(afterHidden).toEqual(before);
    expect(afterMissing).toEqual(before);
    expect(before.expenses).toEqual([
      {
        id: "expenses-only-purchase",
        projectId: ALLOWED,
        status: "PLANEJADO",
        paidParcelas: null,
      },
    ]);
    expect(before.entries).toEqual([
      {
        id: "expenses-only-purchase-entry",
        expenseId: "expenses-only-purchase",
        status: "PLANEJADO",
      },
    ]);
  });
});
