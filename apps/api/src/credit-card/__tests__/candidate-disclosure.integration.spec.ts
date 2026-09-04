// The test DB guard must load before PrismaService imports PrismaClient.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import type { RateioRequester } from "../../expense/rateio.types";
import { MerchantClassifierService } from "../../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../../prisma/prisma.service";
import { CreditCardController } from "../credit-card.controller";
import { CreditCardService } from "../credit-card.service";
import * as cardParsers from "../parsers";

const CLOCK = new Date("2026-08-19T15:00:00.000Z");
const CURRENT_DATE = new Date("2026-08-10T12:00:00.000Z");
const FUTURE_DATE = new Date("2026-09-10T12:00:00.000Z");

const IDS = {
  tenant: "qa480-card-tenant-a",
  otherTenant: "qa480-card-tenant-b",
  source: "qa480-card-pessoal",
  allowed: "qa480-card-allowed",
  hidden: "qa480-card-hidden",
  typeHidden: "qa480-card-type-hidden",
  deletedProject: "qa480-card-deleted-project",
  crossProject: "qa480-card-cross-project",
  card: "qa480-card-source-card",
  allowedExpense: "qa480-card-expense-allowed",
  hiddenExpense: "qa480-card-expense-hidden-sentinel",
  allowedFutureExpense: "qa480-card-expense-future-allowed",
  hiddenFutureExpense: "qa480-card-expense-future-hidden-sentinel",
  typeExpense: "qa480-card-expense-type-sentinel",
  deletedExpense: "qa480-card-expense-deleted-sentinel",
  crossExpense: "qa480-card-expense-cross-sentinel",
  importedExpense: "qa480-card-imported-expense",
  // #480 SEC-1: PLANTAS não tem o módulo `expenses`; só é alcançável por um
  // módulo não relacionado (`plantsAi`).
  moduleHiddenProject: "qa480-card-module-hidden-project",
  moduleHiddenExpense: "qa480-card-expense-module-sentinel",
} as const;

const HIDDEN_SENTINELS = [
  IDS.hidden,
  IDS.hiddenExpense,
  IDS.hiddenFutureExpense,
  "Projeto cartão oculto SENTINELA",
  "Despesa cartão oculta SENTINELA",
] as const;

const projectRestrictedRequester: RateioRequester & { id: string } = {
  id: "qa480-card-user-project",
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed],
  allowedProjectTypes: ["PESSOAL", "REFORMA", "CASA"],
  allowedModules: ["creditCards", "expenses"],
};

const typeRestrictedRequester: RateioRequester & { id: string } = {
  id: "qa480-card-user-type",
  role: "USER",
  allowedProjects: [],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["creditCards", "expenses"],
};

const moduleRestrictedRequester: RateioRequester & { id: string } = {
  id: "qa480-card-user-module",
  role: "USER",
  allowedProjects: [],
  allowedProjectTypes: ["PESSOAL", "CASA"],
  allowedModules: ["creditCards"],
};

