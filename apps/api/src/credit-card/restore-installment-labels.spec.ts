import {
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { request as playwrightRequest } from "@playwright/test";
import { PrismaService } from "../prisma/prisma.service";
import { RestoreInstallmentLabelsService } from "./restore-installment-labels.service";
import { RestoreInstallmentLabelsController } from "./restore-installment-labels.controller";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import {
  resetTenant,
  seedPessoal,
  seedCardWithClosingDue,
} from "../bank-account/__tests__/invoice-undo.fixtures";

describe("imported installment label restoration (real Prisma)", () => {
  const tenantId = "restore-labels-test";
  const projectId = "restore-labels-project";
  const requester = { id: "restore-labels-user", role: "ADMIN" };
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const service = new RestoreInstallmentLabelsService(prisma);
  let rejectSecondUpdate = false;
  let updates = 0;
  let events: string[] = [];
  prisma.$use(async (params, next) => {
    events.push(`${params.model ?? "raw"}:${params.action}`);
    if (
      rejectSecondUpdate &&
      params.model === "CashFlowEntry" &&
      params.action === "updateMany" &&
      ++updates === 2
    )
      params.args.where.id = "missing-row-for-rollback-test";
    return next(params);
  });
  let scope: {
    tenantId: string;
    projectId: string;
    cardId: string;
    importId: string;
    expenseId: string;
  };
  const date = (month: number) => new Date(Date.UTC(2026, month - 1, 10));
  const snapshot = async () => ({
    expense: await db.expense.findUniqueOrThrow({
      where: { id: scope.expenseId },
    }),
    entries: await db.cashFlowEntry.findMany({
      where: { expenseId: scope.expenseId },
      orderBy: { id: "asc" },
    }),
  });
  const preview = () => service.restore(scope, requester, { mode: "preview" });
  const apply = (fingerprint: string) =>
    service.restore(scope, requester, {
      mode: "apply",
      expectedFingerprint: fingerprint,
    });
  beforeEach(async () => {
    rejectSecondUpdate = false;
    updates = 0;
    events = [];
    await db.user.deleteMany({ where: { tenantId } });
    await resetTenant(db, tenantId);
    await seedPessoal(db, { tenantId, projectId });
    const card = await seedCardWithClosingDue(db, {
      tenantId,
      projectId,
      last4: "9876",
    });
    const batch = await db.creditCardStatementImport.create({
      data: {
        tenantId,
        cardId: card.id,
        source: "CSV_GENERIC",
        periodLabel: "2026-10",
      },
    });
    const expense = await db.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: "OUTROS",
        valor: 24690,
        quantidade: 1,
        valorTotal: 24690,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 2,
        dataInicioParcela: date(10),
        status: "PLANEJADO",
        importId: batch.id,
        externalId: "synthetic-transaction",
        seriesKey: `${card.id}|store a|12345|3`,
        cardLast4: card.last4,
        origin: "import",
      },
    });
    scope = {
      tenantId,
      projectId,
      cardId: card.id,
      importId: batch.id,
      expenseId: expense.id,
    };
    for (let index = 0; index < 2; index++) {
      const data = {
        tenantId,
        projectId,
        expenseId: expense.id,
        valor: 12345,
        tipo: "DESPESA",
        data: date(10 + index),
        categoria: "Outros",
        subcategoria: "Card nickname",
        formaPagamento: "CARTAO_CREDITO",
        status: "PLANEJADO",
      };
      await db.cashFlowEntry.create({
        data: {
          ...data,
          id: `restore-history-${index}`,
          parcela: `${index + 2}/3`,
          createdAt: date(8),
          deletedAt: date(9),
        },
      });
      await db.cashFlowEntry.create({
        data: {
          ...data,
          id: `restore-active-${index}`,
          parcela: `${index + 1}/2`,
          createdAt: date(9),
        },
      });
    }
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { tenantId } });
    await resetTenant(db, tenantId);
    await db.$disconnect();
    await prisma.$disconnect();
  });

  it("previews read-only, changes only active labels, and retries without writes", async () => {
    const before = await snapshot();
    const plan = await preview();
    expect(await snapshot()).toEqual(before);
    expect(plan.entries.map((row) => row.desiredLabel)).toEqual(["2/3", "3/3"]);
    expect(await apply(plan.fingerprint)).toMatchObject({
      changed: 2,
      alreadyRestored: false,
    });
    const after = await snapshot();
    expect(after.expense).toEqual(before.expense);
    for (const row of after.entries) {
      const old = before.entries.find((entry) => entry.id === row.id)!;
      expect(
        row.deletedAt
          ? row
          : { ...row, parcela: old.parcela, updatedAt: old.updatedAt },
      ).toEqual(old);
    }
    expect(
      after.entries.filter((row) => !row.deletedAt).map((row) => row.parcela),
    ).toEqual(["2/3", "3/3"]);
    expect(await apply(plan.fingerprint)).toMatchObject({
      changed: 0,
      alreadyRestored: true,
    });
    expect(await snapshot()).toEqual(after);
  });

  it("restores a last installment materialized as a single payment without adding rows", async () => {
    await db.cashFlowEntry.deleteMany({
      where: { id: { in: ["restore-active-0", "restore-history-0"] } },
    });
    await db.cashFlowEntry.update({
      where: { id: "restore-active-1" },
      data: { parcela: null },
    });
    await db.expense.update({
      where: { id: scope.expenseId },
      data: {
        valor: 12345,
        valorTotal: 12345,
        quantidadeParcela: null,
        formaPagamento: "A_VISTA",
        dataInicioParcela: null,
        dataPagamento: date(11),
      },
    });
    const plan = await preview();
    expect(await apply(plan.fingerprint)).toMatchObject({ changed: 1 });
    expect((await snapshot()).entries.map((row) => row.parcela)).toEqual([
      "3/3",
      "3/3",
    ]);
  });

  it("rejects stale fingerprints even after labels have been restored", async () => {
    const plan = await preview();
    await apply(plan.fingerprint);
    await db.expense.update({
      where: { id: scope.expenseId },
      data: { titulo: "changed" },
    });
    const before = await snapshot();
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("does not use partial-payment indices as evidence for a single payment", async () => {
    await db.cashFlowEntry.deleteMany({
      where: { id: { in: ["restore-active-0", "restore-history-0"] } },
    });
    await db.cashFlowEntry.updateMany({
      where: { expenseId: scope.expenseId },
      data: { status: "PAGO" },
    });
    await db.cashFlowEntry.update({
      where: { id: "restore-active-1" },
      data: { parcela: null },
    });
    await db.expense.update({
      where: { id: scope.expenseId },
      data: {
        valor: 12345,
        valorTotal: 12345,
        quantidadeParcela: null,
        formaPagamento: "A_VISTA",
        dataInicioParcela: null,
        dataPagamento: date(11),
        status: "PLANEJADO",
        paidParcelas: "[0]",
      },
    });
    const before = await snapshot();
    await expect(preview()).rejects.toBeInstanceOf(ConflictException);
    await expect(apply("a".repeat(64))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each(["split-generation", "history-metadata", "active-metadata"])(
    "revalidates independent historical/active evidence: %s",
    async (kind) => {
      const plan = await preview();
      await db.cashFlowEntry.update({
        where: {
          id:
            kind === "active-metadata"
              ? "restore-active-0"
              : "restore-history-0",
        },
        data:
          kind === "split-generation"
            ? { deletedAt: date(10) }
            : { subcategoria: "changed" },
      });
      const before = await snapshot();
      if (kind === "split-generation")
        await expect(preview()).rejects.toBeInstanceOf(ConflictException);
      await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "tenantId",
    "projectId",
    "cardId",
    "importId",
    "expenseId",
  ] as const)(
    "rejects missing/blank %s before evidence or reservation",
    async (key) => {
      const missingScope = { ...scope };
      Reflect.deleteProperty(missingScope, key);
      events = [];
      await expect(
        service.restore(missingScope, requester, { mode: "preview" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.restore({ ...scope, [key]: " " }, requester, {
          mode: "apply",
          expectedFingerprint: "a".repeat(64),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(events).toEqual([]);
    },
  );

  it.each([
    "allowedProjects",
    "allowedModules",
    "allowedProjectTypes",
  ] as const)("rejects missing %s before reading evidence", async (key) => {
    const user = {
      id: "test-user",
      role: "USER",
      allowedProjects: [projectId],
      allowedModules: ["creditCards", "expenses"],
      allowedProjectTypes: ["PESSOAL"],
    };
    Reflect.deleteProperty(user, key);
    events = [];
    await expect(
      service.restore(scope, user, { mode: "preview" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(events).toEqual([]);
  });

  it.each(["2/3", "99/99"])(
    "rejects mixed/arbitrary active labels (%s)",
    async (label) => {
      const plan = await preview();
      await db.cashFlowEntry.update({
        where: { id: "restore-active-0" },
        data: { parcela: label },
      });
      const before = await snapshot();
      await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "missing-history",
    "extra-history",
    "wrong-series",
    "no-active",
    "wrong-amount",
    "wrong-date",
  ])("rejects unsupported evidence: %s", async (kind) => {
    if (kind === "missing-history")
      await db.cashFlowEntry.delete({ where: { id: "restore-history-0" } });
    if (kind === "extra-history") {
      const row = await db.cashFlowEntry.findUniqueOrThrow({
        where: { id: "restore-history-0" },
      });
      await db.cashFlowEntry.create({
        data: { ...row, id: "restore-extra-history" },
      });
    }
    if (kind === "wrong-series")
      await db.expense.update({
        where: { id: scope.expenseId },
        data: { seriesKey: null },
      });
    if (kind === "no-active")
      await db.cashFlowEntry.deleteMany({
        where: { expenseId: scope.expenseId, deletedAt: null },
      });
    if (kind === "wrong-amount")
      await db.cashFlowEntry.update({
        where: { id: "restore-active-0" },
        data: { valor: 12346 },
      });
    if (kind === "wrong-date")
      await db.cashFlowEntry.update({
        where: { id: "restore-active-0" },
        data: { data: date(12) },
      });
    const before = await snapshot();
    await expect(preview()).rejects.toBeInstanceOf(ConflictException);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { mode: "preview", expectedFingerprint: "a".repeat(64) },
    null,
    [],
    { mode: "apply" },
    { mode: "apply", expectedFingerprint: "not-a-hash" },
    { mode: "preview", labels: ["2/3"] },
    { mode: "other" },
  ])("rejects malformed body %#", async (body) => {
    await expect(
      service.restore(scope, requester, body),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    "tenantId",
    "projectId",
    "cardId",
    "importId",
    "expenseId",
  ] as const)("hides wrong %s before evidence", async (key) => {
    await expect(
      service.restore({ ...scope, [key]: "not-found" }, requester, {
        mode: "preview",
      }),
    ).rejects.toMatchObject({ status: 404, message: "Recurso não encontrado" });
  });

  it("hides inaccessible projects and missing requesters", async () => {
    await expect(
      service.restore(
        scope,
        {
          id: "user",
          role: "USER",
          allowedModules: ["creditCards", "expenses"],
          allowedProjects: ["different"],
          allowedProjectTypes: ["PESSOAL"],
        },
        { mode: "preview" },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.restore(scope, undefined, { mode: "preview" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    { linkedExpenseId: "link" },
    { settlesInvoiceKey: "9876:2026-10" },
    { invoiceUndoState: "PROCESSED_NONE" },
    { invoiceUndoParcelaCount: 0 },
    { externalId: "m1:protected" },
    { tipoDespesa: "PAGAMENTO_FATURA_CARTAO" },
  ])("excludes protected topology %#", async (data) => {
    await db.expense.update({ where: { id: scope.expenseId }, data });
    const before = await snapshot();
    await expect(preview()).rejects.toBeInstanceOf(ConflictException);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { dataInicioParcela: date(11) },
    { dataInicioParcela: null },
    { installmentDateOverrides: '{"1":"2026-12-10"}' },
    { paidParcelas: "[1]" },
    { paidParcelas: "broken-json" },
    { status: "PAGO" },
  ])(
    "requires compatible current expense configuration before preview %#",
    async (data) => {
      await db.expense.update({ where: { id: scope.expenseId }, data });
      const before = await snapshot();
      await expect(preview()).rejects.toBeInstanceOf(ConflictException);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "reverse-link",
    "reverse-planned",
    "reverse-settled",
    "rateio-source",
    "rateio-target",
    "settlement-source",
    "settlement-target",
    "ledger-purchase",
    "ledger-payment",
    "ledger-history",
  ])("rejects %s even when discovered after preview", async (kind) => {
    const plan = await preview();
    const other = await db.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: "OUTROS",
        valor: 24690,
        valorTotal: 24690,
        formaPagamento: "A_VISTA",
        ...(kind === "reverse-link"
          ? { linkedExpenseId: scope.expenseId, deletedAt: date(9) }
          : {}),
        ...(kind === "reverse-planned"
          ? { plannedExpenseId: scope.expenseId }
          : {}),
        ...(kind === "reverse-settled"
          ? { settledByExpenseId: scope.expenseId }
          : {}),
      },
    });
    const sourceExpenseId = kind.endsWith("-target")
      ? other.id
      : scope.expenseId;
    const targetExpenseId = kind.endsWith("-target")
      ? scope.expenseId
      : other.id;
    if (kind.startsWith("rateio-"))
      await db.rateioAllocation.create({
        data: {
          tenantId,
          sourceExpenseId,
          targetExpenseId,
          allocation: 24690,
          plannedStatus: "PLANEJADO",
        },
      });
    if (kind.startsWith("settlement-"))
      await db.crossProjectSettlement.create({
        data: {
          tenantId,
          sourceExpenseId,
          targetExpenseId,
          parcelaIndex: 0,
          realValor: 12345,
          plannedValor: 12345,
          plannedStatus: "PLANEJADO",
        },
      });
    if (kind.startsWith("ledger-")) {
      const account = await db.bankAccount.create({
        data: {
          tenantId,
          projectId,
          institution: "TEST",
          nickname: "Test",
          last4: "4321",
        },
      });
      const batch = await db.bankStatementImport.create({
        data: {
          tenantId,
          accountId: account.id,
          source: "CSV_GENERIC",
          periodLabel: "2026-10",
        },
      });
      await db.importedInvoiceLiquidation.create({
        data: {
          tenantId,
          paymentExpenseId:
            kind === "ledger-payment" ? scope.expenseId : other.id,
          purchaseExpenseId:
            kind === "ledger-payment" ? other.id : scope.expenseId,
          importId: batch.id,
          cashFlowEntryId: "restore-active-0",
          cardId: scope.cardId,
          prevStatus: "PLANEJADO",
          entryValorCents: 12345,
          parcela: "2/3",
          dueMonth: "2026-10",
          ...(kind === "ledger-history" ? { deletedAt: date(9) } : {}),
        },
      });
    }
    const before = await snapshot();
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("re-reads authoritative evidence after the write reservation", async () => {
    const plan = await preview();
    events = [];
    await apply(plan.fingerprint);
    const lock = events.indexOf("raw:executeRaw");
    const read = events.indexOf("CashFlowEntry:findMany");
    const update = events.indexOf("CashFlowEntry:updateMany");
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
    expect(update).toBeGreaterThan(read);
    expect(
      events.slice(0, lock).filter((event) => event === "Expense:findFirst"),
    ).toHaveLength(1);
    expect(
      events.slice(lock, read).filter((event) => event === "Expense:findFirst"),
    ).toHaveLength(1);
  });

  it("rolls back the first label when the second conditional write affects zero rows", async () => {
    const plan = await preview();
    const before = await snapshot();
    rejectSecondUpdate = true;
    await expect(apply(plan.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(updates).toBe(2);
    expect(await snapshot()).toEqual(before);
  });

  it("two real clients repair at most once; a valid retry is a no-op", async () => {
    const secondPrisma = new PrismaService();
    try {
      const plan = await preview();
      const second = new RestoreInstallmentLabelsService(secondPrisma);
      const results = await Promise.allSettled([
        apply(plan.fingerprint),
        second.restore(scope, requester, {
          mode: "apply",
          expectedFingerprint: plan.fingerprint,
        }),
      ]);
      const successful = results.filter(
        (result) => result.status === "fulfilled",
      );
      expect(
        successful.reduce((sum, result) => sum + result.value.changed, 0),
      ).toBe(2);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(ConflictException);
        }
      }
      expect(await apply(plan.fingerprint)).toMatchObject({
        changed: 0,
        alreadyRestored: true,
      });
    } finally {
      await secondPrisma.$disconnect();
    }
  }, 20000);

  it("HTTP/Playwright requests exercise real JWT, role, module, project and tenant guards", async () => {
    const module = await Test.createTestingModule({
      controllers: [RestoreInstallmentLabelsController],
      providers: [
        RestoreInstallmentLabelsService,
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    const app = module.createNestApplication();
    const reflector = new Reflector();
    app.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new RolesGuard(reflector),
      new ModulesGuard(reflector, prisma),
      new ProjectAccessGuard(prisma),
    );
    await app.listen(0, "127.0.0.1");
    const http = await playwrightRequest.newContext({
      baseURL: await app.getUrl(),
    });
    const endpoint = `/projects/${projectId}/credit-cards/${scope.cardId}/imports/${scope.importId}/expenses/${scope.expenseId}/restore-installment-labels`;
    const jwt = new JwtService({
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
    });
    const user = await db.user.create({
      data: {
        tenantId,
        username: "restorer",
        name: "Restorer",
        role: "USER",
        allowedProjects: JSON.stringify([projectId]),
        allowedProjectTypes: '["PESSOAL"]',
        allowedModules: '["creditCards","expenses"]',
        lastActivityAt: new Date(),
      },
    });
    const headers = {
      Authorization: `Bearer ${jwt.sign({ sub: user.id, tenantId, sv: 0 })}`,
    };
    try {
      expect(
        (await http.post(endpoint, { data: { mode: "preview" } })).status(),
      ).toBe(401);
      const before = await snapshot();
      const response = await http.post(endpoint, {
        headers,
        data: { mode: "preview" },
      });
      expect(response.status()).toBe(201);
      const plan = await response.json();
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await http.post(endpoint, {
            headers,
            data: { mode: "preview", labels: [] },
          })
        ).status(),
      ).toBe(400);
      await db.user.update({
        where: { id: user.id },
        data: { allowedProjects: '["other"]' },
      });
      const inaccessible = await http.post(endpoint, {
        headers,
        data: { mode: "preview" },
      });
      const missing = await http.post(endpoint.replace(projectId, "missing"), {
        headers,
        data: { mode: "preview" },
      });
      expect(inaccessible.status()).toBe(404);
      expect(await inaccessible.json()).toEqual(await missing.json());
      await db.user.update({
        where: { id: user.id },
        data: {
          allowedProjects: JSON.stringify([projectId]),
          allowedModules: '["plantsAi"]',
          allowedProjectTypes: '["PLANTAS"]',
        },
      });
      expect(
        (
          await http.post(endpoint, { headers, data: { mode: "preview" } })
        ).status(),
      ).toBe(403);
      await db.user.update({
        where: { id: user.id },
        data: {
          allowedModules: '["creditCards","expenses"]',
          allowedProjectTypes: '["PESSOAL"]',
        },
      });
      const applied = await http.post(endpoint, {
        headers,
        data: {
          mode: "apply",
          expectedFingerprint: plan.fingerprint,
        },
      });
      expect(applied.status()).toBe(201);
      expect(await applied.json()).toMatchObject({ changed: 2 });
    } finally {
      await http.dispose();
      await app.close();
    }
  });
});
