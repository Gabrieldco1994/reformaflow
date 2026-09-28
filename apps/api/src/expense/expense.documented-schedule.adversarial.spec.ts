// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { INestApplication, Provider, ValidationPipe } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import type { ExpenseScheduleV1 } from "@reformaflow/domain";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "../app.module";
import { AgentService } from "../agent/agent.service";
import type { ChatMessage, LlmProvider } from "../agent/llm/llm.types";
import { AgentToolsService } from "../agent/tools/agent-tools.service";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { FinancialScheduleResponseInterceptor } from "../common/interceptors/financial-schedule-response.interceptor";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { CreditCardModule } from "../credit-card/credit-card.module";
import { CreditCardService } from "../credit-card/credit-card.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { PrismaService } from "../prisma/prisma.service";
import { ReceiptService } from "../receipt/receipt.service";
import { TenantFinancialService } from "../tenant-financial/tenant-financial.service";
import {
  parseStoredExpenseSchedule,
  serializeFinancialScheduleResponse,
} from "./documented-schedule";
import type {
  StoredProjectionScheduleV1,
  StoredSourceScheduleV1,
} from "./documented-schedule.types";
import { ExpenseModule } from "./expense.module";
import { ExpenseService } from "./expense.service";
import {
  projectionSchedule,
  sourceSchedule,
} from "./testing/documented-schedule.fixture";

const ID = {
  tenant: "qa701-public-tenant",
  pessoal: "qa701-private-pessoal",
  obra: "qa701-visible-obra",
  hidden: "qa701-private-obra",
  source: "qa701-private-source",
  target: "qa701-visible-target",
  other: "qa701-private-target",
  card: "qa701-private-card",
  import: "qa701-private-import",
  allocation: "qa701-private-allocation",
  otherAllocation: "qa701-private-other-allocation",
};
const FULL = {
  id: "qa701-full-user",
  tenantId: ID.tenant,
  role: "USER",
  allowedProjects: [ID.pessoal, ID.obra, ID.hidden],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses", "creditCards", "receipts", "monthlyOverview"],
};
const VIEWER = {
  ...FULL,
  id: "qa701-projection-viewer",
  allowedProjects: [ID.obra],
  allowedProjectTypes: ["REFORMA"],
  allowedModules: ["expenses"],
};
const PARTIAL = {
  ...FULL,
  id: "qa701-partial-user",
  allowedProjects: [ID.pessoal, ID.obra],
};
const OWNER = { ...FULL, id: "qa701-owner-user", role: "OWNER" };
const FOREIGN = {
  ...FULL,
  id: "qa701-foreign-user",
  tenantId: "qa701-foreign-tenant",
};
const CLOCK = new Date("2026-11-05T12:00:00.000Z");
const EVIDENCE = {
  documentSha256: "b".repeat(64),
  reference: "QA confidential documentary reference",
};
const PRIVATE_ACTOR = "qa701-confidential-documentary-actor";
const REQUEST_ID = "70100000-0000-4000-8000-000000000001";
const PUBLIC_SOURCE: ExpenseScheduleV1 = {
  version: 1,
  occurrences: [
    {
      index: 0,
      parcela: "2/3",
      valor: 12345,
      data: "2026-08-31",
      invoiceDueMonth: "2026-11",
    },
    {
      index: 1,
      parcela: "3/3",
      valor: 12340,
      data: "2026-09-30",
      invoiceDueMonth: "2026-12",
    },
  ],
};
const PUBLIC_TARGET: ExpenseScheduleV1 = {
  version: 1,
  occurrences: [
    {
      index: 0,
      parcela: "1/2",
      valor: 7000,
      data: "2026-09-02",
      invoiceDueMonth: "2026-11",
    },
    {
      index: 1,
      parcela: "2/2",
      valor: 6995,
      data: "2026-10-02",
      invoiceDueMonth: "2026-12",
    },
  ],
};

function storedSource(): StoredSourceScheduleV1 {
  return {
    ...sourceSchedule(),
    tenantId: ID.tenant,
    sourceExpenseId: ID.source,
    sourceProjectId: ID.pessoal,
    cardId: ID.card,
    importId: ID.import,
    externalId: "qa701-private-external",
    recordedByUserId: PRIVATE_ACTOR,
    recordedAt: CLOCK.toISOString(),
    occurrences: PUBLIC_SOURCE.occurrences.map((item) => ({
      ...item,
      amountEvidence: {
        ...EVIDENCE,
        actorUserId: PRIVATE_ACTOR,
        recordedAt: CLOCK.toISOString(),
      },
      cycleEvidence: {
        ...EVIDENCE,
        actorUserId: PRIVATE_ACTOR,
        recordedAt: CLOCK.toISOString(),
      },
    })),
  };
}

function storedTarget(): StoredProjectionScheduleV1 {
  return {
    ...projectionSchedule(),
    tenantId: ID.tenant,
    sourceExpenseId: ID.source,
    sourceProjectId: ID.pessoal,
    cardId: ID.card,
    recordedByUserId: PRIVATE_ACTOR,
    recordedAt: CLOCK.toISOString(),
    targetExpenseId: ID.target,
    targetProjectId: ID.obra,
    via: "rateio",
    allocationId: ID.allocation,
    occurrences: PUBLIC_TARGET.occurrences.map((item) => ({
      ...item,
      sourceIndex: item.index,
    })),
  };
}

function expectNoPrivateSchedule(value: unknown) {
  const json = JSON.stringify(value);
  for (const key of [
    "documentedSchedule",
    "plannedDocumentedSchedule",
    "amountEvidence",
    "cycleEvidence",
    "documentSha256",
    "recordedByUserId",
    "sourceIndex",
    "occurrenceMap",
    "lastOperation",
  ]) {
    expect(json).not.toContain(`"${key}"`);
  }
  expect(json).not.toContain(EVIDENCE.reference);
  expect(json).not.toContain(PRIVATE_ACTOR);
}

