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
  makeBankAccountService,
  makeMonthlyOverviewService,
  resetTenant,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { PrismaService } from "../prisma/prisma.service";
import { ExpenseController } from "./expense.controller";
import { ExpenseService } from "./expense.service";
import { PaidOriginsService } from "./paid-origins.service";

const TENANT = "qa702-adversarial";
const FOREIGN_TENANT = `${TENANT}-foreign`;
const PESSOAL = `${TENANT}-pessoal`;
const SECOND_PESSOAL = `${TENANT}-second-pessoal`;
const TARGET_PROJECT = `${TENANT}-obra`;
const FOREIGN_PROJECT = `${TENANT}-foreign-project`;
const USER = `${TENANT}-user`;
const ACCOUNT = `${TENANT}-bank`;
const DUPLICATE_ACCOUNT = `${TENANT}-same-last4`;
const SECOND_ACCOUNT = `${TENANT}-second-bank`;
const FOREIGN_ACCOUNT = `${TENANT}-foreign-bank`;
const IMPORT = `${TENANT}-import`;
const SECOND_IMPORT = `${TENANT}-second-import`;
const FOREIGN_IMPORT = `${TENANT}-foreign-import`;
const SOURCE_A = `${TENANT}-a`;
const SOURCE_B = `${TENANT}-b`;
const SOURCE_C = `${TENANT}-c`;
const TARGET = `${TENANT}-target`;
const OTHER_TARGET = `${TENANT}-other-target`;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const DUE = new Date("2026-09-20T00:00:00.000Z");
const REQUESTER = {
  id: USER,
  role: "USER",
  allowedProjects: [PESSOAL, SECOND_PESSOAL, TARGET_PROJECT],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses", "bankAccounts", "monthlyOverview"],
};

interface FundingResponse {
  ok: true;
  settlementId: string;
  state: "ACTIVE" | "REVERSED";
  replayed: boolean;
  sourceId: string;
  targetId: string;
  parcelaIndex: number;
  amountCents: number;
  contractedCents: number;
  paidCents: number;
  remainingCents: number;
  sourceAvailableCents: number;
  settlementStatus: "UNPAID" | "PARTIAL" | "PAID";
}

function assertFunding(value: unknown): asserts value is FundingResponse {
  expect(value).toMatchObject({
    ok: true,
    settlementId: expect.any(String),
    state: expect.stringMatching(/^(ACTIVE|REVERSED)$/),
    replayed: expect.any(Boolean),
    sourceId: expect.any(String),
    targetId: expect.any(String),
    parcelaIndex: expect.any(Number),
    amountCents: expect.any(Number),
    contractedCents: expect.any(Number),
    paidCents: expect.any(Number),
    remainingCents: expect.any(Number),
    sourceAvailableCents: expect.any(Number),
    settlementStatus: expect.stringMatching(/^(UNPAID|PARTIAL|PAID)$/),
  });
}

function command(
  amountCents: number,
  requestId: string,
  targetExpenseId = TARGET,
  parcelaIndex = 0,
) {
  return {
    mode: "ADDITIVE" as const,
    targetExpenseId,
    parcelaIndex,
    amountCents,
    requestId,
  };
}

function projectOf(source: string) {
  return source === SOURCE_B ? SECOND_PESSOAL : PESSOAL;
}

function route(source = SOURCE_A) {
  return `/projects/${projectOf(source)}/expenses/${source}/conciliar-parcela`;
}