const ownerRequester: RateioRequester & { id: string } = {
  id: "qa480-card-owner",
  role: "OWNER",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

/**
 * #480 SEC-1 — alcança o projeto REFORMA pelo módulo do CARTÃO. Sem `expenses`
 * não pode ver nenhum candidato Expense desse mesmo projeto.
 */
const cardOnlyRequester: RateioRequester & { id: string } = {
  id: "qa480-card-user-card-only",
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["creditCards"],
};

/** Alcança PLANTAS por `plantsAi` — tipo que NÃO tem o módulo `expenses`. */
const rankRequester: RateioRequester & { id: string } = {
  id: "qa480-card-user-rank",
  role: "USER",
  allowedProjects: [IDS.source, IDS.allowed, IDS.moduleHiddenProject],
  allowedProjectTypes: ["PESSOAL", "REFORMA", "PLANTAS"],
  allowedModules: ["creditCards", "expenses", "plantsAi"],
};

const adminRequester: RateioRequester & { id: string } = {
  ...ownerRequester,
  id: "qa480-card-admin",
  role: "ADMIN",
};

function csvStatement(): Buffer {
  return Buffer.from(
    ["date,title,amount", "2026-08-10,COMPRA QA 480,100.00"].join("\n"),
  );
}

function uploadFile(buffer: Buffer): Express.Multer.File {
  return {
    fieldname: "files",
    originalname: "qa480-fatura.csv",
    encoding: "7bit",
    mimetype: "text/csv",
    size: buffer.length,
    destination: "",
    filename: "qa480-fatura.csv",
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

describe("credit-card candidate disclosure integration (#480)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const service = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  const controller = new CreditCardController(service);

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
    await setup.creditCardStatementImport.deleteMany({
      where: { tenantId: { in: [IDS.tenant, IDS.otherTenant] } },
    });
    await setup.bankStatementImport.deleteMany({
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
    amount?: number;
    date?: Date;
    status?: string;
    deletedAt?: Date | null;
    cardLast4?: string | null;
  }) {
    const date = input.date ?? CURRENT_DATE;
    const amount = input.amount ?? 10_000;
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
        cardLast4: input.cardLast4,
        createdAt: date,
        updatedAt: date,
        deletedAt: input.deletedAt,
      },
    });
  }

  async function seedCandidates() {
    await Promise.all([
      createExpense({
        id: IDS.allowedExpense,
        projectId: IDS.allowed,
        title: "Despesa cartão permitida",
        amount: 10_001,
      }),
      createExpense({
        id: IDS.hiddenExpense,
        projectId: IDS.hidden,
        title: "Despesa cartão oculta SENTINELA",
      }),
      createExpense({
        id: IDS.allowedFutureExpense,
        projectId: IDS.allowed,
        title: "Despesa cartão futura permitida",
        amount: 10_002,
        date: FUTURE_DATE,
      }),
      createExpense({
        id: IDS.hiddenFutureExpense,
        projectId: IDS.hidden,
        title: "Despesa cartão futura oculta SENTINELA",
        date: FUTURE_DATE,
      }),
      createExpense({
        id: IDS.typeExpense,
        projectId: IDS.typeHidden,
        title: "Despesa cartão tipo oculto SENTINELA",
      }),
      createExpense({
        id: IDS.deletedExpense,
        projectId: IDS.deletedProject,
        title: "Despesa cartão deletada SENTINELA",
        deletedAt: CLOCK,
      }),
      createExpense({
        id: IDS.crossExpense,
        tenantId: IDS.otherTenant,
        projectId: IDS.crossProject,
        title: "Despesa cartão cross-tenant SENTINELA",
      }),
    ]);
  }

  async function setHiddenActive(active: boolean) {
    await setup.project.update({
      where: { id: IDS.hidden },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  /** Liga/desliga um candidato individual (presente × ausente). */
  async function setExpenseActive(id: string, active: boolean) {
    await setup.expense.update({
      where: { id },
      data: { deletedAt: active ? null : CLOCK },
    });
  }

  async function preview(
    requester: RateioRequester & { id: string },
    content = csvStatement(),
  ) {
    return (await controller.importStatement(
      IDS.tenant,
      requester,
      IDS.source,
      IDS.card,
      [uploadFile(content)],
      { mode: "preview", source: "CSV_GENERIC" },
      undefined,
    )) as Awaited<ReturnType<CreditCardService["previewImport"]>>;
  }

  async function suggest(requester: RateioRequester & { id: string }) {
    return (controller as any).suggestLinks(
      IDS.tenant,
      IDS.source,
      IDS.card,
      requester,
    );
  }

  async function financialState() {
    const where = { tenantId: IDS.tenant };
    const [
      imports,
      bankImports,
      expenses,
      receipts,
      cash,
      settlements,
      rateios,
    ] = await Promise.all([
      setup.creditCardStatementImport.findMany({
        where,
        select: { id: true, inserted: true, duplicated: true, skipped: true },
        orderBy: { id: "asc" },
      }),
      setup.bankStatementImport.findMany({
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
      bankImports,
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
        { id: IDS.tenant, name: "QA 480 card tenant A" },
        { id: IDS.otherTenant, name: "QA 480 card tenant B" },
      ],
    });
    await setup.project.createMany({
      data: [
        {
          id: IDS.source,
          tenantId: IDS.tenant,
          type: "PESSOAL",
          name: "Pessoal cartão",
        },
        {
          id: IDS.allowed,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto cartão permitido",
        },
        {
          id: IDS.hidden,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto cartão oculto SENTINELA",
        },
        {
          id: IDS.typeHidden,
          tenantId: IDS.tenant,
          type: "CASA",
          name: "Projeto cartão tipo oculto SENTINELA",
        },
        {
          id: IDS.deletedProject,
          tenantId: IDS.tenant,
          type: "REFORMA",
          name: "Projeto cartão deletado SENTINELA",
        },
        {
          id: IDS.crossProject,
          tenantId: IDS.otherTenant,
          type: "REFORMA",
          name: "Projeto cartão cross-tenant SENTINELA",
        },
        {
          id: IDS.moduleHiddenProject,
          tenantId: IDS.tenant,
          type: "PLANTAS",
          name: "Projeto cartão módulo oculto SENTINELA",
        },
      ],
    });
    await setup.creditCard.create({
      data: {
        id: IDS.card,
        tenantId: IDS.tenant,
        projectId: IDS.source,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão fonte QA 480",
        last4: "4802",
        closingDay: 5,
        dueDay: 10,
      },
    });
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanupTransient();
    await setHiddenActive(true);
    await seedCandidates();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  it("makes current hidden, absent, cross-tenant and deleted candidates deep-equal before rank, limit and totals", async () => {
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
      source: "CSV_GENERIC",
      periodLabel: "2026-08",
      totalAmountCents: 10_000,
      total: 1,
      duplicated: 0,
      inserted: 0,
      possibleDuplicates: [],
      classificationStatus: 'unavailable',
      preview: [
        expect.objectContaining({
          merchant: "COMPRA QA 480",
          amountCents: 10_000,
          date: "2026-08-10",
          duplicate: false,
          crossProjectMatches: [
            expect.objectContaining({
              expenseId: IDS.allowedExpense,
              projectId: IDS.allowed,
              projectName: "Projeto cartão permitido",
              titulo: "Despesa cartão permitida",
              valorCents: 10_001,
              deltaCents: -1,
            }),
          ],
        }),
      ],
      futureInstallments: [],
    });
    const serialized = JSON.stringify(hiddenPresent);
    for (const sentinel of HIDDEN_SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("applies the identical scope to current and future preview rows", async () => {
    jest.spyOn(cardParsers, "parseStatementBuffers").mockResolvedValue({
      source: "PDF",
      periodLabel: "2026-08",
      totalAmountCents: 10_000,
      transactions: [
        {
          externalId: "qa480-card-current-fixed",
          date: CURRENT_DATE,
          merchant: "COMPRA ATUAL QA 480",
          amountCents: 10_000,
          installmentCurrent: 1,
          installmentTotal: 2,
        },
      ],
      futureInstallments: [
        {
          externalId: "qa480-card-future-fixed",
          date: FUTURE_DATE,
          merchant: "COMPRA FUTURA QA 480",
          amountCents: 10_000,
          installmentCurrent: 2,
          installmentTotal: 2,
          isFuture: true,
        },
      ],
    });

    const hiddenPresent = await preview(
      projectRestrictedRequester,
      Buffer.from("synthetic parser boundary"),
    );
    await setHiddenActive(false);
    const hiddenAbsent = await preview(
      projectRestrictedRequester,
      Buffer.from("synthetic parser boundary"),
    );

    expect(hiddenPresent).toEqual(hiddenAbsent);
    expect(hiddenPresent.preview[0].crossProjectMatches).toEqual([
      expect.objectContaining({
        expenseId: IDS.allowedExpense,
        projectId: IDS.allowed,
        valorCents: 10_001,
      }),
    ]);
    expect(hiddenPresent.futureInstallments).toEqual([
      expect.objectContaining({
        externalId: "qa480-card-future-fixed",
        date: "2026-09-10",
        installmentCurrent: 2,
        installmentTotal: 2,
        isFuture: true,
        crossProjectMatches: [
          expect.objectContaining({
            expenseId: IDS.allowedFutureExpense,
            projectId: IDS.allowed,
            valorCents: 10_002,
          }),
        ],
      }),
    ]);
    for (const sentinel of HIDDEN_SENTINELS) {
      expect(JSON.stringify(hiddenPresent)).not.toContain(sentinel);
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
    expect(moduleScoped.preview[0].crossProjectMatches).toEqual([]);
    expect(JSON.stringify(owner)).toContain(IDS.hiddenExpense);
    expect(JSON.stringify(owner)).toContain(IDS.typeExpense);
    expect(admin).toEqual(owner);
    expect(JSON.stringify(owner)).not.toContain(IDS.crossExpense);
    expect(JSON.stringify(owner)).not.toContain(IDS.deletedExpense);
  });

  it("keeps suggest-links rank and five-item limit independent of a hidden competitor", async () => {
    await createExpense({
      id: IDS.importedExpense,
      projectId: IDS.source,
      title: "Compra importada para sugestão",
      amount: 10_000,
      status: "PAGO",
      cardLast4: "4802",
    });
    for (let index = 2; index <= 5; index += 1) {
      await createExpense({
        id: `qa480-card-expense-allowed-${index}`,
        projectId: IDS.allowed,
        title: `Despesa cartão permitida ${index}`,
        amount: 10_000 + index,
      });
    }

    const withHidden = await suggest(projectRestrictedRequester);
    await setHiddenActive(false);
    const withoutHidden = await suggest(projectRestrictedRequester);

    expect(withHidden).toEqual(withoutHidden);
    expect(withHidden).toEqual([
      {
        expense: expect.objectContaining({
          id: IDS.importedExpense,
          valorTotal: 10_000,
          cardLast4: "4802",
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
    expect(withHidden[0].suggestions).toHaveLength(5);
    for (const sentinel of HIDDEN_SENTINELS) {
      expect(JSON.stringify(withHidden)).not.toContain(sentinel);
    }
  });

  it("returns uniform 404 and exact zero writes for crafted hidden and missing commits", async () => {
    const parsed = await preview(ownerRequester);
    const externalId = parsed.preview[0].externalId;
    expect(externalId).toEqual(expect.any(String));
    const before = await financialState();

    const commit = (targetExpenseId: string) =>
      controller.importStatement(
        IDS.tenant,
        projectRestrictedRequester,
        IDS.source,
        IDS.card,
        [uploadFile(csvStatement())],
        {
          mode: "commit",
          source: "CSV_GENERIC",
          periodLabel: "2026-08",
        },
        {
          decisions: JSON.stringify([
            {
              externalId,
              action: "link",
              linkToExpenseId: targetExpenseId,
            },
          ]),
        },
      );

    const hiddenError = await captureError(() => commit(IDS.hiddenExpense));
    expect(await financialState()).toEqual(before);
    const missingError = await captureError(() =>
      commit("qa480-card-expense-absent"),
    );
    expect(await financialState()).toEqual(before);

    expect(errorContract(hiddenError)).toEqual(errorContract(missingError));
    expect(errorContract(hiddenError)).toEqual({
      name: "NotFoundException",
      status: 404,
      message: "Despesa alvo não encontrada",
      body: {
        message: "Despesa alvo não encontrada",
        error: "Not Found",
        statusCode: 404,
      },
    });
    expect((await financialState()).imports).toEqual([]);
  });

  it("does not treat creditCards permission as expenses permission in the same REFORMA project", async () => {
    const beforePresent = await financialState();
    const candidatePresent = await preview(cardOnlyRequester);
    const afterPresent = await financialState();

    await setExpenseActive(IDS.allowedExpense, false);
    await setExpenseActive(IDS.allowedFutureExpense, false);
    const beforeAbsent = await financialState();
    const candidateAbsent = await preview(cardOnlyRequester);
    const afterAbsent = await financialState();

    expect(candidatePresent).toEqual(candidateAbsent);
    expect(candidatePresent.preview[0].crossProjectMatches).toEqual([]);
    expect(afterPresent).toEqual(beforePresent);
    expect(afterAbsent).toEqual(beforeAbsent);
    const serialized = JSON.stringify(candidatePresent);
    for (const sentinel of [
      ...HIDDEN_SENTINELS,
      IDS.allowedExpense,
      IDS.allowedFutureExpense,
      "Despesa cartão permitida",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("filters same-type unrelated-module Expense before suggestion ranking and take", async () => {
    await createExpense({
      id: IDS.importedExpense,
      projectId: IDS.source,
      title: "Compra importada para sugestão",
      amount: 10_000,
      status: "PAGO",
      cardLast4: "4802",
    });
    for (let index = 2; index <= 5; index += 1) {
      await createExpense({
        id: `qa480-card-expense-allowed-${index}`,
        projectId: IDS.allowed,
        title: `Despesa cartão permitida ${index}`,
        amount: 10_000 + index,
      });
    }
    // Competidor MELHOR ranqueado (delta 0) oculto SÓ pelo módulo do recurso.
    await createExpense({
      id: IDS.moduleHiddenExpense,
      projectId: IDS.moduleHiddenProject,
      title: "Despesa cartão módulo oculta SENTINELA",
      amount: 10_000,
    });

    const withHidden = await suggest(rankRequester);
    await setExpenseActive(IDS.moduleHiddenExpense, false);
    const withoutHidden = await suggest(rankRequester);

    expect(withHidden).toEqual(withoutHidden);
    expect(withHidden[0].suggestions.map((s: any) => s.expenseId)).toEqual([
      IDS.allowedExpense,
      "qa480-card-expense-allowed-2",
      "qa480-card-expense-allowed-3",
      "qa480-card-expense-allowed-4",
      "qa480-card-expense-allowed-5",
    ]);
    for (const sentinel of [...HIDDEN_SENTINELS, IDS.moduleHiddenExpense]) {
      expect(JSON.stringify(withHidden)).not.toContain(sentinel);
    }
  });
});
