require("../../../../scripts/test-db-env.cjs");

import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import {
  APIRequestContext,
  request as playwrightRequest,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { ExpenseTypeLabels } from "@reformaflow/domain";
import { JwtStrategy } from "../auth/jwt.strategy";
import {
  makeMonthlyOverviewService,
  resetTenant,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { BudgetAllocationService } from "../budget-allocation/budget-allocation.service";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { CreditCardService } from "../credit-card/credit-card.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { TenantFinancialService } from "../tenant-financial/tenant-financial.service";
import { ExpenseModule } from "./expense.module";

const T = "qa704-adversarial";
const P = `${T}-pessoal`;
const R = `${T}-reforma`;
const R2 = `${T}-other-reforma`;
const USER = `${T}-user`;
const CARD = `${T}-card`;
const ALT_CARD = `${T}-other-card`;
const IMPORT = `${T}-import`;
const OTHER_IMPORT = `${T}-other-import`;
const ALT_IMPORT = `${T}-other-card-import`;
const SOURCE = `${T}-refund`;
const PURCHASE = `${T}-purchase`;
const LIVE_CFE = `${SOURCE}-cash`;
const OLD_CFE = `${SOURCE}-historical`;
const ROOM = `${T}-room`;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const PURCHASE_DATE = new Date("2026-08-25T00:00:00.000Z");
const PAYMENT_DATE = new Date("2026-09-12T00:00:00.000Z");
const ACTOR = {
  id: USER,
  role: "USER",
  allowedProjects: [P, R, R2],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: [
    "expenses",
    "creditCards",
    "monthlyOverview",
    "receipts",
    "budgetAllocations",
  ],
};
const endpoint = `/projects/${P}/expenses/${SOURCE}/refund-purpose`;
const intent = { targetProjectId: R, roomId: null as string | null };

interface Summary {
  sourceExpenseId: string;
  targetProjectId: string;
  roomId: string | null;
  tipoDespesa: string;
  allocationCents: number;
  dataCompra: string | null;
  dataPagamento: string;
  cashFlowDate: string;
  cardId: string;
  importId: string;
}
interface Preview {
  mode: "preview";
  revision: number;
  fingerprint: string;
  summary: Summary;
}
interface Applied {
  mode: "apply";
  revision: number;
  fingerprint: string;
  summary: Summary;
  targetExpenseId: string;
  alreadyApplied: boolean;
}

function assertPreview(value: unknown): asserts value is Preview {
  expect(value).toMatchObject({
    mode: "preview",
    revision: expect.any(Number),
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    summary: {
      sourceExpenseId: SOURCE,
      targetProjectId: expect.any(String),
      tipoDespesa: expect.any(String),
      allocationCents: expect.any(Number),
      dataPagamento: expect.any(String),
      cashFlowDate: expect.any(String),
      cardId: expect.any(String),
      importId: expect.any(String),
    },
  });
}

function assertApplied(value: unknown): asserts value is Applied {
  expect(value).toMatchObject({
    mode: "apply",
    revision: expect.any(Number),
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    targetExpenseId: expect.any(String),
    alreadyApplied: expect.any(Boolean),
    summary: { sourceExpenseId: SOURCE, allocationCents: expect.any(Number) },
  });
}

function applyBody(preview: Preview) {
  return {
    mode: "apply",
    targetProjectId: preview.summary.targetProjectId,
    roomId: preview.summary.roomId,
    expectedRevision: preview.revision,
    expectedFingerprint: preview.fingerprint,
  };
}

describe("#704 refund purpose adversarial contract", () => {
  // Only setup, drift injection and complete snapshots use bare Prisma.
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const secondPrisma = new PrismaService();
  const monthly = makeMonthlyOverviewService(prisma);
  const financial = new TenantFinancialService(prisma, monthly);
  const budget = new BudgetAllocationService(prisma);
  const conciliacao = new ConciliacaoService(prisma);
  const cards = new CreditCardService(
    prisma,
    conciliacao,
    new MerchantClassifierService(prisma),
  );
  const secondCards = new CreditCardService(
    secondPrisma,
    new ConciliacaoService(secondPrisma),
    new MerchantClassifierService(secondPrisma),
  );
  let app: INestApplication;
  let secondApp: INestApplication;
  let http: APIRequestContext;
  let secondHttp: APIRequestContext;
  let failAllocation = false;
  let injected = false;

  prisma.$use(async (params, next) => {
    if (
      failAllocation &&
      params.model === "RateioAllocation" &&
      ["create", "createMany", "upsert"].includes(params.action)
    ) {
      await next(params);
      injected = true;
      throw new Error("Synthetic allocation rollback");
    }
    return next(params);
  });

  async function server(db: PrismaService) {
    const module = await Test.createTestingModule({
      imports: [PrismaModule, ExpenseModule],
      providers: [JwtStrategy],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();
    const instance = module.createNestApplication();
    instance.useLogger(false);
    const reflector = new Reflector();
    instance.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new RolesGuard(reflector),
      new ModulesGuard(reflector, db),
      new ProjectAccessGuard(db, reflector),
    );
    instance.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await instance.listen(0, "127.0.0.1");
    const jwt = new JwtService({
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
    });
    const token = jwt.sign({
      sub: USER,
      tenantId: T,
      sv: 0,
      role: "ADMIN",
      allowedProjects: [],
      allowedModules: ACTOR.allowedModules,
    });
    const client = await playwrightRequest.newContext({
      baseURL: await instance.getUrl(),
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    return { instance, client };
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
    jest.setSystemTime(NOW);
    ({ instance: app, client: http } = await server(prisma));
    ({ instance: secondApp, client: secondHttp } = await server(secondPrisma));
  });

  async function clean() {
    await setup.expense.updateMany({
      where: { tenantId: T },
      data: { roomId: null },
    });
    await setup.room.deleteMany({ where: { projectId: { in: [P, R, R2] } } });
    await setup.user.deleteMany({ where: { tenantId: T } });
    await setup.invoiceAdjustment.deleteMany({ where: { tenantId: T } });
    await setup.budgetAllocation.deleteMany({ where: { tenantId: T } });
    await resetTenant(setup, T);
  }

  beforeEach(async () => {
    failAllocation = injected = false;
    await clean();
    await seedPessoal(setup, { tenantId: T, projectId: P });
    await setup.project.createMany({
      data: [R, R2].map((id) => ({
        id,
        tenantId: T,
        type: "REFORMA",
        name: `Synthetic ${id}`,
      })),
    });
    await setup.room.create({
      data: { id: ROOM, projectId: R, name: "Synthetic room" },
    });
    await setup.user.create({
      data: {
        id: USER,
        tenantId: T,
        username: USER,
        name: "Synthetic QA",
        role: "USER",
        allowedProjects: JSON.stringify(ACTOR.allowedProjects),
        allowedProjectTypes: JSON.stringify(ACTOR.allowedProjectTypes),
        allowedModules: JSON.stringify(ACTOR.allowedModules),
        lastActivityAt: NOW,
      },
    });
    await setup.creditCard.createMany({
      data: [
        {
          id: CARD,
          tenantId: T,
          projectId: P,
          institution: "ITAU",
          nickname: "Synthetic card",
          last4: "0704",
          closingDay: 20,
          dueDay: 25,
        },
        {
          id: ALT_CARD,
          tenantId: T,
          projectId: P,
          institution: "ITAU",
          nickname: "Alternate card",
          last4: "0705",
          closingDay: 20,
          dueDay: 25,
        },
      ],
    });
    await setup.creditCardStatementImport.createMany({
      data: [
        { id: IMPORT, cardId: CARD },
        { id: OTHER_IMPORT, cardId: CARD },
        { id: ALT_IMPORT, cardId: ALT_CARD },
      ].map((row) => ({
        ...row,
        tenantId: T,
        source: "CSV_GENERIC",
        periodLabel: "2026-09",
        status: "COMPLETED",
        createdAt: new Date("2026-09-01"),
      })),
    });
    for (const [id, amount] of [
      [SOURCE, -12_345],
      [PURCHASE, 50_000],
    ] as const) {
      await setup.expense.create({
        data: {
          id,
          tenantId: T,
          projectId: P,
          tipoDespesa: "MATERIAL_CONSTRUCAO",
          titulo: `Synthetic ${id}`,
          fornecedor: "Synthetic supplier",
          valor: amount,
          quantidade: 1,
          valorTotal: amount,
          formaPagamento: "A_VISTA",
          dataCompra: PURCHASE_DATE,
          dataPagamento: PAYMENT_DATE,
          status: "PAGO",
          cardLast4: "0704",
          importId: id === SOURCE ? IMPORT : null,
          externalId: id === SOURCE ? "synthetic-refund-external" : null,
          dedupeKeyStrong: id === SOURCE ? "synthetic-strong-refund" : null,
          dedupeKeyNatural: id === SOURCE ? "synthetic-natural-refund" : null,
          createdAt: new Date("2026-09-15"),
        },
      });
      await setup.cashFlowEntry.create({
        data: {
          id: `${id}-cash`,
          tenantId: T,
          projectId: P,
          expenseId: id,
          valor: amount,
          tipo: "DESPESA",
          categoria: ExpenseTypeLabels.MATERIAL_CONSTRUCAO,
          subcategoria: "Synthetic card",
          data: PAYMENT_DATE,
          status: "PAGO",
          formaPagamento: "CARTAO_CREDITO",
        },
      });
    }
    await setup.cashFlowEntry.create({
      data: {
        id: OLD_CFE,
        tenantId: T,
        projectId: P,
        expenseId: SOURCE,
        valor: -12_000,
        tipo: "DESPESA",
        categoria: ExpenseTypeLabels.MATERIAL_CONSTRUCAO,
        data: new Date("2026-09-02"),
        status: "PAGO",
        formaPagamento: "CARTAO_CREDITO",
        createdAt: new Date("2026-09-02"),
        deletedAt: new Date("2026-09-03"),
      },
    });
  });

  afterAll(async () => {
    failAllocation = false;
    await http?.dispose();
    await secondHttp?.dispose();
    await app?.close();
    await secondApp?.close();
    await clean();
    await prisma.$disconnect();
    await secondPrisma.$disconnect();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  const source = () =>
    setup.expense.findUniqueOrThrow({ where: { id: SOURCE } });
  const sourceCash = () =>
    setup.cashFlowEntry.findMany({
      where: { expenseId: SOURCE },
      orderBy: { id: "asc" },
    });
  async function otherFinancialRows() {
    const query = { where: { tenantId: T }, orderBy: { id: "asc" as const } };
    return {
      receipts: await setup.receipt.findMany(query),
      budgets: await setup.budgetAllocation.findMany(query),
      adjustments: await setup.invoiceAdjustment.findMany(query),
      ledger: await setup.importedInvoiceLiquidation.findMany(query),
      settlements: await setup.crossProjectSettlement.findMany(query),
      bankAccounts: await setup.bankAccount.findMany(query),
      bankImports: await setup.bankStatementImport.findMany(query),
    };
  }
  async function snapshot() {
    const query = { where: { tenantId: T }, orderBy: { id: "asc" as const } };
    return {
      expenses: await setup.expense.findMany(query),
      cash: await setup.cashFlowEntry.findMany(query),
      allocations: await setup.rateioAllocation.findMany(query),
      imports: await setup.creditCardStatementImport.findMany(query),
      cards: await setup.creditCard.findMany(query),
      other: await otherFinancialRows(),
    };
  }
  async function preview(
    overrides: Partial<typeof intent> = {},
    client = http,
  ): Promise<Preview> {
    const response = await client.post(endpoint, {
      data: { mode: "preview", ...intent, ...overrides },
    });
    expect(response.status()).toBe(201);
    const body: unknown = await response.json();
    assertPreview(body);
    expect(Number.isInteger(body.revision)).toBe(true);
    expect(body.summary.allocationCents).toBeLessThan(0);
    return body;
  }
  async function apply(plan: Preview, client = http): Promise<Applied> {
    const response = await client.post(endpoint, { data: applyBody(plan) });
    expect(response.status()).toBe(201);
    const body: unknown = await response.json();
    assertApplied(body);
    expect(body.fingerprint).toBe(plan.fingerprint);
    expect(body.summary).toEqual(plan.summary);
    return body;
  }
  async function undo(revision: number) {
    const response = await http.delete(endpoint, {
      data: { expectedRevision: revision },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: revision + 1,
      alreadyUndone: expect.any(Boolean),
    });
  }
  async function rejectApply(
    plan: Preview,
    extra: Record<string, unknown> = {},
    status = 409,
  ) {
    const before = await snapshot();
    const response = await http.post(endpoint, {
      data: { ...applyBody(plan), ...extra },
    });
    expect(response.status()).toBe(status);
    expect(await snapshot()).toEqual(before);
  }

  it("has a live authenticated source fixture before testing the new endpoint", async () => {
    const response = await http.get(`/projects/${P}/expenses/${SOURCE}`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      id: SOURCE,
      valorTotal: -12_345,
      status: "PAGO",
    });
    expect(
      await prisma.cashFlowEntry.findFirst({ where: { id: OLD_CFE } }),
    ).toBeNull();
    expect(
      await prisma.cashFlowEntry.findUnique({ where: { id: OLD_CFE } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it("baseline financial readers establish the signed fixture without reproducing their calculations", async () => {
    const invoice = await monthly.getCardInvoicesYearly(T, P, 2026, ACTOR);
    expect(invoice.months.find((month) => month.mes === "2026-09")?.total).toBe(
      37_655,
    );
    expect(invoice.totalAno).toBe(37_655);
    expect((await financial.getOverview(T, [P])).pagoTotal).toBe(37_655);
    expect(await budget.getSummary(R, T)).toMatchObject({
      totalSpent: 0,
      totalReceived: 0,
    });
  });

  it("preview is read-only and apply creates one owned negative projection, never another cash credit", async () => {
    const before = await snapshot();
    const original = await source();
    const originalCash = await sourceCash();
    const plan = await preview();
    expect(plan).toEqual({
      mode: "preview",
      revision: 0,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      summary: {
        sourceExpenseId: SOURCE,
        targetProjectId: R,
        roomId: null,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        allocationCents: -12_345,
        dataCompra: PURCHASE_DATE.toISOString(),
        dataPagamento: PAYMENT_DATE.toISOString(),
        cashFlowDate: PAYMENT_DATE.toISOString(),
        cardId: CARD,
        importId: IMPORT,
      },
    });
    expect(await snapshot()).toEqual(before);
    const applied = await apply(plan);
    expect(applied).toMatchObject({ revision: 1, alreadyApplied: false });
    const afterSource = await source();
    expect(afterSource).toEqual({
      ...original,
      linkedExpenseId: applied.targetExpenseId,
      refundPurposeRevision: 1,
      updatedAt: afterSource.updatedAt,
    });
    expect(await sourceCash()).toEqual(originalCash);
    expect(await otherFinancialRows()).toEqual(before.other);
    expect(
      await setup.rateioAllocation.findMany({ where: { tenantId: T } }),
    ).toEqual([
      expect.objectContaining({
        sourceExpenseId: SOURCE,
        targetExpenseId: applied.targetExpenseId,
        allocation: -12_345,
        isRefundCredit: true,
      }),
    ]);
    expect(
      await prisma.expense.findUnique({
        where: { id: applied.targetExpenseId },
      }),
    ).toMatchObject({
      projectId: R,
      valor: -12_345,
      quantidade: 1,
      valorTotal: -12_345,
      status: "PAGO",
      tipoDespesa: "MATERIAL_CONSTRUCAO",
      dataCompra: PURCHASE_DATE,
      dataPagamento: PAYMENT_DATE,
      cardLast4: null,
      bankLast4: null,
      accountId: null,
      importId: null,
      externalId: null,
      dedupeKeyStrong: null,
      dedupeKeyNatural: null,
      settlesInvoiceKey: null,
      recurrenceKey: null,
    });
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { expenseId: applied.targetExpenseId },
      }),
    ).toEqual([
      expect.objectContaining({
        projectId: R,
        valor: -12_345,
        data: PAYMENT_DATE,
        status: "PAGO",
      }),
    ]);
    expect(await setup.expense.count({ where: { tenantId: T } })).toBe(3);
  });

  type EligibleDrift =
    | "matching amount"
    | "matching payment date"
    | "purchase date"
    | "classification"
    | "card origin"
    | "import identity"
    | "external/dedupe identity"
    | "active CFE labels"
    | "active CFE replacement"
    | "historical CFE"
    | "copied metadata"
    | "card calendar";
  async function eligibleDrift(kind: EligibleDrift) {
    switch (kind) {
      case "matching amount":
        await setup.expense.update({
          where: { id: SOURCE },
          data: { valor: -15_000, valorTotal: -15_000 },
        });
        await setup.cashFlowEntry.update({
          where: { id: LIVE_CFE },
          data: { valor: -15_000 },
        });
        break;
      case "matching payment date": {
        const data = new Date("2026-09-13");
        await setup.expense.update({
          where: { id: SOURCE },
          data: { dataPagamento: data },
        });
        await setup.cashFlowEntry.update({
          where: { id: LIVE_CFE },
          data: { data },
        });
        break;
      }
      case "purchase date":
        await setup.expense.update({
          where: { id: SOURCE },
          data: { dataCompra: new Date("2026-08-26") },
        });
        break;
      case "classification":
        await setup.expense.update({
          where: { id: SOURCE },
          data: { tipoDespesa: "MAO_DE_OBRA" },
        });
        await setup.cashFlowEntry.update({
          where: { id: LIVE_CFE },
          data: { categoria: ExpenseTypeLabels.MAO_DE_OBRA },
        });
        break;
      case "card origin":
        await setup.expense.update({
          where: { id: SOURCE },
          data: { cardLast4: "0705", importId: ALT_IMPORT },
        });
        break;
      case "import identity":
        await setup.expense.update({
          where: { id: SOURCE },
          data: { importId: OTHER_IMPORT },
        });
        break;
      case "external/dedupe identity":
        await setup.expense.update({
          where: { id: SOURCE },
          data: {
            externalId: "synthetic-new-external",
            dedupeKeyStrong: "synthetic-new-strong",
            dedupeKeyNatural: "synthetic-new-natural",
          },
        });
        break;
      case "active CFE labels":
        await setup.cashFlowEntry.update({
          where: { id: LIVE_CFE },
          data: { subcategoria: "Synthetic relabel" },
        });
        break;
      case "active CFE replacement": {
        const original = await setup.cashFlowEntry.findUniqueOrThrow({
          where: { id: LIVE_CFE },
        });
        await setup.cashFlowEntry.update({
          where: { id: LIVE_CFE },
          data: { deletedAt: NOW },
        });
        await setup.cashFlowEntry.create({
          data: { ...original, id: `${LIVE_CFE}-replacement` },
        });
        break;
      }
      case "historical CFE":
        await setup.cashFlowEntry.update({
          where: { id: OLD_CFE },
          data: { valor: -7_777, data: new Date("2026-09-01") },
        });
        break;
      case "copied metadata":
        await setup.expense.update({
          where: { id: SOURCE },
          data: { titulo: "Synthetic changed", fornecedor: "Synthetic other" },
        });
        break;
      case "card calendar":
        await setup.creditCard.update({
          where: { id: CARD },
          data: { closingDay: 21, dueDay: 26 },
        });
    }
  }

  it.each<EligibleDrift>([
    "matching amount",
    "matching payment date",
    "purchase date",
    "classification",
    "card origin",
    "import identity",
    "external/dedupe identity",
    "active CFE labels",
    "active CFE replacement",
    "historical CFE",
    "copied metadata",
    "card calendar",
  ])(
    "fingerprint rejects otherwise-eligible %s drift WITHOUT a revision increment",
    async (kind) => {
      const old = await preview();
      await eligibleDrift(kind);
      expect(await source()).toHaveProperty(
        "refundPurposeRevision",
        old.revision,
      );
      // Fresh preview must succeed: an eligibility rejection cannot impersonate fingerprint protection.
      const fresh = await preview();
      expect(fresh.revision).toBe(old.revision);
      expect(fresh.fingerprint).not.toBe(old.fingerprint);
      await rejectApply(old);
      expect((await apply(fresh)).summary).toEqual(fresh.summary);
    },
  );

  it("source updatedAt alone is excluded, not confused with a financial revision", async () => {
    const plan = await preview();
    await setup.expense.update({
      where: { id: SOURCE },
      data: { updatedAt: new Date("2026-09-24") },
    });
    expect((await preview()).fingerprint).toBe(plan.fingerprint);
    expect((await apply(plan)).summary.allocationCents).toBe(-12_345);
  });

  it.each([undefined, "", "A".repeat(64), "g".repeat(64), "a".repeat(63)])(
    "malformed fingerprint %p is 400 without business writes",
    async (expectedFingerprint) => {
      await rejectApply(await preview(), { expectedFingerprint }, 400);
    },
  );

  it.each([undefined, -1, 0.5, "0"])(
    "malformed revision %p is rejected before business writes",
    async (expectedRevision) => {
      await rejectApply(await preview(), { expectedRevision }, 400);
    },
  );

  it("one negative cent is still a signed full-value credit", async () => {
    await setup.expense.update({
      where: { id: SOURCE },
      data: { valor: -1, valorTotal: -1 },
    });
    await setup.cashFlowEntry.update({
      where: { id: LIVE_CFE },
      data: { valor: -1 },
    });
    const applied = await apply(await preview());
    expect(applied.summary.allocationCents).toBe(-1);
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { expenseId: applied.targetExpenseId },
      }),
    ).toEqual([expect.objectContaining({ valor: -1, status: "PAGO" })]);
  });

  it.each([0, 1])(
    "an otherwise matching nonnegative amount %i is ineligible",
    async (valor) => {
      await setup.expense.update({
        where: { id: SOURCE },
        data: { valor, valorTotal: valor },
      });
      await setup.cashFlowEntry.update({
        where: { id: LIVE_CFE },
        data: { valor },
      });
      const before = await snapshot();
      const response = await http.post(endpoint, {
        data: { mode: "preview", ...intent },
      });
      expect([400, 409]).toContain(response.status());
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "amountCents",
    "tipoDespesa",
    "sourceExpenseId",
    "cardId",
    "targetExpenseId",
    "snapshot",
  ])(
    "rejects client-controlled %s rather than accepting a parallel financial recipe",
    async (field) => {
      await rejectApply(await preview(), { [field]: "synthetic-forged" }, 400);
    },
  );

  it("destination and room are bound to the fingerprint, not just authorized separately", async () => {
    const plan = await preview();
    await rejectApply(plan, { targetProjectId: R2 });
    await rejectApply(plan, { roomId: ROOM });
  });

  it("identical retry returns the same target and accepted fingerprint without writes", async () => {
    const plan = await preview();
    const first = await apply(plan);
    const before = await snapshot();
    expect(await apply(plan)).toEqual({ ...first, alreadyApplied: true });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["matching amount", "historical CFE"] as const)(
    "retry after success still checks %s evidence",
    async (kind) => {
      const plan = await preview();
      await apply(plan);
      await eligibleDrift(kind);
      expect(await source()).toHaveProperty(
        "refundPurposeRevision",
        plan.revision + 1,
      );
      await rejectApply(plan);
    },
  );

  it.each([
    "extra incoming link",
    "owned target value",
    "owned target classification",
  ] as const)("retry normalization does not conceal %s", async (kind) => {
    const plan = await preview();
    const applied = await apply(plan);
    if (kind === "extra incoming link") {
      await setup.expense.update({
        where: { id: PURCHASE },
        data: { linkedExpenseId: SOURCE },
      });
    } else {
      await setup.expense.update({
        where: { id: applied.targetExpenseId },
        data:
          kind === "owned target value"
            ? { valor: -15_000, valorTotal: -15_000 }
            : { tipoDespesa: "MAO_DE_OBRA" },
      });
    }
    await rejectApply(plan);
  });

  it("undo deletes only the owned projection; delayed apply and ABA cannot resurrect the old generation", async () => {
    const originalCash = await sourceCash();
    const plan = await preview();
    const first = await apply(plan);
    await undo(first.revision);
    expect(await sourceCash()).toEqual(originalCash);
    expect(await source()).toMatchObject({
      deletedAt: null,
      valorTotal: -12_345,
      linkedExpenseId: null,
      refundPurposeRevision: 2,
    });
    expect(
      await prisma.expense.findUnique({ where: { id: first.targetExpenseId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { expenseId: first.targetExpenseId },
      }),
    ).toEqual([]);
    expect(
      await setup.rateioAllocation.findMany({ where: { tenantId: T } }),
    ).toEqual([]);
    const beforeRepeat = await snapshot();
    const repeated = await http.delete(endpoint, {
      data: { expectedRevision: first.revision },
    });
    expect(repeated.status()).toBe(200);
    expect(await repeated.json()).toEqual({ revision: 2, alreadyUndone: true });
    expect(await snapshot()).toEqual(beforeRepeat);
    await rejectApply(plan);
    const second = await apply(await preview());
    expect(second.revision).toBe(3);
    expect(second.targetExpenseId).not.toBe(first.targetExpenseId);
    await rejectApply(plan);
  });

  it.each(["absent", "soft-deleted"] as const)(
    "does not invent or require an original purchase (%s)",
    async (kind) => {
      if (kind === "absent") {
        await setup.cashFlowEntry.deleteMany({
          where: { expenseId: PURCHASE },
        });
        await setup.expense.delete({ where: { id: PURCHASE } });
      } else {
        await setup.expense.update({
          where: { id: PURCHASE },
          data: { deletedAt: NOW },
        });
        await setup.cashFlowEntry.updateMany({
          where: { expenseId: PURCHASE },
          data: { deletedAt: NOW },
        });
      }
      const applied = await apply(await preview());
      expect(applied.summary.allocationCents).toBe(-12_345);
      for (const scope of [[P], [P, R], [R]]) {
        expect((await financial.getOverview(T, scope)).pagoTotal).toBe(-12_345);
        expect(await financial.getByCategory(T, scope)).toEqual([
          {
            key: "MATERIAL_CONSTRUCAO",
            label: ExpenseTypeLabels.MATERIAL_CONSTRUCAO,
            total: -12_345,
          },
        ]);
      }
    },
  );

  it("explicit original import/card identity wins over another card with the same last4", async () => {
    await setup.creditCard.create({
      data: {
        id: `${CARD}-duplicate`,
        tenantId: T,
        projectId: P,
        nickname: "Synthetic duplicate",
        institution: "ITAU",
        last4: "0704",
        closingDay: 1,
        dueDay: 5,
      },
    });
    const plan = await preview();
    expect(plan.summary.cardId).toBe(CARD);
    expect((await apply(plan)).summary.cardId).toBe(CARD);
  });

  it.each(["source scope", "target scope", "malformed grants"] as const)(
    "current database authorization defeats stale JWT claims (%s)",
    async (kind) => {
      const plan = await preview();
      await setup.user.update({
        where: { id: USER },
        data: {
          allowedProjects:
            kind === "malformed grants"
              ? "{}"
              : JSON.stringify(kind === "source scope" ? [R] : [P]),
        },
      });
      const before = await snapshot();
      const response = await http.post(endpoint, { data: applyBody(plan) });
      // The global project guard can deny the route before the child service's 404.
      expect(kind === "malformed grants" ? [401] : [403, 404]).toContain(
        response.status(),
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["deleted import", "deleted card", "cross-tenant import"] as const)(
    "explicit provenance is reauthorized before apply (%s)",
    async (kind) => {
      const plan = await preview();
      if (kind === "deleted import") {
        await setup.creditCardStatementImport.update({
          where: { id: IMPORT },
          data: { deletedAt: NOW },
        });
      } else if (kind === "deleted card") {
        await setup.creditCard.update({
          where: { id: CARD },
          data: { deletedAt: NOW },
        });
      } else {
        await setup.creditCardStatementImport.update({
          where: { id: IMPORT },
          data: { tenantId: `${T}-other` },
        });
      }
      try {
        await rejectApply(plan, {}, 404);
      } finally {
        if (kind === "cross-tenant import") {
          await setup.creditCardStatementImport.update({
            where: { id: IMPORT },
            data: { tenantId: T },
          });
        }
      }
    },
  );

  it("getRateio remains byte-identical to never-associated when the target is hidden", async () => {
    const never = await http.get(`/projects/${P}/expenses/${SOURCE}/rateio`);
    expect(never.status()).toBe(200);
    const baseline = await never.json();
    await apply(await preview());
    await setup.user.update({
      where: { id: USER },
      data: { allowedProjects: JSON.stringify([P]) },
    });
    const hidden = await http.get(`/projects/${P}/expenses/${SOURCE}/rateio`);
    expect(hidden.status()).toBe(200);
    expect(JSON.stringify(await hidden.json())).toBe(JSON.stringify(baseline));
  });

  it.each([
    ["PATCH", "", { valor: 1 }],
    ["PATCH", "", { tipoDespesa: "MOVIMENTACAO_INTERNA" }],
    ["PATCH", "", { recorrente: true }],
    ["PATCH", "", { creditCardId: ALT_CARD }],
    [
      "POST",
      "/ratear",
      { allocations: [{ targetExpenseId: PURCHASE, allocation: 12_345 }] },
    ],
  ] as const)(
    "associated source blocks unsafe %s %s %j atomically",
    async (method, suffix, data) => {
      await apply(await preview());
      const before = await snapshot();
      const response = await http.fetch(
        `/projects/${P}/expenses/${SOURCE}${suffix}`,
        { method, data },
      );
      expect([400, 409]).toContain(response.status());
      expect(await snapshot()).toEqual(before);
    },
  );

  it("direct target deletion cannot leave a linked independent negative expense", async () => {
    const applied = await apply(await preview());
    const before = await snapshot();
    const response = await http.delete(
      `/projects/${R}/expenses/${applied.targetExpenseId}`,
    );
    expect([400, 409]).toContain(response.status());
    expect(await snapshot()).toEqual(before);
  });

  it("ordinary create and rateio must not inherit the dedicated signed-credit exception", async () => {
    const targetId = `${T}-ordinary-target`;
    await setup.expense.create({
      data: {
        id: targetId,
        tenantId: T,
        projectId: R,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: 12_345,
        quantidade: 1,
        valorTotal: 12_345,
        formaPagamento: "A_VISTA",
        dataPagamento: PAYMENT_DATE,
        status: "PLANEJADO",
      },
    });
    await setup.cashFlowEntry.create({
      data: {
        tenantId: T,
        projectId: R,
        expenseId: targetId,
        valor: 12_345,
        tipo: "DESPESA",
        categoria: ExpenseTypeLabels.MATERIAL_CONSTRUCAO,
        data: PAYMENT_DATE,
        status: "PLANEJADO",
      },
    });
    const before = await snapshot();
    const ordinary = await http.post(`/projects/${R}/expenses`, {
      data: {
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: -123.45,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PAGO",
      },
    });
    expect(ordinary.status()).toBe(400);
    const rateio = await http.post(`/projects/${P}/expenses/${SOURCE}/ratear`, {
      data: {
        allocations: [{ targetExpenseId: targetId, allocation: -12_345 }],
      },
    });
    expect(rateio.status()).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("failure after allocation insertion rolls back source, owned target and all financial rows", async () => {
    const plan = await preview();
    const before = await snapshot();
    failAllocation = true;
    try {
      const response = await http.post(endpoint, { data: applyBody(plan) });
      expect(response.status()).toBe(500);
      expect(injected).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally {
      failAllocation = false;
    }
  });

  it("source import undo cleans the owned target after soft-deleting its source inside the transaction", async () => {
    const applied = await apply(await preview());
    const purchaseCash = await setup.cashFlowEntry.findMany({
      where: { expenseId: PURCHASE },
    });
    expect(await cards.undoImport(T, P, CARD, IMPORT, ACTOR)).toMatchObject({
      ok: true,
    });
    expect(
      await prisma.expense.findUnique({ where: { id: SOURCE } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await prisma.expense.findUnique({
        where: { id: applied.targetExpenseId },
      }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { expenseId: { in: [SOURCE, applied.targetExpenseId] } },
      }),
    ).toEqual([]);
    expect(
      await setup.rateioAllocation.findMany({ where: { tenantId: T } }),
    ).toEqual([]);
    expect(
      await prisma.expense.findUnique({ where: { id: PURCHASE } }),
    ).toMatchObject({ deletedAt: null, valorTotal: 50_000 });
    expect(
      await setup.cashFlowEntry.findMany({ where: { expenseId: PURCHASE } }),
    ).toEqual(purchaseCash);
  });

  it("the reversal core sees an already tombstoned source using real transaction middleware", async () => {
    const applied = await apply(await preview());
    await prisma.$transaction(async (tx) => {
      await tx.expense.delete({ where: { id: SOURCE } });
      await tx.cashFlowEntry.deleteMany({
        where: { expenseId: SOURCE, deletedAt: null },
      });
      expect(await tx.expense.findFirst({ where: { id: SOURCE } })).toBeNull();
      await conciliacao.reverseSourceLinks(
        tx,
        { tenantId: T, sourceExpenseId: SOURCE },
        ACTOR,
      );
    });
    expect(
      await prisma.expense.findUnique({
        where: { id: applied.targetExpenseId },
      }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { expenseId: applied.targetExpenseId },
      }),
    ).toEqual([]);
    expect(
      await setup.rateioAllocation.findMany({ where: { tenantId: T } }),
    ).toEqual([]);
  });

  it("50,000 purchase minus 12,345 credit stays 37,655 in invoice and scoped totals", async () => {
    const beforeInvoice = await monthly.getCardInvoicesYearly(
      T,
      P,
      2026,
      ACTOR,
    );
    const beforeAccount = await monthly.getAccountView(T, P, "2026-09", ACTOR);
    const beforeOther = await otherFinancialRows();
    const applied = await apply(await preview());
    const afterInvoice = await monthly.getCardInvoicesYearly(T, P, 2026, ACTOR);
    expect(afterInvoice).toEqual(beforeInvoice);
    expect(
      afterInvoice.months.find((month) => month.mes === "2026-09")?.total,
    ).toBe(37_655);
    const afterAccount = await monthly.getAccountView(T, P, "2026-09", ACTOR);
    expect(afterAccount.caixaHoje).toBe(beforeAccount.caixaHoje);
    expect(afterAccount.carteiraHoje).toBe(beforeAccount.carteiraHoje);
    expect(
      afterAccount.saidas.filter(
        (row) =>
          row.id === applied.targetExpenseId ||
          (typeof row.id === "string" &&
            row.id.startsWith(`${applied.targetExpenseId}#`)) ||
          ("foreignExpenseId" in row &&
            row.foreignExpenseId === applied.targetExpenseId),
      ),
    ).toEqual([]);
    expect(await budget.getSummary(R, T)).toMatchObject({
      totalSpent: -12_345,
      totalReceived: 0,
    });
    for (const [scope, expected] of [
      [[P], 37_655],
      [[P, R], 37_655],
      [[R], -12_345],
    ] as const) {
      expect((await financial.getOverview(T, [...scope])).pagoTotal).toBe(
        expected,
      );
    }
    expect(await otherFinancialRows()).toEqual(beforeOther);
  });

  it.each(["same target", "different targets"] as const)(
    "two real clients racing for %s never create two owned credits",
    async (kind) => {
      const cashBefore = await sourceCash();
      const otherBefore = await otherFinancialRows();
      const a = await preview();
      const b =
        kind === "same target"
          ? a
          : await preview({ targetProjectId: R2 }, secondHttp);
      const responses = await Promise.all([
        http.post(endpoint, { data: applyBody(a) }),
        secondHttp.post(endpoint, { data: applyBody(b) }),
      ]);
      expect(responses.some((response) => response.status() === 201)).toBe(
        true,
      );
      for (const response of responses)
        expect([201, 409]).toContain(response.status());
      if (kind === "different targets") {
        expect(
          responses.filter((response) => response.status() === 201),
        ).toHaveLength(1);
      }
      const allocations = await setup.rateioAllocation.findMany({
        where: { tenantId: T },
      });
      expect(allocations).toEqual([
        expect.objectContaining({ allocation: -12_345, isRefundCredit: true }),
      ]);
      expect(
        await prisma.expense.count({
          where: { tenantId: T, projectId: { in: [R, R2] }, deletedAt: null },
        }),
      ).toBe(1);
      expect(
        await prisma.cashFlowEntry.count({
          where: { expenseId: SOURCE, deletedAt: null },
        }),
      ).toBe(1);
      expect(await sourceCash()).toEqual(cashBefore);
      expect(await otherFinancialRows()).toEqual(otherBefore);
      for (const [index, response] of responses.entries()) {
        if (response.status() !== 201) continue;
        const body: unknown = await response.json();
        assertApplied(body);
        expect(body.targetExpenseId).toBe(allocations[0].targetExpenseId);
        expect(body.fingerprint).toBe([a, b][index].fingerprint);
        expect(body.summary).toEqual([a, b][index].summary);
      }
      if (kind === "same target") {
        const retry = await apply(a);
        expect(retry.targetExpenseId).toBe(allocations[0].targetExpenseId);
        expect(retry.alreadyApplied).toBe(true);
      }
    },
  );

  it("unlink racing with an old apply leaves no reactivated owned credit", async () => {
    const cashBefore = await sourceCash();
    const plan = await preview();
    const applied = await apply(plan);
    const [removed, retried] = await Promise.all([
      http.delete(endpoint, { data: { expectedRevision: applied.revision } }),
      secondHttp.post(endpoint, { data: applyBody(plan) }),
    ]);
    expect([200, 409]).toContain(removed.status());
    expect([201, 409]).toContain(retried.status());
    if (removed.status() === 409) await undo(applied.revision);
    expect(
      await setup.rateioAllocation.findMany({ where: { tenantId: T } }),
    ).toEqual([]);
    expect(
      await prisma.expense.count({
        where: { tenantId: T, projectId: { in: [R, R2] }, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await setup.expense.findUnique({
        where: { id: applied.targetExpenseId },
      }),
    ).toMatchObject({ deletedAt: expect.any(Date), valorTotal: -12_345 });
    expect(await sourceCash()).toEqual(cashBefore);
    expect(await source()).toMatchObject({
      deletedAt: null,
      linkedExpenseId: null,
      valorTotal: -12_345,
      refundPurposeRevision: 2,
    });
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { tenantId: T, projectId: { in: [R, R2] } },
      }),
    ).toEqual([]);
    await rejectApply(plan);
  });

  it("association racing with source import undo cannot strand an owned target", async () => {
    const plan = await preview();
    const [associated, removed] = await Promise.allSettled([
      http.post(endpoint, { data: applyBody(plan) }),
      secondCards.undoImport(T, P, CARD, IMPORT, ACTOR),
    ]);
    if (associated.status === "rejected") throw associated.reason;
    expect([201, 404, 409]).toContain(associated.value.status());
    if (removed.status === "rejected") {
      expect(removed.reason).toMatchObject({ status: 409 });
      await cards.undoImport(T, P, CARD, IMPORT, ACTOR);
    }
    expect(
      await prisma.expense.findFirst({ where: { id: SOURCE } }),
    ).toBeNull();
    expect(
      await prisma.expense.count({
        where: { tenantId: T, projectId: { in: [R, R2] }, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await setup.rateioAllocation.findMany({ where: { tenantId: T } }),
    ).toEqual([]);
    expect(
      await prisma.cashFlowEntry.findMany({
        where: {
          tenantId: T,
          OR: [{ projectId: { in: [R, R2] } }, { expenseId: SOURCE }],
        },
      }),
    ).toEqual([]);
  });
});