describe("#702 additive funding adversarial contract (real Prisma and HTTP)", () => {
  // Raw Prisma is limited to synthetic setup, drift injection and complete snapshots.
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const secondPrisma = new PrismaService();
  const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
  const secondExpenses = new ExpenseService(
    secondPrisma,
    new ConciliacaoService(secondPrisma),
  );
  const monthly = makeMonthlyOverviewService(prisma);
  const bank = makeBankAccountService(prisma);
  let app: INestApplication;
  let http: APIRequestContext;
  let injectFailure = false;
  let insertedContribution = false;
  let injectedFailure = false;

  prisma.$use(async (params, next) => {
    if (
      injectFailure &&
      params.model === "CrossProjectSettlement" &&
      ["create", "upsert"].includes(params.action)
    ) {
      const result = await next(params);
      insertedContribution = true;
      return result;
    }
    if (
      injectFailure &&
      insertedContribution &&
      params.model === "CashFlowEntry" &&
      ["create", "createMany", "update", "updateMany"].includes(params.action)
    ) {
      injectedFailure = true;
      throw new Error("qa702 injected projection failure");
    }
    return next(params);
  });

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
    await prisma.$connect();
    await secondPrisma.$connect();
    const module = await Test.createTestingModule({
      controllers: [ExpenseController],
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: ExpenseService, useValue: expenses },
        {
          provide: PaidOriginsService,
          useValue: new PaidOriginsService(prisma),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    const reflector = new Reflector();
    app.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new RolesGuard(reflector),
      new ModulesGuard(reflector, prisma),
      new ProjectAccessGuard(prisma),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0, "127.0.0.1");
    const jwt = new JwtService({
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
    });
    // Deliberately generous token claims: persisted grants, not the token, own access.
    const token = jwt.sign({
      sub: USER,
      tenantId: TENANT,
      sv: 0,
      role: "ADMIN",
      allowedProjects: [],
      allowedModules: ["expenses", "bankAccounts"],
    });
    http = await playwrightRequest.newContext({
      baseURL: await app.getUrl(),
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
  });

  async function clean() {
    await setup.user.deleteMany({
      where: { tenantId: { in: [TENANT, FOREIGN_TENANT] } },
    });
    await resetTenant(setup, TENANT);
    await resetTenant(setup, FOREIGN_TENANT);
  }

  async function seedExpense(
    id: string,
    projectId: string,
    amount: number,
    date: Date,
    paid: boolean,
    accountId: string | null = null,
    bankLast4: string | null = null,
    importId: string | null = null,
  ) {
    await setup.expense.create({
      data: {
        id,
        tenantId: TENANT,
        projectId,
        tipoDespesa: "MAO_DE_OBRA",
        titulo: `Synthetic ${id}`,
        fornecedor: "Synthetic supplier",
        valor: amount,
        quantidade: 1,
        valorTotal: amount,
        formaPagamento: "A_VISTA",
        dataPagamento: date,
        dataCompra: date,
        status: paid ? "PAGO" : "PLANEJADO",
        accountId,
        bankLast4,
        importId,
        externalId: importId ? `synthetic-external-${id}` : null,
      },
    });
    await setup.cashFlowEntry.create({
      data: {
        id: `${id}-cash`,
        tenantId: TENANT,
        projectId,
        expenseId: id,
        tipo: "DESPESA",
        categoria: ExpenseTypeLabels.MAO_DE_OBRA,
        valor: amount,
        data: date,
        formaPagamento: "A_VISTA",
        status: paid ? "PAGO" : "PLANEJADO",
      },
    });
  }

  beforeEach(async () => {
    injectFailure = insertedContribution = injectedFailure = false;
    await clean();
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    await seedPessoal(setup, {
      tenantId: FOREIGN_TENANT,
      projectId: FOREIGN_PROJECT,
    });
    await setup.project.createMany({
      data: [
        {
          id: SECOND_PESSOAL,
          tenantId: TENANT,
          name: "Second personal",
          type: "PESSOAL",
        },
        {
          id: TARGET_PROJECT,
          tenantId: TENANT,
          name: "Synthetic work",
          type: "REFORMA",
        },
      ],
    });
    await setup.user.create({
      data: {
        id: USER,
        tenantId: TENANT,
        username: USER,
        name: "Synthetic QA",
        role: "USER",
        allowedProjects: JSON.stringify(REQUESTER.allowedProjects),
        allowedProjectTypes: JSON.stringify(REQUESTER.allowedProjectTypes),
        allowedModules: JSON.stringify(REQUESTER.allowedModules),
        lastActivityAt: NOW,
      },
    });
    await setup.bankAccount.createMany({
      data: [
        {
          id: ACCOUNT,
          tenantId: TENANT,
          projectId: PESSOAL,
          nickname: "Original import bank",
          institution: "ITAU",
          last4: "0702",
        },
        {
          id: DUPLICATE_ACCOUNT,
          tenantId: TENANT,
          projectId: PESSOAL,
          nickname: "Ambiguous last4",
          institution: "ITAU",
          last4: "0702",
        },
        {
          id: SECOND_ACCOUNT,
          tenantId: TENANT,
          projectId: SECOND_PESSOAL,
          nickname: "Other source",
          institution: "ITAU",
          last4: "0703",
        },
        {
          id: FOREIGN_ACCOUNT,
          tenantId: FOREIGN_TENANT,
          projectId: FOREIGN_PROJECT,
          nickname: "Foreign",
          institution: "ITAU",
          last4: "0702",
        },
      ],
    });
    await setup.bankStatementImport.createMany({
      data: [
        {
          id: IMPORT,
          tenantId: TENANT,
          accountId: ACCOUNT,
          periodLabel: "2026-09",
          source: "OFX",
          status: "COMPLETED",
        },
        {
          id: SECOND_IMPORT,
          tenantId: TENANT,
          accountId: SECOND_ACCOUNT,
          periodLabel: "2026-09",
          source: "OFX",
          status: "COMPLETED",
        },
        {
          id: FOREIGN_IMPORT,
          tenantId: FOREIGN_TENANT,
          accountId: FOREIGN_ACCOUNT,
          periodLabel: "2026-09",
          source: "OFX",
          status: "COMPLETED",
        },
      ],
    });
    await seedExpense(
      SOURCE_A,
      PESSOAL,
      50_000,
      new Date("2026-09-10"),
      true,
      null,
      "0702",
      IMPORT,
    );
    await seedExpense(
      SOURCE_B,
      SECOND_PESSOAL,
      50_000,
      new Date("2026-09-11"),
      true,
      SECOND_ACCOUNT,
      "0703",
      SECOND_IMPORT,
    );
    await seedExpense(
      SOURCE_C,
      PESSOAL,
      80_000,
      new Date("2026-09-12"),
      true,
      ACCOUNT,
      "0702",
    );
    await seedExpense(TARGET, TARGET_PROJECT, 80_000, DUE, false);
    await seedExpense(OTHER_TARGET, TARGET_PROJECT, 80_000, DUE, false);
  });

  afterAll(async () => {
    injectFailure = false;
    await http?.dispose();
    await app?.close();
    await clean();
    await secondPrisma.$disconnect();
    await prisma.$disconnect();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  async function snapshot() {
    const where = { tenantId: { in: [TENANT, FOREIGN_TENANT] } };
    const orderBy = { id: "asc" as const };
    return {
      expenses: await setup.expense.findMany({ where, orderBy }),
      entries: await setup.cashFlowEntry.findMany({ where, orderBy }),
      settlements: await setup.crossProjectSettlement.findMany({
        where,
        orderBy,
      }),
      allocations: await setup.rateioAllocation.findMany({ where, orderBy }),
      imports: await setup.bankStatementImport.findMany({ where, orderBy }),
      ledger: await setup.importedInvoiceLiquidation.findMany({
        where,
        orderBy,
      }),
      receipts: await setup.receipt.findMany({ where, orderBy }),
      accounts: await setup.bankAccount.findMany({ where, orderBy }),
    };
  }

  async function sourceSnapshot() {
    return {
      expenses: await setup.expense.findMany({
        where: { id: { in: [SOURCE_A, SOURCE_B, SOURCE_C] } },
        orderBy: { id: "asc" },
      }),
      entries: await setup.cashFlowEntry.findMany({
        where: { projectId: { in: [PESSOAL, SECOND_PESSOAL] } },
        orderBy: { id: "asc" },
      }),
    };
  }

  async function apply(
    source = SOURCE_A,
    amount = 20_000,
    key = "qa702-first",
    target = TARGET,
    index = 0,
  ): Promise<FundingResponse> {
    const response = await http.post(route(source), {
      data: command(amount, key, target, index),
    });
    expect(response.status()).toBe(201);
    const body: unknown = await response.json();
    assertFunding(body);
    expect(body.paidCents + body.remainingCents).toBe(body.contractedCents);
    expect(body.sourceAvailableCents).toBeGreaterThanOrEqual(0);
    return body;
  }

  async function applyOn(
    service: ExpenseService,
    source: string,
    amount: number,
    key: string,
    target = TARGET,
  ): Promise<FundingResponse> {
    const body: unknown = await service.conciliarParcela(
      TENANT,
      projectOf(source),
      source,
      command(amount, key, target),
      REQUESTER,
    );
    assertFunding(body);
    return body;
  }

  async function undo(
    source: string,
    settlementId: string,
  ): Promise<FundingResponse> {
    const response = await http.delete(`${route(source)}/${settlementId}`);
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    assertFunding(body);
    return body;
  }

  async function assertRejected(
    body: Record<string, unknown>,
    status: number,
    source = SOURCE_A,
  ) {
    const before = await snapshot();
    const response = await http.post(route(source), { data: body });
    expect(response.status()).toBe(status);
    expect(await snapshot()).toEqual(before);
  }

  async function seedSiblingInstallments() {
    await setup.expense.update({
      where: { id: TARGET },
      data: {
        valor: 240_000,
        valorTotal: 240_000,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 3,
        dataPagamento: null,
        dataInicioParcela: DUE,
        paidParcelas: "[1]",
      },
    });
    await setup.cashFlowEntry.update({
      where: { id: `${TARGET}-cash` },
      data: { formaPagamento: "PARCELADO", parcela: "1/3" },
    });
    await setup.cashFlowEntry.createMany({
      data: [1, 2].map((index) => ({
        id: `${TARGET}-sibling-${index}`,
        tenantId: TENANT,
        projectId: TARGET_PROJECT,
        expenseId: TARGET,
        tipo: "DESPESA",
        categoria: ExpenseTypeLabels.MAO_DE_OBRA,
        valor: 80_000,
        data: new Date(Date.UTC(2026, 8 + index, 20)),
        formaPagamento: "PARCELADO",
        parcela: `${index + 1}/3`,
        status: index === 1 ? "PAGO" : "PLANEJADO",
      })),
    });
  }

  it("IMPORT-FIRST: an imported debit with null accountId and duplicate last4 remains immutable", async () => {
    const sources = await sourceSnapshot();
    const pending = await setup.cashFlowEntry.findUniqueOrThrow({
      where: { id: `${TARGET}-cash` },
    });
    const target = await setup.expense.findUniqueOrThrow({
      where: { id: TARGET },
    });
    const response = await http.post(route(), {
      data: command(20_000, "qa702-import-first"),
    });
    expect(response.status()).toBe(201);
    // Behavioral baseline RED: legacy replacement pays the whole target and links the source.
    expect(
      await prisma.expense.findUniqueOrThrow({ where: { id: TARGET } }),
    ).toMatchObject({
      valor: target.valor,
      quantidade: target.quantidade,
      valorTotal: 80_000,
      dataPagamento: DUE,
      status: "PLANEJADO",
      paidParcelas: null,
    });
    const afterPending = await setup.cashFlowEntry.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(afterPending).toEqual({
      ...pending,
      valor: 60_000,
      updatedAt: afterPending.updatedAt,
    });
    const paid = await prisma.cashFlowEntry.findMany({
      where: { expenseId: TARGET, status: "PAGO" },
    });
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      valor: 20_000,
      data: new Date("2026-09-10"),
      projectId: TARGET_PROJECT,
    });
    expect(await sourceSnapshot()).toEqual(sources);
    expect(await response.json()).toMatchObject({
      ok: true,
      state: "ACTIVE",
      replayed: false,
      contractedCents: 80_000,
      paidCents: 20_000,
      remainingCents: 60_000,
      sourceAvailableCents: 30_000,
      settlementStatus: "PARTIAL",
    });
  });

  it("without import or explicit identity, duplicate last4 fails loud instead of choosing a bank", async () => {
    await setup.expense.update({
      where: { id: SOURCE_A },
      data: { importId: null },
    });
    await assertRejected(command(20_000, "qa702-ambiguous"), 409);
  });

  it.each([
    "missing import",
    "foreign import",
    "deleted import",
    "deleted bank",
    "foreign bank",
    "other-project bank",
  ] as const)(
    "invalid explicit provenance (%s) never falls back to matching last4",
    async (kind) => {
      if (kind === "missing import" || kind === "foreign import") {
        await setup.expense.update({
          where: { id: SOURCE_A },
          data: {
            importId:
              kind === "missing import"
                ? "qa702-missing-import"
                : FOREIGN_IMPORT,
          },
        });
      } else if (kind === "deleted import") {
        await setup.bankStatementImport.update({
          where: { id: IMPORT },
          data: { deletedAt: NOW },
        });
      } else if (kind === "deleted bank") {
        await setup.bankAccount.update({
          where: { id: ACCOUNT },
          data: { deletedAt: NOW },
        });
      } else {
        await setup.bankStatementImport.update({
          where: { id: IMPORT },
          data: {
            accountId:
              kind === "foreign bank" ? FOREIGN_ACCOUNT : SECOND_ACCOUNT,
          },
        });
      }
      const before = await snapshot();
      const response = await http.post(route(), {
        data: command(20_000, "qa702-bad-provenance"),
      });
      // Provenance can be denied or reported as drift, but cannot silently use the spare bank.
      expect([404, 409]).toContain(response.status());
      expect(await snapshot()).toEqual(before);
    },
  );

  it("transactional authorization re-reads grants even when a service caller supplies stale access", async () => {
    await setup.user.update({
      where: { id: USER },
      data: { allowedProjects: JSON.stringify([PESSOAL, SECOND_PESSOAL]) },
    });
    const before = await snapshot();
    await expect(
      expenses.conciliarParcela(
        TENANT,
        PESSOAL,
        SOURCE_A,
        command(20_000, "qa702-stale-service"),
        REQUESTER,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });

  it("HTTP ignores stale ADMIN JWT claims after the current user's child-project grant is revoked", async () => {
    await setup.user.update({
      where: { id: USER },
      data: { allowedProjects: JSON.stringify([PESSOAL, SECOND_PESSOAL]) },
    });
    await assertRejected(command(20_000, "qa702-stale-jwt"), 404);
  });

  it("revoked source-bank capability cannot be restored by stale service claims", async () => {
    await setup.user.update({
      where: { id: USER },
      data: {
        allowedModules: '["expenses"]',
        allowedProjectTypes: '["REFORMA"]',
      },
    });
    const before = await snapshot();
    await expect(
      expenses.conciliarParcela(
        TENANT,
        PESSOAL,
        SOURCE_A,
        command(20_000, "qa702-revoked-bank"),
        REQUESTER,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "allowedProjects",
    "allowedModules",
    "allowedProjectTypes",
  ] as const)(
    "malformed persisted %s fails closed even with a valid stale requester",
    async (field) => {
      await setup.user.update({ where: { id: USER }, data: { [field]: "{}" } });
      const before = await snapshot();
      await expect(
        expenses.conciliarParcela(
          TENANT,
          PESSOAL,
          SOURCE_A,
          command(20_000, "qa702-malformed"),
          REQUESTER,
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    null,
    undefined,
    0,
    -1,
    0.5,
    "20000",
    2_147_483_648,
    Number.MAX_SAFE_INTEGER,
  ])("rejects invalid centavos %p atomically", async (amountCents) => {
    await assertRejected(
      { ...command(20_000, "qa702-invalid-money"), amountCents },
      400,
    );
  });

  it.each([-1, 0.5, 1, null, undefined])(
    "never clamps invalid occurrence index %p",
    async (parcelaIndex) => {
      await assertRejected(
        { ...command(20_000, "qa702-invalid-index"), parcelaIndex },
        400,
      );
    },
  );

  it("rejects the competing legacy amount field in additive mode", async () => {
    await assertRejected(
      { ...command(20_000, "qa702-two-amounts"), realValor: 1 },
      400,
    );
  });

  it("source capacity is shared across targets and cannot be exceeded by one cent", async () => {
    const sources = await sourceSnapshot();
    expect(await apply(SOURCE_A, 30_000)).toMatchObject({
      sourceAvailableCents: 20_000,
    });
    await assertRejected(
      command(20_001, "qa702-too-much-source", OTHER_TARGET),
      409,
    );
    expect(
      await apply(SOURCE_A, 20_000, "qa702-rest-source", OTHER_TARGET),
    ).toMatchObject({ paidCents: 20_000, sourceAvailableCents: 0 });
    expect(await sourceSnapshot()).toEqual(sources);
  });

  it("rejects one cent over target remainder even when the source can afford it", async () => {
    await apply();
    await assertRejected(command(60_001, "qa702-over-target"), 409, SOURCE_C);
  });

  it("one cent is a payment, not zero or an invoice tolerance", async () => {
    await setup.expense.update({
      where: { id: TARGET },
      data: { valor: 1, valorTotal: 1 },
    });
    await setup.cashFlowEntry.update({
      where: { id: `${TARGET}-cash` },
      data: { valor: 1 },
    });
    expect(await apply(SOURCE_A, 1)).toMatchObject({
      contractedCents: 1,
      paidCents: 1,
      remainingCents: 0,
      sourceAvailableCents: 49_999,
      settlementStatus: "PAID",
    });
    await assertRejected(command(1, "qa702-over-one-cent"), 409, SOURCE_B);
  });

  it("stable-key replay returns current balances, not the original response, with no financial writes", async () => {
    const a = await apply(SOURCE_A, 20_000, "qa702-idempotent");
    await apply(SOURCE_B, 20_000, "qa702-second");
    const before = await snapshot();
    expect(await apply(SOURCE_A, 20_000, "qa702-idempotent")).toEqual({
      ...a,
      replayed: true,
      paidCents: 40_000,
      remainingCents: 40_000,
    });
    expect(await snapshot()).toEqual(before);
    await assertRejected(command(20_000, "qa702-different-key"), 409);
    await assertRejected(command(19_999, "qa702-idempotent"), 409);
    await assertRejected(
      command(20_000, "qa702-idempotent", OTHER_TARGET),
      409,
    );
    await assertRejected(command(20_000, "qa702-idempotent"), 409, SOURCE_B);
  });

  it("a reused requestId cannot be moved to another valid installment index", async () => {
    await seedSiblingInstallments();
    await apply(SOURCE_A, 20_000, "qa702-same-key-index", TARGET, 0);
    await assertRejected(
      command(20_000, "qa702-same-key-index", TARGET, 2),
      409,
    );
  });

  it("apply and undo preserve sibling CFE IDs, dates, timestamps and existing paid indices", async () => {
    await seedSiblingInstallments();
    const siblings = () =>
      setup.cashFlowEntry.findMany({
        where: { id: { in: [`${TARGET}-sibling-1`, `${TARGET}-sibling-2`] } },
        orderBy: { id: "asc" },
      });
    const before = await siblings();
    const sources = await sourceSnapshot();
    const a = await apply(SOURCE_C, 80_000, "qa702-siblings");
    expect(await siblings()).toEqual(before);
    const paid = await prisma.expense.findUniqueOrThrow({
      where: { id: TARGET },
    });
    expect(paid).toMatchObject({
      status: "PLANEJADO",
      valor: 240_000,
      valorTotal: 240_000,
      quantidade: 1,
      quantidadeParcela: 3,
      dataInicioParcela: DUE,
    });
    expect(JSON.parse(paid.paidParcelas ?? "[]")).toEqual([0, 1]);
    await undo(SOURCE_C, a.settlementId);
    expect(await siblings()).toEqual(before);
    const undone = await prisma.expense.findUniqueOrThrow({
      where: { id: TARGET },
    });
    expect(JSON.parse(undone.paidParcelas ?? "[]")).toEqual([1]);
    expect(await sourceSnapshot()).toEqual(sources);
  });

  it("full payment tombstones and undo restores the SAME pending CFE through real middleware", async () => {
    const sources = await sourceSnapshot();
    const original = await setup.cashFlowEntry.findUniqueOrThrow({
      where: { id: `${TARGET}-cash` },
    });
    const applied = await apply(SOURCE_C, 80_000, "qa702-full");
    expect(applied).toMatchObject({
      settlementStatus: "PAID",
      remainingCents: 0,
    });
    expect(
      await prisma.cashFlowEntry.findFirst({ where: { id: original.id } }),
    ).toBeNull();
    expect(
      await prisma.cashFlowEntry.findUnique({ where: { id: original.id } }),
    ).toMatchObject({ id: original.id, deletedAt: expect.any(Date) });
    expect(await undo(SOURCE_C, applied.settlementId)).toMatchObject({
      state: "REVERSED",
      paidCents: 0,
      remainingCents: 80_000,
      sourceAvailableCents: 80_000,
      settlementStatus: "UNPAID",
    });
    const restored = await prisma.cashFlowEntry.findFirstOrThrow({
      where: { id: original.id },
    });
    expect(restored).toEqual({ ...original, updatedAt: restored.updatedAt });
    const beforeRetry = await snapshot();
    await undo(SOURCE_C, applied.settlementId);
    expect(await apply(SOURCE_C, 80_000, "qa702-full")).toMatchObject({
      settlementId: applied.settlementId,
      state: "REVERSED",
      replayed: true,
      paidCents: 0,
      remainingCents: 80_000,
    });
    expect(await snapshot()).toEqual(beforeRetry);
    await assertRejected(command(79_999, "qa702-full"), 409, SOURCE_C);
    const replacement = await apply(SOURCE_C, 80_000, "qa702-new-after-undo");
    expect(replacement.settlementId).not.toBe(applied.settlementId);
    expect(
      await setup.crossProjectSettlement.findMany({
        where: { tenantId: TENANT },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: applied.settlementId,
          mode: "ADDITIVE",
          reversedAt: expect.any(Date),
        }),
        expect.objectContaining({
          id: replacement.settlementId,
          mode: "ADDITIVE",
          reversedAt: null,
        }),
      ]),
    );
    expect(await sourceSnapshot()).toEqual(sources);
  });

  it("two independent Prisma clients cannot race past the target's final balance", async () => {
    const sources = await sourceSnapshot();
    const results = await Promise.allSettled([
      applyOn(expenses, SOURCE_A, 50_000, "qa702-race-a"),
      applyOn(secondExpenses, SOURCE_B, 50_000, "qa702-race-b"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 409 } });
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { expenseId: TARGET, status: "PAGO" },
      }),
    ).toEqual([expect.objectContaining({ valor: 50_000 })]);
    expect(
      await prisma.cashFlowEntry.findUnique({
        where: { id: `${TARGET}-cash` },
      }),
    ).toMatchObject({
      valor: 30_000,
      status: "PLANEJADO",
      deletedAt: null,
      data: DUE,
    });
    expect(
      await setup.crossProjectSettlement.count({ where: { tenantId: TENANT } }),
    ).toBe(1);
    expect(await sourceSnapshot()).toEqual(sources);
  });

  it("two targets racing for one source cannot jointly overspend its capacity", async () => {
    const sources = await sourceSnapshot();
    const results = await Promise.allSettled([
      applyOn(expenses, SOURCE_A, 30_000, "qa702-capacity-a"),
      applyOn(
        secondExpenses,
        SOURCE_A,
        30_000,
        "qa702-capacity-b",
        OTHER_TARGET,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 409 } });
    const rows = await setup.crossProjectSettlement.findMany({
      where: { tenantId: TENANT },
    });
    expect(rows).toEqual([
      expect.objectContaining({ realValor: 30_000, sourceExpenseId: SOURCE_A }),
    ]);
    expect(await sourceSnapshot()).toEqual(sources);
  });

  it("a concurrent same-key submission creates only one contribution and one paid projection", async () => {
    const sources = await sourceSnapshot();
    const outcomes = await Promise.allSettled([
      applyOn(expenses, SOURCE_A, 30_000, "qa702-same-key-race"),
      applyOn(secondExpenses, SOURCE_A, 30_000, "qa702-same-key-race"),
    ]);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ status: 409 });
      }
    }
    const replay = await apply(SOURCE_A, 30_000, "qa702-same-key-race");
    expect(replay).toMatchObject({
      replayed: true,
      paidCents: 30_000,
      remainingCents: 50_000,
      sourceAvailableCents: 20_000,
    });
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        expect(outcome.value.settlementId).toBe(replay.settlementId);
      }
    }
    expect(
      await setup.crossProjectSettlement.count({ where: { tenantId: TENANT } }),
    ).toBe(1);
    expect(
      await prisma.cashFlowEntry.findMany({
        where: { expenseId: TARGET, status: "PAGO" },
      }),
    ).toEqual([expect.objectContaining({ valor: 30_000 })]);
    expect(await sourceSnapshot()).toEqual(sources);
  });

  it("apply versus individual undo has a complete serial outcome and preserves the other source", async () => {
    const sources = await sourceSnapshot();
    const a = await apply(SOURCE_A, 40_000, "qa702-undo-race-a");
    const outcomes = await Promise.allSettled([
      http.delete(`${route(SOURCE_A)}/${a.settlementId}`),
      secondExpenses.conciliarParcela(
        TENANT,
        SECOND_PESSOAL,
        SOURCE_B,
        command(40_000, "qa702-undo-race-b"),
        REQUESTER,
      ),
    ]);
    // A typed contention conflict may be retried only as the entire same command.
    if (outcomes[0].status === "fulfilled") {
      expect([200, 409]).toContain(outcomes[0].value.status());
    } else {
      throw outcomes[0].reason;
    }
    if (outcomes[1].status === "rejected") {
      expect(outcomes[1].reason).toMatchObject({ status: 409 });
    }
    await undo(SOURCE_A, a.settlementId);
    expect(await apply(SOURCE_B, 40_000, "qa702-undo-race-b")).toMatchObject({
      paidCents: 40_000,
      remainingCents: 40_000,
      settlementStatus: "PARTIAL",
    });
    expect(
      await setup.crossProjectSettlement.findMany({
        where: { tenantId: TENANT },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: a.settlementId,
          reversedAt: expect.any(Date),
        }),
        expect.objectContaining({
          sourceExpenseId: SOURCE_B,
          reversedAt: null,
          realValor: 40_000,
        }),
      ]),
    );
    expect(
      await setup.crossProjectSettlement.count({ where: { tenantId: TENANT } }),
    ).toBe(2);
    expect(
      await prisma.cashFlowEntry.findUnique({
        where: { id: `${TARGET}-cash` },
      }),
    ).toMatchObject({
      valor: 40_000,
      status: "PLANEJADO",
      deletedAt: null,
      data: DUE,
    });
    expect(await sourceSnapshot()).toEqual(sources);
  });

  it("a real middleware failure after contribution insertion rolls back the entire transaction", async () => {
    const before = await snapshot();
    injectFailure = true;
    try {
      const response = await http.post(route(), {
        data: command(20_000, "qa702-rollback"),
      });
      expect(response.status()).toBe(500);
      expect(insertedContribution).toBe(true);
      expect(injectedFailure).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally {
      injectFailure = false;
    }
  });

  it.each([
    "projection tombstone",
    "projection value",
    "source value",
  ] as const)(
    "undo refuses altered provenance (%s), without guessing or repairing",
    async (kind) => {
      const a = await apply();
      const projection = await prisma.cashFlowEntry.findFirstOrThrow({
        where: { expenseId: TARGET, status: "PAGO" },
      });
      await setup.cashFlowEntry.update({
        where: {
          id: kind === "source value" ? `${SOURCE_A}-cash` : projection.id,
        },
        data:
          kind === "projection tombstone" ? { deletedAt: NOW } : { valor: 1 },
      });
      const before = await snapshot();
      expect((await http.delete(`${route()}/${a.settlementId}`)).status()).toBe(
        409,
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    ["PATCH", "", { valor: 1 }],
    ["PATCH", "", { status: "PAGO" }],
    ["PATCH", "", { formaPagamento: "PIX" }],
    ["PATCH", "/parcela", { parcela: 0, paid: true }],
    ["PATCH", "/parcela-data", { parcela: 0, data: "2026-09-24" }],
    ["POST", "/pay", {}],
    ["DELETE", "", undefined],
  ] as const)(
    "funded target rejects %s %s with no partial writes",
    async (method, suffix, data) => {
      await apply();
      const before = await snapshot();
      const response = await http.fetch(
        `/projects/${TARGET_PROJECT}/expenses/${TARGET}${suffix}`,
        { method, data },
      );
      expect(response.status()).toBe(409);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    ["PATCH", "", { valor: 1 }],
    ["PATCH", "", { status: "PLANEJADO" }],
    ["PATCH", "", { bankAccountId: DUPLICATE_ACCOUNT }],
    ["PATCH", "", { linkedExpenseId: OTHER_TARGET }],
    ["PATCH", "/parcela", { parcela: 0, paid: false }],
    ["POST", "/link", { targetExpenseId: OTHER_TARGET }],
    [
      "POST",
      "/ratear",
      { allocations: [{ targetExpenseId: OTHER_TARGET, allocation: 50_000 }] },
    ],
    ["DELETE", "", undefined],
  ] as const)(
    "funded source rejects %s %s with no partial writes",
    async (method, suffix, data) => {
      await apply();
      const before = await snapshot();
      const response = await http.fetch(
        `/projects/${PESSOAL}/expenses/${SOURCE_A}${suffix}`,
        { method, data },
      );
      expect(response.status()).toBe(409);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("import undo is blocked before touching even an unrelated debit in that batch", async () => {
    await setup.expense.update({
      where: { id: SOURCE_C },
      data: { importId: IMPORT },
    });
    await apply();
    const before = await snapshot();
    await expect(
      bank.undoImport(TENANT, PESSOAL, ACCOUNT, IMPORT, REQUESTER),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });

  it.each([SOURCE_A, TARGET])(
    "markPaidInPlace cannot bypass active funding for %s inside a real transaction",
    async (id) => {
      await apply();
      const before = await snapshot();
      await expect(
        prisma.$transaction((tx) =>
          expenses.markPaidInPlace(TENANT, id, NOW, tx),
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("replay and undo reauthorize every existing contributor before returning amounts", async () => {
    const a = await apply(SOURCE_A, 20_000, "qa702-revoke-a");
    await apply(SOURCE_B, 20_000, "qa702-revoke-b");
    await setup.user.update({
      where: { id: USER },
      data: { allowedProjects: JSON.stringify([PESSOAL, TARGET_PROJECT]) },
    });
    const before = await snapshot();
    expect(
      (
        await http.post(route(), { data: command(20_000, "qa702-revoke-a") })
      ).status(),
    ).toBe(404);
    expect((await http.delete(`${route()}/${a.settlementId}`)).status()).toBe(
      404,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("summaries and paid origins redact the ENTIRE contribution set if one participant is hidden", async () => {
    const a = await apply(SOURCE_A, 20_000, "qa702-read-a");
    const b = await apply(SOURCE_B, 20_000, "qa702-read-b");
    const path = `/projects/${TARGET_PROJECT}/expenses`;
    const visible = await http.get(`${path}/${TARGET}`);
    expect(visible.status()).toBe(200);
    const visibleBody = await visible.json();
    expect(visibleBody).toMatchObject({
      installmentSettlements: [
        {
          parcelaIndex: 0,
          dueDate: expect.any(String),
          contractedCents: 80_000,
          paidCents: 40_000,
          remainingCents: 40_000,
          settlementStatus: "PARTIAL",
          contributions: expect.arrayContaining([
            {
              settlementId: a.settlementId,
              sourceId: SOURCE_A,
              amountCents: 20_000,
              paymentDate: "2026-09-10T00:00:00.000Z",
            },
            {
              settlementId: b.settlementId,
              sourceId: SOURCE_B,
              amountCents: 20_000,
              paymentDate: "2026-09-11T00:00:00.000Z",
            },
          ]),
        },
      ],
    });
    expect(new Date(visibleBody.installmentSettlements[0].dueDate)).toEqual(
      DUE,
    );
    const origins = await http.get(`${path}/paid-origins`);
    expect(origins.status()).toBe(200);
    const originText = await origins.text();
    expect(originText).toContain(PESSOAL);
    expect(originText).toContain(SECOND_PESSOAL);
    await setup.user.update({
      where: { id: USER },
      data: { allowedProjects: JSON.stringify([PESSOAL, TARGET_PROJECT]) },
    });
    const hidden = await http.get(`${path}/${TARGET}`);
    expect(hidden.status()).toBe(200);
    const body = await hidden.json();
    expect(body).toMatchObject({
      installmentSettlements: [
        {
          parcelaIndex: 0,
          contractedCents: 80_000,
          paidCents: 40_000,
          remainingCents: 40_000,
          settlementStatus: "PARTIAL",
        },
      ],
    });
    expect(body.installmentSettlements[0]).not.toHaveProperty("contributions");
    expect(JSON.stringify(body)).not.toContain(a.settlementId);
    expect(JSON.stringify(body)).not.toContain(b.settlementId);
    expect(JSON.stringify(body)).not.toContain(SOURCE_A);
    expect(JSON.stringify(body)).not.toContain(SOURCE_B);
    expect(await (await http.get(`${path}/paid-origins`)).json()).toEqual({
      items: [],
    });
  });

  it("the occurrence summary remains UNPAID after the last individual undo", async () => {
    const a = await apply();
    await undo(SOURCE_A, a.settlementId);
    const response = await http.get(
      `/projects/${TARGET_PROJECT}/expenses/${TARGET}`,
    );
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      installmentSettlements: [
        {
          parcelaIndex: 0,
          contractedCents: 80_000,
          paidCents: 0,
          remainingCents: 80_000,
          settlementStatus: "UNPAID",
        },
      ],
    });
  });

  it("unknown source availability is absent rather than a fabricated zero", async () => {
    await setup.expense.update({
      where: { id: SOURCE_A },
      data: { importId: null },
    });
    const response = await http.get(
      `/projects/${PESSOAL}/expenses/${SOURCE_A}`,
    );
    expect(response.status()).toBe(200);
    expect(await response.json()).not.toHaveProperty("sourceAvailableCents");
  });

  it("monthly marks only the additive paid target as a projection; bank outflow is unchanged", async () => {
    const before = await monthly.getAccountView(
      TENANT,
      PESSOAL,
      "2026-09",
      REQUESTER,
    );
    const sources = await sourceSnapshot();
    await apply(SOURCE_A, 20_000);
    const after = await monthly.getAccountView(
      TENANT,
      PESSOAL,
      "2026-09",
      REQUESTER,
    );
    expect(after.saiuMes).toBe(before.saiuMes);
    expect(after.caixaHoje).toBe(before.caixaHoje);
    const overview = await monthly.getOverview(
      TENANT,
      PESSOAL,
      "2026-09",
      REQUESTER,
    );
    const paid = await prisma.cashFlowEntry.findFirstOrThrow({
      where: { expenseId: TARGET, status: "PAGO" },
    });
    expect(
      overview.entries.find((entry) => entry.id === paid.id),
    ).toMatchObject({
      isSettlementProjection: true,
      valor: 20_000,
      status: "PAGO",
    });
    expect(
      overview.entries.find((entry) => entry.id === `${TARGET}-cash`),
    ).toMatchObject({ valor: 60_000, status: "PLANEJADO" });
    for (const id of [
      `${SOURCE_A}-cash`,
      `${SOURCE_C}-cash`,
      `${TARGET}-cash`,
    ]) {
      const matches = overview.entries.filter((entry) => entry.id === id);
      expect(matches).toHaveLength(1);
      expect(matches[0]).not.toMatchObject({ isSettlementProjection: true });
    }
    expect(await sourceSnapshot()).toEqual(sources);
  });
});