describe("#701 independent HTTP privacy and correction contract", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  let app: INestApplication | undefined;
  let baseUrl: string;
  let expenses: ExpenseService;
  let tools: AgentToolsService;

  const expenseUrl = (project = ID.pessoal, id = ID.source) =>
    `/projects/${project}/expenses/${id}`;
  const correctionUrl = () =>
    `/projects/${ID.pessoal}/credit-cards/${ID.card}/imports/${ID.import}/expenses/${ID.source}/documented-schedule`;
  const change = (cashFlowEntryId = `${ID.source}-0`, amountCents = 12342) => ({
    cashFlowEntryId,
    amountCents,
    invoiceDueMonth: "2026-11",
    evidence: EVIDENCE,
  });

  async function request(
    method: string,
    path: string,
    body?: unknown,
    actor = FULL,
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-qa-user": actor.id },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as unknown };
  }

  function mariaProbe() {
    const delivered: ChatMessage[][] = [];
    const llm: LlmProvider = {
      id: "offline-qa",
      isConfigured: () => true,
      chat: jest.fn(async (messages) => {
        delivered.push(structuredClone(messages));
        return messages.some((message) => message.role === "tool")
          ? { content: "QA", toolCalls: [] }
          : {
              content: "",
              toolCalls: [
                {
                  id: "qa-call",
                  name: "find_expenses",
                  arguments: { projectId: ID.obra },
                },
              ],
            };
      }),
    };
    return {
      llm,
      delivered,
      run: () =>
        new AgentService(llm, tools).chat({
          ...VIEWER,
          userId: VIEWER.id,
          projectId: ID.obra,
          projectScope: [ID.obra],
          messages: [{ role: "user", content: "QA expense lookup" }],
        }),
    };
  }

  async function snapshot() {
    const args = {
      where: { tenantId: ID.tenant },
      orderBy: { id: "asc" as const },
    };
    return {
      expenses: await setup.expense.findMany(args),
      cash: await setup.cashFlowEntry.findMany(args),
      allocations: await setup.rateioAllocation.findMany(args),
      settlements: await setup.crossProjectSettlement.findMany(args),
      ledger: await setup.importedInvoiceLiquidation.findMany(args),
      receipts: await setup.receipt.findMany(args),
      adjustments: await setup.invoiceAdjustment.findMany(args),
    };
  }

  async function cleanup() {
    const tenants = [ID.tenant, FOREIGN.tenantId];
    const where = { tenantId: { in: tenants } };
    await setup.importedInvoiceLiquidation.deleteMany({ where });
    await setup.rateioAllocation.deleteMany({ where });
    await setup.crossProjectSettlement.deleteMany({ where });
    await setup.cashFlowEntry.deleteMany({ where });
    await setup.expense.deleteMany({ where });
    await setup.receipt.deleteMany({ where });
    await setup.invoiceAdjustment.deleteMany({ where });
    await setup.creditCardStatementImport.deleteMany({ where });
    await setup.creditCard.deleteMany({ where });
    await setup.project.deleteMany({ where });
    await setup.user.deleteMany({ where });
    await setup.tenant.deleteMany({ where: { id: { in: tenants } } });
  }

  async function attachRateio() {
    const source = storedSource();
    source.projections = [
      {
        kind: "rateio",
        allocationId: ID.allocation,
        targetExpenseId: ID.target,
        occurrenceMap: [
          { sourceIndex: 0, targetIndex: 0 },
          { sourceIndex: 1, targetIndex: 1 },
        ],
      },
      {
        kind: "rateio",
        allocationId: ID.otherAllocation,
        targetExpenseId: ID.other,
        occurrenceMap: [
          { sourceIndex: 0, targetIndex: 0 },
          { sourceIndex: 1, targetIndex: 1 },
        ],
      },
    ];
    await setup.expense.update({
      where: { id: ID.source },
      data: {
        documentedSchedule: JSON.stringify(source),
        linkedExpenseId: ID.target,
      },
    });
    await setup.expense.update({
      where: { id: ID.target },
      data: { documentedSchedule: JSON.stringify(storedTarget()) },
    });
    await setup.rateioAllocation.createMany({
      data: [
        {
          id: ID.allocation,
          targetExpenseId: ID.target,
          allocation: 13995,
          plannedValor: 13995,
          plannedValorTotal: 13995,
        },
        {
          id: ID.otherAllocation,
          targetExpenseId: ID.other,
          allocation: 10690,
          plannedValor: 10690,
          plannedValorTotal: 10690,
        },
      ].map((item) => ({
        ...item,
        tenantId: ID.tenant,
        sourceExpenseId: ID.source,
        plannedStatus: "PLANEJADO",
        plannedPaid: null,
        plannedQuantidade: 1,
        plannedForma: "PARCELADO",
        plannedQtdParcela: 2,
        plannedDataInicio: new Date("2026-09-02T00:00:00.000Z"),
        plannedDataPagamento: null,
        plannedInstallmentDateOverrides: null,
        plannedDocumentedSchedule: null,
      })),
    });
  }

  async function attachOne(kind: "direct" | "reverse" | "rateio") {
    const source = storedSource();
    const occurrenceMap = [
      { sourceIndex: 0, targetIndex: 0 },
      { sourceIndex: 1, targetIndex: 1 },
    ];
    source.projections = [
      kind === "rateio"
        ? {
            kind: "rateio",
            targetExpenseId: ID.target,
            allocationId: ID.allocation,
            occurrenceMap,
          }
        : { kind: "mirror", targetExpenseId: ID.target, occurrenceMap },
    ];
    const base = {
      ...storedTarget(),
      occurrences: [
        { ...PUBLIC_TARGET.occurrences[0], valor: 12345, sourceIndex: 0 },
        { ...PUBLIC_TARGET.occurrences[1], valor: 12340, sourceIndex: 1 },
      ],
    };
    const target: StoredProjectionScheduleV1 =
      kind === "rateio"
        ? { ...base, via: "rateio", allocationId: ID.allocation }
        : { ...base, via: "mirror", allocationId: null };
    await setup.expense.update({
      where: { id: ID.source },
      data: {
        documentedSchedule: JSON.stringify(source),
        linkedExpenseId: kind === "reverse" ? null : ID.target,
      },
    });
    await setup.expense.update({
      where: { id: ID.target },
      data: {
        valor: 24685,
        valorTotal: 24685,
        documentedSchedule: JSON.stringify(target),
        linkedExpenseId: kind === "reverse" ? ID.source : null,
      },
    });
    await setup.cashFlowEntry.update({
      where: { id: `${ID.target}-0` },
      data: { valor: 12345 },
    });
    await setup.cashFlowEntry.update({
      where: { id: `${ID.target}-1` },
      data: { valor: 12340 },
    });
    if (kind === "rateio") {
      await setup.rateioAllocation.create({
        data: {
          id: ID.allocation,
          tenantId: ID.tenant,
          sourceExpenseId: ID.source,
          targetExpenseId: ID.target,
          allocation: 24685,
          plannedStatus: "PLANEJADO",
          plannedPaid: null,
          plannedValor: 13995,
          plannedQuantidade: 1,
          plannedValorTotal: 13995,
          plannedForma: "PARCELADO",
          plannedQtdParcela: 2,
          plannedDataInicio: new Date("2026-09-02T00:00:00.000Z"),
          plannedDocumentedSchedule: JSON.stringify(storedTarget()),
        },
      });
    }
  }

  async function preview(changes = [change()]) {
    const response = await request("POST", correctionUrl(), {
      mode: "preview",
      changes,
    });
    expect([200, 201]).toContain(response.status);
    expect(response.body).toEqual(
      expect.objectContaining({ fingerprint: expect.any(String) }),
    );
    expectNoPrivateSchedule(response.body);
    const fingerprint: unknown = Reflect.get(
      Object(response.body),
      "fingerprint",
    );
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      throw new Error("Preview must return a nonempty fingerprint");
    }
    return fingerprint;
  }

  function apply(
    expectedFingerprint: string,
    changes = [change()],
    requestId = REQUEST_ID,
  ) {
    return request("POST", correctionUrl(), {
      mode: "apply",
      requestId,
      expectedFingerprint,
      changes,
    });
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      now: CLOCK,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    await setup.$connect();
    // Use the actual application registration, not a test-only sanitizer wiring.
    const providers: Provider[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppModule,
    );
    expect(providers).toContainEqual({
      provide: APP_INTERCEPTOR,
      useClass: FinancialScheduleResponseInterceptor,
    });
    const boundaries = providers.filter(
      (provider) =>
        typeof provider === "object" &&
        "useClass" in provider &&
        ((provider.provide === APP_INTERCEPTOR &&
          provider.useClass === FinancialScheduleResponseInterceptor) ||
          (provider.provide === APP_GUARD &&
            [RolesGuard, ModulesGuard, ProjectAccessGuard].includes(
              provider.useClass,
            ))),
    );
    const module = await Test.createTestingModule({
      imports: [ExpenseModule, CreditCardModule],
      providers: boundaries,
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    expenses = module.get(ExpenseService);
    const cards = module.get(CreditCardService);
    const monthly = new MonthlyOverviewService(
      prisma,
      module.get(CardInvoiceSettlementService),
    );
    tools = new AgentToolsService(
      prisma,
      new TenantFinancialService(prisma, monthly),
      expenses,
      new ReceiptService(prisma, module.get(MerchantClassifierService)),
      cards,
      module.get(MerchantClassifierService),
      {} as never, // Price monitoring is not called by find_expenses.
      monthly,
    );
    app = module.createNestApplication();
    app.useLogger(false);
    // Only authentication is supplied; production module/project/role guards run.
    app.use(
      (
        req: Request & { user?: typeof FULL },
        _res: Response,
        next: NextFunction,
      ) => {
        req.user = [FULL, VIEWER, PARTIAL, OWNER, FOREIGN].find(
          (actor) => actor.id === req.headers["x-qa-user"],
        );
        next();
      },
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  beforeEach(async () => {
    await cleanup();
    await setup.tenant.createMany({
      data: [
        { id: ID.tenant, name: "Synthetic schedule QA" },
        { id: FOREIGN.tenantId, name: "Synthetic foreign QA" },
      ],
    });
    await setup.project.createMany({
      data: [
        { id: ID.pessoal, type: "PESSOAL", name: "QA private personal" },
        { id: ID.obra, type: "REFORMA", name: "QA visible renovation" },
        { id: ID.hidden, type: "REFORMA", name: "QA private renovation" },
      ].map((project) => ({ ...project, tenantId: ID.tenant })),
    });
    await setup.user.createMany({
      data: [FULL, VIEWER, PARTIAL, OWNER, FOREIGN].map((actor) => ({
        id: actor.id,
        tenantId: actor.tenantId,
        username: actor.id,
        name: "Synthetic QA actor",
        role: actor.role,
        allowedProjects: JSON.stringify(actor.allowedProjects),
        allowedProjectTypes: JSON.stringify(actor.allowedProjectTypes),
        allowedModules: JSON.stringify(actor.allowedModules),
      })),
    });
    await setup.creditCard.create({
      data: {
        id: ID.card,
        tenantId: ID.tenant,
        projectId: ID.pessoal,
        institution: "OUTROS",
        nickname: "QA private card",
        last4: "0711",
        closingDay: 20,
        dueDay: 10,
      },
    });
    await setup.creditCardStatementImport.create({
      data: {
        id: ID.import,
        tenantId: ID.tenant,
        cardId: ID.card,
        periodLabel: "2026-11",
        source: "CSV_GENERIC",
        status: "COMPLETED",
        totalAmountCents: 12345,
      },
    });
    await setup.expense.createMany({
      data: [
        {
          id: ID.source,
          projectId: ID.pessoal,
          valor: 24685,
          valorTotal: 24685,
          cardLast4: "0711",
          importId: ID.import,
          externalId: "qa701-private-external",
          dataInicioParcela: new Date("2026-08-31T00:00:00.000Z"),
          documentedSchedule: JSON.stringify(storedSource()),
        },
        {
          id: ID.target,
          projectId: ID.obra,
          valor: 13995,
          valorTotal: 13995,
          dataInicioParcela: new Date("2026-09-02T00:00:00.000Z"),
        },
        {
          id: ID.other,
          projectId: ID.hidden,
          valor: 10690,
          valorTotal: 10690,
          dataInicioParcela: new Date("2026-09-02T00:00:00.000Z"),
        },
      ].map((item) => ({
        ...item,
        tenantId: ID.tenant,
        titulo: "QA schedule purchase",
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        quantidade: 1,
        quantidadeParcela: 2,
        formaPagamento: "PARCELADO",
        status: "PLANEJADO",
      })),
    });
    for (const [expenseId, projectId, schedule] of [
      [ID.source, ID.pessoal, PUBLIC_SOURCE],
      [ID.target, ID.obra, PUBLIC_TARGET],
      [
        ID.other,
        ID.hidden,
        {
          version: 1,
          occurrences: [
            {
              index: 0,
              parcela: "1/2",
              valor: 5345,
              data: "2026-09-02",
              invoiceDueMonth: "2026-11",
            },
            {
              index: 1,
              parcela: "2/2",
              valor: 5345,
              data: "2026-10-02",
              invoiceDueMonth: "2026-12",
            },
          ],
        },
      ],
    ] as const) {
      await setup.cashFlowEntry.createMany({
        data: schedule.occurrences.map((item) => ({
          id: `${expenseId}-${item.index}`,
          tenantId: ID.tenant,
          projectId,
          expenseId,
          valor: item.valor,
          data: new Date(`${item.data}T00:00:00.000Z`),
          parcela: item.parcela,
          invoiceDueMonth: item.invoiceDueMonth,
          tipo: "DESPESA",
          categoria: "QA material",
          status: "PLANEJADO",
          formaPagamento:
            expenseId === ID.source ? "CARTAO_CREDITO" : "PARCELADO",
        })),
      });
    }
  });

  afterAll(async () => {
    try {
      await app?.close();
      await cleanup();
    } finally {
      await prisma.$disconnect();
      await setup.$disconnect();
      jest.useRealTimers();
    }
  });

  it.each([
    { name: "paginated nested items", suffix: "", array: false },
    { name: "planned array", suffix: "/planned", array: true },
  ])(
    "HTTP $name exposes only the five-field source schedule",
    async ({ suffix, array }) => {
      const before = await snapshot();
      const result = await request(
        "GET",
        `/projects/${ID.pessoal}/expenses${suffix}`,
      );
      expect(result.status).toBe(200);
      const item = expect.objectContaining({
        id: ID.source,
        schedule: PUBLIC_SOURCE,
      });
      expect(result.body).toEqual(
        array ? [item] : expect.objectContaining({ items: [item], total: 1 }),
      );
      if (!array) expect(result.body).not.toHaveProperty("schedule");
      expectNoPrivateSchedule(result.body);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([FULL, OWNER])(
    "HTTP detail does not expose private provenance to $role",
    async (actor) => {
      const result = await request("GET", expenseUrl(), undefined, actor);
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("schedule", PUBLIC_SOURCE);
      expectNoPrivateSchedule(result.body);
      expect(
        (await prisma.expense.findUniqueOrThrow({ where: { id: ID.source } }))
          .documentedSchedule,
      ).toBe(JSON.stringify(storedSource()));
    },
  );

  it("a projection-only viewer receives local amounts/labels/dates, not source provenance", async () => {
    await attachRateio();
    const sourceDenied = await request("GET", expenseUrl(), undefined, VIEWER);
    expect(sourceDenied.status).toBe(403);
    const result = await request(
      "GET",
      expenseUrl(ID.obra, ID.target),
      undefined,
      VIEWER,
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("schedule", PUBLIC_TARGET);
    expectNoPrivateSchedule(result.body);
    for (const secret of [ID.source, ID.pessoal, ID.card, ID.allocation]) {
      expect(result.text).not.toContain(secret);
    }
  });

  it("PATCH metadata preserves private storage and returns only the public schedule", async () => {
    const before = await snapshot();
    const result = await request("PATCH", expenseUrl(), {
      titulo: "QA revised metadata",
    });
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("schedule", PUBLIC_SOURCE);
    expectNoPrivateSchedule(result.body);
    const after = await snapshot();
    expect(after.cash).toEqual(before.cash);
    expect(after.expenses).toEqual(
      before.expenses.map((expense) =>
        expense.id === ID.source
          ? {
              ...expense,
              titulo: "QA revised metadata",
              updatedAt: expect.any(Date),
            }
          : expense,
      ),
    );
  });

  it.each([
    { name: "amount", patch: { valor: 246.84 } },
    { name: "quantity", patch: { quantidade: 2 } },
    { name: "installment count", patch: { quantidadeParcela: 3 } },
  ])(
    "PATCH cannot redivide documented $name or partially edit metadata",
    async ({ patch }) => {
      const before = await snapshot();
      const response = await request("PATCH", expenseUrl(), {
        titulo: "QA must not be saved",
        ...patch,
      });
      expect(response.status).toBe(409);
      expectNoPrivateSchedule(response.body);
      expect(await snapshot()).toEqual(before);
    },
  );

  const manualInput = {
    tipoDespesa: "MATERIAL_CONSTRUCAO",
    valor: 15.43,
    quantidade: 1,
    formaPagamento: "A_VISTA",
    dataPagamento: "2026-11-04",
    status: "PLANEJADO",
  };

  it("create returns schedule:null rather than the nullable storage column", async () => {
    const result = await request(
      "POST",
      `/projects/${ID.obra}/expenses`,
      manualInput,
      VIEWER,
    );
    expect(result.status).toBe(201);
    expect(result.body).toHaveProperty("schedule", null);
    expect(result.body).toHaveProperty("valorTotal", 1543);
    expectNoPrivateSchedule(result.body);
  });

  it.each(["documentedSchedule", "plannedDocumentedSchedule", "schedule"])(
    "rejects client-authored %s on create and PATCH without writes",
    async (key) => {
      const before = await snapshot();
      const injected = {
        [key]:
          key === "schedule" ? PUBLIC_SOURCE : JSON.stringify(storedSource()),
      };
      expect(
        (
          await request(
            "POST",
            `/projects/${ID.obra}/expenses`,
            { ...manualInput, ...injected },
            VIEWER,
          )
        ).status,
      ).toBe(400);
      expect((await request("PATCH", expenseUrl(), injected)).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("nested Prisma graph serialization strips planned snapshots at every depth without mutating storage", async () => {
    await attachRateio();
    await setup.rateioAllocation.update({
      where: { id: ID.allocation },
      data: { plannedDocumentedSchedule: JSON.stringify(storedSource()) },
    });
    const before = await snapshot();
    const graph = await prisma.expense.findUniqueOrThrow({
      where: { id: ID.source },
      include: {
        rateioAsSource: { include: { target: true }, orderBy: { id: "asc" } },
      },
    });
    const response = serializeFinancialScheduleResponse({
      items: [graph],
      extra: { plannedDocumentedSchedule: JSON.stringify(storedSource()) },
    });
    expect(response).toHaveProperty("items.0.schedule", PUBLIC_SOURCE);
    expect(response).toHaveProperty(
      "items.0.rateioAsSource.0.target.schedule",
      PUBLIC_TARGET,
    );
    expect(response).not.toHaveProperty("schedule");
    expectNoPrivateSchedule(response);
    expect(await snapshot()).toEqual(before);
    expect(graph.rateioAsSource[0].plannedDocumentedSchedule).toBe(
      JSON.stringify(storedSource()),
    );
  });

  it.each([
    {
      name: "malformed JSON",
      raw: '{"private":"QA confidential documentary reference"',
    },
    {
      name: "unknown version",
      raw: JSON.stringify({ ...storedSource(), version: 99 }),
    },
    {
      name: "private extra field",
      raw: JSON.stringify({ ...storedSource(), secret: EVIDENCE.reference }),
    },
  ])(
    "$name fails loudly and sanitized through HTTP, not as an empty schedule",
    async ({ raw }) => {
      await setup.expense.update({
        where: { id: ID.source },
        data: { documentedSchedule: raw },
      });
      const before = await snapshot();
      for (const url of [
        expenseUrl(),
        `/projects/${ID.pessoal}/expenses`,
        `/projects/${ID.pessoal}/expenses/planned`,
      ]) {
        const response = await request("GET", url);
        expect(response.status).toBe(500);
        expectNoPrivateSchedule(response.body);
        expect(response.body).not.toHaveProperty("schedule");
      }
      const row = await prisma.expense.findUniqueOrThrow({
        where: { id: ID.source },
      });
      expect(() => serializeFinancialScheduleResponse(row)).toThrow(RangeError);
      expect(() => serializeFinancialScheduleResponse(row)).toThrow(
        /^Invalid documented expense schedule$/,
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    { project: ID.pessoal, expense: ID.source },
    { project: ID.obra, expense: ID.target },
  ])(
    "redacted rateio for $expense is byte-identical to never-rateada",
    async ({ project, expense }) => {
      const url = `${expenseUrl(project, expense)}/rateio`;
      const never = await request("GET", url, undefined, PARTIAL);
      expect(never.status).toBe(200);
      expect(never.body).toMatchObject({
        sourceExpenseId: expense,
        rateado: false,
        items: [],
      });
      await attachRateio();
      const redacted = await request("GET", url, undefined, PARTIAL);
      expect(redacted.status).toBe(200);
      expect(redacted.text).toBe(never.text);
      expect(redacted.body).not.toHaveProperty("schedule");
      expectNoPrivateSchedule(redacted.body);
      const full = await request("GET", `${expenseUrl()}/rateio`);
      expect(full.body).toMatchObject({ rateado: true, rateadoCents: 24685 });
    },
  );

  it("Maria's real find_expenses sees only the authorized projection and no private schedule data", async () => {
    await attachRateio();
    const { run, llm, delivered } = mariaProbe();
    await run();
    expect(llm.chat).toHaveBeenCalledTimes(2);
    const messages = delivered[1].filter(({ role }) => role === "tool");
    expect(messages).toHaveLength(1);
    const result: unknown = JSON.parse(messages[0].content);
    expect(result).toMatchObject({
      despesas: [{ expenseId: ID.target, valorTotalCentavos: 13995 }],
    });
    expectNoPrivateSchedule(result);
    for (const secret of [
      ID.source,
      ID.hidden,
      ID.card,
      ID.allocation,
      PRIVATE_ACTOR,
      EVIDENCE.reference,
    ]) {
      expect(JSON.stringify(delivered)).not.toContain(secret);
    }
  });

  it.each(["valid", "malformed"])(
    "Maria transport boundary protects a %s real Prisma service result",
    async (state) => {
      await attachRateio();
      if (state === "malformed") {
        await setup.expense.update({
          where: { id: ID.target },
          data: { documentedSchedule: `{"secret":"${EVIDENCE.reference}"` },
        });
      }
      const raw = await expenses.findAll(ID.tenant, ID.obra);
      // Boundary injection uses a real, scoped service result, not fake financial logic.
      const execute = jest.spyOn(tools, "execute").mockResolvedValue(raw);
      const { run, llm, delivered } = mariaProbe();
      try {
        if (state === "malformed") {
          await expect(run()).rejects.toThrow(
            /^Invalid documented expense schedule$/,
          );
          expect(llm.chat).toHaveBeenCalledTimes(1);
        } else {
          await run();
          expect(llm.chat).toHaveBeenCalledTimes(2);
          const messages = delivered[1].filter(({ role }) => role === "tool");
          expect(messages).toHaveLength(1);
          const result: unknown = JSON.parse(messages[0].content);
          expect(result).toHaveProperty("items.0.schedule", PUBLIC_TARGET);
          expectNoPrivateSchedule(result);
          expect(raw.items[0].documentedSchedule).toBe(
            JSON.stringify(storedTarget()),
          );
        }
        expect(JSON.stringify(delivered)).not.toContain(PRIVATE_ACTOR);
        expect(JSON.stringify(delivered)).not.toContain(EVIDENCE.reference);
      } finally {
        execute.mockRestore();
      }
    },
  );

  it("source-only correction previews without writes, applies local index 0 for printed 2/3, and replays exactly", async () => {
    const before = await snapshot();
    const fingerprint = await preview();
    expect(await snapshot()).toEqual(before);
    const result = await apply(fingerprint);
    expect([200, 201]).toContain(result.status);
    expectNoPrivateSchedule(result.body);
    const after = await snapshot();
    const source = after.expenses.find(({ id }) => id === ID.source)!;
    expect(after.expenses).toEqual(
      before.expenses.map((expense) =>
        expense.id === ID.source
          ? {
              ...expense,
              valor: 24682,
              valorTotal: 24682,
              documentedSchedule: expect.any(String),
              updatedAt: expect.any(Date),
            }
          : expense,
      ),
    );
    expect(after.cash).toEqual(
      before.cash.map((entry) =>
        entry.id === `${ID.source}-0`
          ? { ...entry, valor: 12342, updatedAt: expect.any(Date) }
          : entry,
      ),
    );
    expect({ ...after, expenses: [], cash: [] }).toEqual({
      ...before,
      expenses: [],
      cash: [],
    });
    const stored = parseStoredExpenseSchedule(source.documentedSchedule);
    expect(stored).toMatchObject({
      kind: "source",
      occurrences: [
        {
          index: 0,
          parcela: "2/3",
          valor: 12342,
          data: "2026-08-31",
          invoiceDueMonth: "2026-11",
        },
        {
          index: 1,
          parcela: "3/3",
          valor: 12340,
          data: "2026-09-30",
          invoiceDueMonth: "2026-12",
        },
      ],
      lastOperation: { requestId: REQUEST_ID, actorUserId: FULL.id },
    });
    expect([200, 201]).toContain((await apply(fingerprint)).status);
    expect(await snapshot()).toEqual(after);
    expect(
      (await apply(fingerprint, [change(`${ID.source}-0`, 12341)])).status,
    ).toBe(409);
    expect(await snapshot()).toEqual(after);
  });

  it("legacy imported CFEs acquire a schedule without redividing values or inventing future cycles", async () => {
    await setup.expense.update({
      where: { id: ID.source },
      data: { documentedSchedule: null },
    });
    await setup.cashFlowEntry.updateMany({
      where: { tenantId: ID.tenant, expenseId: ID.source },
      data: { invoiceDueMonth: null },
    });
    const before = await snapshot();
    const fingerprint = await preview();
    expect(await snapshot()).toEqual(before);
    expect([200, 201]).toContain((await apply(fingerprint)).status);
    const after = await snapshot();
    expect(after.cash).toEqual(
      before.cash.map((entry) =>
        entry.id === `${ID.source}-0`
          ? {
              ...entry,
              valor: 12342,
              invoiceDueMonth: "2026-11",
              updatedAt: expect.any(Date),
            }
          : entry,
      ),
    );
    const source = after.expenses.find(({ id }) => id === ID.source)!;
    expect(after.expenses).toEqual(
      before.expenses.map((expense) =>
        expense.id === ID.source
          ? {
              ...expense,
              valor: 24682,
              valorTotal: 24682,
              documentedSchedule: expect.any(String),
              updatedAt: expect.any(Date),
            }
          : expense,
      ),
    );
    expect(parseStoredExpenseSchedule(source.documentedSchedule)).toMatchObject(
      {
        kind: "source",
        occurrences: [
          {
            index: 0,
            parcela: "2/3",
            valor: 12342,
            data: "2026-08-31",
            invoiceDueMonth: "2026-11",
          },
          {
            index: 1,
            parcela: "3/3",
            valor: 12340,
            data: "2026-09-30",
            invoiceDueMonth: null,
          },
        ],
      },
    );
    expect({ ...after, expenses: [], cash: [] }).toEqual({
      ...before,
      expenses: [],
      cash: [],
    });
  });

  it("a cycle-only correction crosses the year without moving money, dates or other occurrences", async () => {
    const before = await snapshot();
    const changes = [
      { ...change(`${ID.source}-0`, 12345), invoiceDueMonth: "2027-01" },
    ];
    const fingerprint = await preview(changes);
    expect([200, 201]).toContain((await apply(fingerprint, changes)).status);
    const after = await snapshot();
    expect(after.cash).toEqual(
      before.cash.map((entry) =>
        entry.id === `${ID.source}-0`
          ? {
              ...entry,
              invoiceDueMonth: "2027-01",
              updatedAt: expect.any(Date),
            }
          : entry,
      ),
    );
    expect(after.expenses).toEqual(
      before.expenses.map((expense) =>
        expense.id === ID.source
          ? {
              ...expense,
              documentedSchedule: expect.any(String),
              updatedAt: expect.any(Date),
            }
          : expense,
      ),
    );
    expect({ ...after, expenses: [], cash: [] }).toEqual({
      ...before,
      expenses: [],
      cash: [],
    });
    const detail = await request("GET", expenseUrl());
    expect(detail.status).toBe(200);
    expect(detail.body).toHaveProperty("schedule", {
      version: 1,
      occurrences: [
        { ...PUBLIC_SOURCE.occurrences[0], invoiceDueMonth: "2027-01" },
        PUBLIC_SOURCE.occurrences[1],
      ],
    });
  });

  it("unrepresentable legacy quantity fails preview instead of rounding unit price or changing quantity", async () => {
    await preview();
    await setup.expense.update({
      where: { id: ID.source },
      data: { valor: 4937, quantidade: 5 },
    });
    const before = await snapshot();
    const response = await request("POST", correctionUrl(), {
      mode: "preview",
      changes: [change()],
    });
    expect([400, 409]).toContain(response.status);
    expectNoPrivateSchedule(response.body);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { name: "empty changes", changes: [] },
    { name: "zero source amount", changes: [change(`${ID.source}-0`, 0)] },
    { name: "negative source amount", changes: [change(`${ID.source}-0`, -1)] },
    { name: "fractional cents", changes: [change(`${ID.source}-0`, 123.4)] },
    { name: "Int overflow", changes: [change(`${ID.source}-0`, 2147483648)] },
    { name: "duplicate CFE", changes: [change(), change()] },
    {
      name: "no financial change",
      changes: [{ cashFlowEntryId: `${ID.source}-0`, evidence: EVIDENCE }],
    },
    { name: "client status", changes: [{ ...change(), status: "PAGO" }] },
    {
      name: "client evidence actor",
      changes: [
        { ...change(), evidence: { ...EVIDENCE, actorUserId: PRIVATE_ACTOR } },
      ],
    },
  ])(
    "rejects $name at the correction boundary without writes",
    async ({ changes }) => {
      await preview();
      const before = await snapshot();
      const response = await request("POST", correctionUrl(), {
        mode: "preview",
        changes,
      });
      expect([400, 409, 422]).toContain(response.status);
      expectNoPrivateSchedule(response.body);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("an untouched paid sibling allows planned correction and stays unchanged", async () => {
    await setup.expense.update({
      where: { id: ID.source },
      data: { paidParcelas: "[0]" },
    });
    await setup.cashFlowEntry.update({
      where: { id: `${ID.source}-0` },
      data: { status: "PAGO" },
    });
    const before = await snapshot();
    const changes = [
      { ...change(`${ID.source}-1`, 12335), invoiceDueMonth: "2026-12" },
    ];
    const fingerprint = await preview(changes);
    expect([200, 201]).toContain((await apply(fingerprint, changes)).status);
    const after = await snapshot();
    expect(after.cash).toEqual(
      before.cash.map((entry) =>
        entry.id === `${ID.source}-1`
          ? { ...entry, valor: 12335, updatedAt: expect.any(Date) }
          : entry,
      ),
    );
    expect(after.expenses.find(({ id }) => id === ID.source)).toMatchObject({
      valorTotal: 24680,
      paidParcelas: "[0]",
      status: "PLANEJADO",
    });
  });

  it("paid selection after preview conflicts without any partial write", async () => {
    const fingerprint = await preview();
    await setup.cashFlowEntry.update({
      where: { id: `${ID.source}-0` },
      data: { status: "PAGO" },
    });
    await setup.expense.update({
      where: { id: ID.source },
      data: { paidParcelas: "[0]" },
    });
    const drifted = await snapshot();
    expect((await apply(fingerprint)).status).toBe(409);
    expect(await snapshot()).toEqual(drifted);
  });

  it.each([
    "missing second CFE",
    "soft-deleted second CFE",
    "paid second CFE",
    "settlement claim",
    "new reverse member",
  ])(
    "%s after preview prevents every source, counterpart and audit write",
    async (drift) => {
      await attachOne("direct");
      const changes = [
        change(),
        { ...change(`${ID.source}-1`, 12338), invoiceDueMonth: "2026-12" },
      ];
      const fingerprint = await preview(changes);
      if (drift === "missing second CFE") {
        await setup.cashFlowEntry.delete({ where: { id: `${ID.source}-1` } });
      } else if (drift === "soft-deleted second CFE") {
        await prisma.cashFlowEntry.delete({ where: { id: `${ID.source}-1` } });
        expect(
          await setup.cashFlowEntry.findUniqueOrThrow({
            where: { id: `${ID.source}-1` },
          }),
        ).toMatchObject({ deletedAt: expect.any(Date) });
      } else if (drift === "paid second CFE") {
        await setup.cashFlowEntry.update({
          where: { id: `${ID.source}-1` },
          data: { status: "PAGO" },
        });
        await setup.expense.update({
          where: { id: ID.source },
          data: { paidParcelas: "[1]" },
        });
      } else if (drift === "settlement claim") {
        await setup.crossProjectSettlement.create({
          data: {
            tenantId: ID.tenant,
            sourceExpenseId: ID.source,
            targetExpenseId: ID.target,
            parcelaIndex: 1,
            realValor: 12340,
            plannedValor: 12340,
            plannedStatus: "PLANEJADO",
          },
        });
      } else {
        await setup.expense.update({
          where: { id: ID.other },
          data: { linkedExpenseId: ID.source },
        });
      }
      const before = await snapshot();
      expect((await apply(fingerprint, changes)).status).toBe(409);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("knowing all resource IDs never authorizes a different tenant", async () => {
    await preview();
    const before = await snapshot();
    const body = { mode: "preview", changes: [change()] };
    const forbidden = await request("POST", correctionUrl(), body, FOREIGN);
    const absent = await request(
      "POST",
      correctionUrl().replace(ID.source, "qa701-absent-source"),
      body,
      FOREIGN,
    );
    expect(forbidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(forbidden.text).toBe(absent.text);
    expectNoPrivateSchedule(forbidden.body);
    expect(await snapshot()).toEqual(before);
  });

  it("current grants revoked after preview override stale request claims", async () => {
    const fingerprint = await preview();
    await setup.user.update({
      where: { id: FULL.id },
      data: { allowedProjects: JSON.stringify([ID.obra]) },
    });
    const before = await snapshot();
    expect((await apply(fingerprint)).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it("two competing apply requests cannot both consume one fingerprint", async () => {
    const fingerprint = await preview();
    const responses = await Promise.all([
      apply(fingerprint),
      apply(fingerprint, [change()], "70100000-0000-4000-8000-000000000002"),
    ]);
    expect(
      responses.filter(({ status }) => status === 200 || status === 201),
    ).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 409)).toHaveLength(1);
    const source = await prisma.expense.findUniqueOrThrow({
      where: { id: ID.source },
    });
    expect(source.valorTotal).toBe(24682);
    expect(
      await prisma.cashFlowEntry.count({ where: { tenantId: ID.tenant } }),
    ).toBe(6);
  });

  it.each(["direct", "reverse", "rateio"] as const)(
    "%s one-to-one graph propagates in place while keeping local labels and planned snapshots",
    async (kind) => {
      await attachOne(kind);
      const before = await snapshot();
      const fingerprint = await preview();
      expect([200, 201]).toContain((await apply(fingerprint)).status);
      const after = await snapshot();
      expect(after.cash).toEqual(
        before.cash.map((entry) =>
          entry.id === `${ID.source}-0` || entry.id === `${ID.target}-0`
            ? { ...entry, valor: 12342, updatedAt: expect.any(Date) }
            : entry,
        ),
      );
      expect(after.expenses).toEqual(
        before.expenses.map((expense) =>
          expense.id === ID.source || expense.id === ID.target
            ? {
                ...expense,
                valor: 24682,
                valorTotal: 24682,
                documentedSchedule: expect.any(String),
                updatedAt: expect.any(Date),
              }
            : expense,
        ),
      );
      expect(after.allocations).toEqual(
        before.allocations.map((allocation) => ({
          ...allocation,
          allocation: 24682,
        })),
      );
      expect({ ...after, expenses: [], cash: [], allocations: [] }).toEqual({
        ...before,
        expenses: [],
        cash: [],
        allocations: [],
      });
      const target = await request("GET", expenseUrl(ID.obra, ID.target));
      expect(target.status).toBe(200);
      expect(target.body).toHaveProperty("schedule", {
        version: 1,
        occurrences: [
          {
            index: 0,
            parcela: "1/2",
            valor: 12342,
            data: "2026-09-02",
            invoiceDueMonth: "2026-11",
          },
          {
            index: 1,
            parcela: "2/2",
            valor: 12340,
            data: "2026-10-02",
            invoiceDueMonth: "2026-12",
          },
        ],
      });
      expectNoPrivateSchedule(target.body);
    },
  );

  it.each(["preview", "apply"])(
    "counterpart-only drift after %s conflicts without changing source or audit",
    async (stage) => {
      await attachOne("reverse");
      const fingerprint = await preview();
      if (stage === "apply")
        expect([200, 201]).toContain((await apply(fingerprint)).status);
      await setup.cashFlowEntry.update({
        where: { id: `${ID.target}-1` },
        data: { valor: 12339 },
      });
      const drifted = await snapshot();
      expect((await apply(fingerprint)).status).toBe(409);
      expect(await snapshot()).toEqual(drifted);
    },
  );

  it("a newly hidden graph participant fails exactly like an absent resource", async () => {
    await attachOne("direct");
    const fingerprint = await preview();
    await setup.user.update({
      where: { id: FULL.id },
      data: { allowedProjects: JSON.stringify([ID.pessoal]) },
    });
    const before = await snapshot();
    const hidden = await apply(fingerprint);
    const missing = await request(
      "POST",
      correctionUrl().replace(ID.source, "qa701-absent-source"),
      {
        mode: "apply",
        requestId: REQUEST_ID,
        expectedFingerprint: fingerprint,
        changes: [change()],
      },
    );
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.text).toBe(missing.text);
    expectNoPrivateSchedule(hidden.body);
    expect(await snapshot()).toEqual(before);
  });

  it("multi-target correction requires an explicit matrix and never guesses the leftover cents", async () => {
    await attachRateio();
    const before = await snapshot();
    const response = await request("POST", correctionUrl(), {
      mode: "preview",
      changes: [change()],
    });
    expect([200, 201]).toContain(response.status);
    expect(response.body).toHaveProperty("requiresAllocationBreakdown", true);
    expectNoPrivateSchedule(response.body);
    expect(await snapshot()).toEqual(before);
  });

  it("global allocation equality cannot hide an untouched per-occurrence imbalance", async () => {
    await attachRateio();
    const changes = [
      {
        ...change(),
        allocationBreakdown: [
          {
            allocationId: ID.allocation,
            targetCashFlowEntryId: `${ID.target}-0`,
            amountCents: 6997,
          },
          {
            allocationId: ID.otherAllocation,
            targetCashFlowEntryId: `${ID.other}-0`,
            amountCents: 5345,
          },
        ],
      },
    ];
    await preview(changes);
    await setup.cashFlowEntry.update({
      where: { id: `${ID.other}-0` },
      data: { valor: 5344 },
    });
    await setup.cashFlowEntry.update({
      where: { id: `${ID.other}-1` },
      data: { valor: 5346 },
    });
    const before = await snapshot();
    expect(
      before.allocations.reduce((sum, item) => sum + item.allocation, 0),
    ).toBe(24685);
    const response = await request("POST", correctionUrl(), {
      mode: "preview",
      changes,
    });
    expect(response.status).toBe(409);
    expectNoPrivateSchedule(response.body);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["hidden", "deleted"])(
    "the second rateio participant becoming %s fails opaquely before financial diagnostics",
    async (state) => {
      await attachRateio();
      const changes = [
        {
          ...change(),
          allocationBreakdown: [
            {
              allocationId: ID.allocation,
              targetCashFlowEntryId: `${ID.target}-0`,
              amountCents: 6997,
            },
            {
              allocationId: ID.otherAllocation,
              targetCashFlowEntryId: `${ID.other}-0`,
              amountCents: 5345,
            },
          ],
        },
      ];
      const fingerprint = await preview(changes);
      if (state === "hidden") {
        await setup.user.update({
          where: { id: FULL.id },
          data: { allowedProjects: JSON.stringify([ID.pessoal, ID.obra]) },
        });
      } else {
        await prisma.expense.delete({ where: { id: ID.other } });
      }
      await setup.cashFlowEntry.update({
        where: { id: `${ID.other}-0` },
        data: { valor: 1 },
      });
      const before = await snapshot();
      const result = await apply(fingerprint, changes);
      const absent = await request(
        "POST",
        correctionUrl().replace(ID.source, "qa701-absent-source"),
        {
          mode: "apply",
          requestId: REQUEST_ID,
          expectedFingerprint: fingerprint,
          changes,
        },
      );
      expect(result.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(result.text).toBe(absent.text);
      expectNoPrivateSchedule(result.body);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("official unratear restores documented planning rather than redividing the corrected projection", async () => {
    await attachOne("rateio");
    const fingerprint = await preview();
    expect([200, 201]).toContain((await apply(fingerprint)).status);
    const undo = await request("DELETE", `${expenseUrl()}/ratear`);
    expect(undo.status).toBe(200);
    const target = await prisma.expense.findUniqueOrThrow({
      where: { id: ID.target },
    });
    expect(target).toMatchObject({
      valor: 13995,
      quantidade: 1,
      valorTotal: 13995,
      formaPagamento: "PARCELADO",
      quantidadeParcela: 2,
      dataInicioParcela: new Date("2026-09-02T00:00:00.000Z"),
      status: "PLANEJADO",
      paidParcelas: null,
      documentedSchedule: JSON.stringify(storedTarget()),
    });
    const entries = await prisma.cashFlowEntry.findMany({
      where: { tenantId: ID.tenant, expenseId: ID.target },
      orderBy: { data: "asc" },
    });
    expect(
      entries.map(({ valor, data, parcela, invoiceDueMonth, status }) => ({
        valor,
        data,
        parcela,
        invoiceDueMonth,
        status,
      })),
    ).toEqual([
      {
        valor: 7000,
        data: new Date("2026-09-02T00:00:00.000Z"),
        parcela: "1/2",
        invoiceDueMonth: "2026-11",
        status: "PLANEJADO",
      },
      {
        valor: 6995,
        data: new Date("2026-10-02T00:00:00.000Z"),
        parcela: "2/2",
        invoiceDueMonth: "2026-12",
        status: "PLANEJADO",
      },
    ]);
    expect(
      await prisma.rateioAllocation.count({ where: { tenantId: ID.tenant } }),
    ).toBe(0);
  });

  it.each([
    {
      name: "nonzero cells",
      targetCell: 6995,
      otherCell: 5345,
      targetTotal: 13990,
      otherTotal: 10690,
    },
    {
      name: "a valid zero cell",
      targetCell: 12340,
      otherCell: 0,
      targetTotal: 19335,
      otherTotal: 5345,
    },
  ])(
    "explicit matrix with $name updates in place and preserves planned snapshots",
    async ({ targetCell, otherCell, targetTotal, otherTotal }) => {
      await attachRateio();
      const before = await snapshot();
      const changes = [
        {
          ...change(`${ID.source}-0`, 12340),
          allocationBreakdown: [
            {
              allocationId: ID.allocation,
              targetCashFlowEntryId: `${ID.target}-0`,
              amountCents: targetCell,
            },
            {
              allocationId: ID.otherAllocation,
              targetCashFlowEntryId: `${ID.other}-0`,
              amountCents: otherCell,
            },
          ],
        },
      ];
      const fingerprint = await preview(changes);
      expect([200, 201]).toContain((await apply(fingerprint, changes)).status);
      const after = await snapshot();
      expect(after.allocations).toEqual(
        before.allocations.map((allocation) =>
          allocation.id === ID.allocation
            ? { ...allocation, allocation: targetTotal }
            : { ...allocation, allocation: otherTotal },
        ),
      );
      expect(after.cash).toEqual(
        before.cash.map((entry) =>
          entry.id === `${ID.source}-0` ||
          entry.id === `${ID.target}-0` ||
          (entry.id === `${ID.other}-0` && entry.valor !== otherCell)
            ? {
                ...entry,
                valor:
                  entry.id === `${ID.source}-0`
                    ? 12340
                    : entry.id === `${ID.target}-0`
                      ? targetCell
                      : otherCell,
                updatedAt: expect.any(Date),
              }
            : entry,
        ),
      );
      expect(
        after.expenses.map(({ id, valor, quantidade, valorTotal, status }) => ({
          id,
          valor,
          quantidade,
          valorTotal,
          status,
        })),
      ).toEqual([
        {
          id: ID.source,
          valor: 24680,
          quantidade: 1,
          valorTotal: 24680,
          status: "PLANEJADO",
        },
        {
          id: ID.other,
          valor: otherTotal,
          quantidade: 1,
          valorTotal: otherTotal,
          status: "PLANEJADO",
        },
        {
          id: ID.target,
          valor: targetTotal,
          quantidade: 1,
          valorTotal: targetTotal,
          status: "PLANEJADO",
        },
      ]);
      expect({ ...after, expenses: [], cash: [], allocations: [] }).toEqual({
        ...before,
        expenses: [],
        cash: [],
        allocations: [],
      });
    },
  );

  it.each(["missing", "duplicate", "unbalanced"] as const)(
    "rejects a %s allocation matrix without partial writes",
    async (kind) => {
      await attachRateio();
      const valid = {
        ...change(`${ID.source}-0`, 12340),
        allocationBreakdown: [
          {
            allocationId: ID.allocation,
            targetCashFlowEntryId: `${ID.target}-0`,
            amountCents: 6995,
          },
          {
            allocationId: ID.otherAllocation,
            targetCashFlowEntryId: `${ID.other}-0`,
            amountCents: 5345,
          },
        ],
      };
      await preview([valid]);
      const before = await snapshot();
      const cells = valid.allocationBreakdown;
      const broken =
        kind === "missing"
          ? [cells[0]]
          : kind === "duplicate"
            ? [cells[0], cells[0]]
            : [cells[0], { ...cells[1], amountCents: 5346 }];
      const response = await request("POST", correctionUrl(), {
        mode: "preview",
        changes: [{ ...valid, allocationBreakdown: broken }],
      });
      expect([400, 409]).toContain(response.status);
      expectNoPrivateSchedule(response.body);
      expect(await snapshot()).toEqual(before);
    },
  );
});
