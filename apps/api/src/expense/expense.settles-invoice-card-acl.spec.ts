// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "./rateio.types";
import { ExpenseService } from "./expense.service";

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "settles-card-child-acl-tenant";
const OTHER_TENANT = "settles-card-child-acl-other-tenant";
const PESSOAL = "settles-card-child-acl-pessoal";
const VISIBLE = "settles-card-child-acl-visible";
const HIDDEN = "settles-card-child-acl-hidden";
const OTHER_PROJECT = "settles-card-child-acl-other-project";
const VISIBLE_CARD = "settles-card-visible";
const HIDDEN_CARD = "settles-card-hidden";
const CROSS_CARD = "settles-card-cross";
const MISSING_CARD = "settles-card-missing";

const MANAGED: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, VISIBLE],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
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

async function cleanupExpenses(): Promise<void> {
  await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setup.expense.deleteMany({ where: { tenantId: TENANT } });
}

async function cleanupAll(): Promise<void> {
  await cleanupExpenses();
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

function createDto(cardId: string, dueMonth = "2026-09") {
  return {
    tipoDespesa: "MATERIAL_CONSTRUCAO",
    titulo: "Pagamento de fatura",
    valor: 100,
    quantidade: 1,
    formaPagamento: "A_VISTA",
    dataPagamento: "2026-09-10T12:00:00.000Z",
    status: "PAGO",
    settlesInvoiceCardId: cardId,
    settlesInvoiceDueMonth: dueMonth,
  };
}

async function snapshot() {
  const [expenses, entries] = await Promise.all([
    setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
  ]);
  return { expenses, entries };
}

describe("ExpenseService settlesInvoiceCardId — child ACL real SQLite", () => {
  let service: ExpenseService;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.createMany({
      data: [
        { id: TENANT, name: "Settles card ACL" },
        { id: OTHER_TENANT, name: "Settles card ACL other" },
      ],
    });
    await setup.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
        { id: VISIBLE, tenantId: TENANT, type: "REFORMA", name: "Visível" },
        { id: HIDDEN, tenantId: TENANT, type: "REFORMA", name: "Oculto" },
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
          id: VISIBLE_CARD,
          tenantId: TENANT,
          projectId: VISIBLE,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Visível",
          last4: "1122",
          closingDay: 3,
          dueDay: 10,
        },
        {
          id: HIDDEN_CARD,
          tenantId: TENANT,
          projectId: HIDDEN,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Oculto",
          last4: "3344",
          closingDay: 3,
          dueDay: 10,
        },
        {
          id: CROSS_CARD,
          tenantId: OTHER_TENANT,
          projectId: OTHER_PROJECT,
          institution: "ITAU",
          brand: "Visa",
          nickname: "Outro tenant",
          last4: "5566",
          closingDay: 3,
          dueDay: 10,
        },
      ],
    });
    service = new ExpenseService(prisma, new ConciliacaoService(prisma));
  });

  afterEach(cleanupExpenses);

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  it.each([
    ["hidden", HIDDEN_CARD],
    ["missing", MISSING_CARD],
    ["cross-tenant", CROSS_CARD],
  ] as const)(
    "create com cartão %s é indistinguível e não cria despesa",
    async (_label, cardId) => {
      const before = await snapshot();

      const error = await captureError(() =>
        service.create(
          TENANT,
          PESSOAL,
          createDto(cardId) as never,
          null,
          undefined,
          MANAGED,
        ),
      );
      const after = await snapshot();

      expect({ error: errorShape(error), state: after }).toEqual({
        error: {
          name: "BadRequestException",
          status: 400,
          message: "Cartão da fatura quitada não encontrado neste tenant",
        },
        state: before,
      });
    },
  );

  it("update com cartão hidden falha antes de alterar expense ou cashflow", async () => {
    const existing = await service.create(
      TENANT,
      PESSOAL,
      {
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        titulo: "Despesa original",
        valor: 100,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        dataPagamento: "2026-09-10T12:00:00.000Z",
        status: "PAGO",
      } as never,
      null,
      undefined,
      MANAGED,
    );
    const before = await snapshot();

    const error = await captureError(() =>
      service.update(
        TENANT,
        PESSOAL,
        existing.id,
        {
          settlesInvoiceCardId: HIDDEN_CARD,
          settlesInvoiceDueMonth: "2026-09",
        },
        MANAGED,
      ),
    );
    const after = await snapshot();

    expect({ error: errorShape(error), state: after }).toEqual({
      error: {
        name: "BadRequestException",
        status: 400,
        message: "Cartão da fatura quitada não encontrado neste tenant",
      },
      state: before,
    });
  });

  it("requester restrito pode criar e atualizar com cartão visível", async () => {
    const created = await service.create(
      TENANT,
      PESSOAL,
      createDto(VISIBLE_CARD) as never,
      null,
      undefined,
      MANAGED,
    );
    expect(created.settlesInvoiceKey).toBe("1122:2026-09");

    const updated = await service.update(
      TENANT,
      PESSOAL,
      created.id,
      {
        settlesInvoiceCardId: VISIBLE_CARD,
        settlesInvoiceDueMonth: "2026-10",
      },
      MANAGED,
    );
    expect(updated.settlesInvoiceKey).toBe("1122:2026-10");
  });

  it.each([
    ["OWNER", OWNER],
    ["ADMIN", ADMIN],
  ] as const)(
    "%s pode criar com cartão hidden do mesmo tenant",
    async (_role, requester) => {
      const created = await service.create(
        TENANT,
        PESSOAL,
        createDto(HIDDEN_CARD) as never,
        null,
        undefined,
        requester,
      );

      expect(created.settlesInvoiceKey).toBe("3344:2026-09");
    },
  );
});
