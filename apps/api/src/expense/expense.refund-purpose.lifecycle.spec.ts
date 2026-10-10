import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { CreditCardService } from "../credit-card/credit-card.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { ProjectService } from "../project/project.service";
import { cleanupRefundPurpose } from "./refund-purpose.service";
import { omitRefundPurposeEvidence } from "./refund-purpose-privacy.interceptor";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { request as playwrightRequest } from "@playwright/test";
import { ExpenseController } from "./expense.controller";
import { RefundPurposeService } from "./refund-purpose.service";
import { PaidOriginsService } from "./paid-origins.service";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RefundPurposePrivacyInterceptor } from "./refund-purpose-privacy.interceptor";

describe("#704 owned refund lifecycle", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  const cards = new CreditCardService(
    prisma,
    conciliacao,
    new MerchantClassifierService(prisma),
  );
  let f: Awaited<ReturnType<typeof refundFixture>>;
  beforeEach(async () => {
    f = await refundFixture(db, prisma, "refund-lifecycle");
  });
  afterEach(async () => {
    await f.cleanup();
  });
  afterAll(async () => {
    await db.$disconnect();
    await prisma.$disconnect();
  });

  it("source deletion atomically deletes only its owned target", async () => {
    const result = await f.apply();
    await expenses.remove(f.tenantId, f.projectId, f.source.id, f.requester);
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await db.rateioAllocation.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
    expect(
      await db.cashFlowEntry.count({
        where: { tenantId: f.tenantId, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await db.expense.findUnique({ where: { id: f.source.id } }),
    ).toMatchObject({ refundPurposeRevision: 2, linkedExpenseId: null });
  });

  it("cleans up even an already soft-deleted source through real middleware", async () => {
    const result = await f.apply();
    await prisma.$transaction(async (tx) => {
      await tx.expense.delete({ where: { id: f.source.id } });
      await cleanupRefundPurpose(tx, f.tenantId, f.source.id, f.requester);
    });
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it("import undo removes owned target before deleting the source history", async () => {
    const result = await f.apply();
    await cards.undoImport(
      f.tenantId,
      f.projectId,
      f.card.id,
      f.batch.id,
      f.requester,
    );
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await db.rateioAllocation.count({ where: { tenantId: f.tenantId } }),
    ).toBe(0);
    expect(
      await db.cashFlowEntry.count({
        where: { tenantId: f.tenantId, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await cards.undoImport(
        f.tenantId,
        f.projectId,
        f.card.id,
        f.batch.id,
        f.requester,
      ),
    ).toMatchObject({ alreadyUndone: true });
  });

  it("deleted-source reversal cannot substitute an older deleted CFE generation", async () => {
    const result = await f.apply();
    await db.cashFlowEntry.updateMany({
      where: { tenantId: f.tenantId, expenseId: f.source.id },
      data: { deletedAt: new Date("2026-01-01") },
    });
    const before = await db.expense.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.expense.delete({ where: { id: f.source.id } });
        await conciliacao.reverseSourceLinks(
          tx,
          { tenantId: f.tenantId, sourceExpenseId: f.source.id },
          f.requester,
        );
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db.expense.findMany({
        where: { tenantId: f.tenantId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ deletedAt: null });
  });

  it("adopted imported source is retained but its owned projection is removed by import undo", async () => {
    await db.expense.update({
      where: { id: f.source.id },
      data: { createdAt: new Date("2020-01-01") },
    });
    const result = await f.apply();
    await cards.undoImport(
      f.tenantId,
      f.projectId,
      f.card.id,
      f.batch.id,
      f.requester,
    );
    expect(
      await db.expense.findUnique({ where: { id: f.source.id } }),
    ).toMatchObject({
      deletedAt: null,
      importId: null,
      linkedExpenseId: null,
      refundPurposeRevision: 2,
    });
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it("ordinary deletion, unlink and financial edits cannot adopt the owned credit", async () => {
    const result = await f.apply();
    for (const operation of [
      () =>
        expenses.remove(
          f.tenantId,
          f.targetProjectId,
          result.targetExpenseId,
          f.requester,
        ),
      () =>
        expenses.unlinkCrossProject(
          f.tenantId,
          f.projectId,
          f.source.id,
          f.requester,
        ),
      () =>
        expenses.desratear(f.tenantId, f.projectId, f.source.id, f.requester),
      () =>
        expenses.desconciliar(
          f.tenantId,
          f.projectId,
          f.source.id,
          f.requester,
        ),
      () =>
        cards.unlinkExpense(f.tenantId, f.projectId, f.source.id, f.requester),
      () =>
        expenses.update(
          f.tenantId,
          f.projectId,
          f.source.id,
          { dataCompra: "2026-09-01" },
          f.requester,
        ),
      () =>
        expenses.setParcelaStatus(
          f.tenantId,
          f.projectId,
          f.source.id,
          0,
          false,
        ),
      () =>
        expenses.updateInstallmentDate(
          f.tenantId,
          f.projectId,
          f.source.id,
          0,
          "2026-09-01",
          f.requester,
        ),
      () =>
        prisma.$transaction((tx) =>
          conciliacao.regenerateTargetCashflow(tx, result.targetExpenseId),
        ),
      () =>
        prisma.$transaction((tx) =>
          conciliacao.regenerateRateioTargetCashflow(
            tx,
            result.targetExpenseId,
          ),
        ),
    ])
      await expect(operation()).rejects.toMatchObject({ status: 409 });
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ deletedAt: null });
  });

  it("safe metadata synchronizes without cashflow replacement, but invalidates an earlier retry", async () => {
    const body = await f.request();
    const result = await f.apply(body);
    const before = await db.cashFlowEntry.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
    });
    await expenses.update(
      f.tenantId,
      f.projectId,
      f.source.id,
      { titulo: "Confirmed purpose" },
      f.requester,
    );
    expect(
      await db.cashFlowEntry.findMany({
        where: { tenantId: f.tenantId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ titulo: "Confirmed purpose" });
    await expect(f.apply(body)).rejects.toMatchObject({ status: 409 });
    await f.service.undo(f.tenantId, f.projectId, f.source.id, f.requester, {
      expectedRevision: 1,
    });
  });

  it("bulk merchant reclassification cannot financially mutate an owned projection", async () => {
    await db.expense.update({
      where: { id: f.source.id },
      data: { tipoDespesa: "OUTROS", titulo: "PAY UBER" },
    });
    await f.apply();
    await expect(
      expenses.reclassifyByMerchant(f.tenantId, f.targetProjectId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each(["delete", "import-undo", "metadata"] as const)(
    "apply versus %s has a serial outcome or explicit conflict",
    async (operation) => {
      const body = await f.request();
      const second = new PrismaService();
      const secondConciliacao = new ConciliacaoService(second);
      const secondExpenses = new ExpenseService(second, secondConciliacao);
      const secondCards = new CreditCardService(
        second,
        secondConciliacao,
        new MerchantClassifierService(second),
      );
      try {
        const results = await Promise.allSettled([
          f.apply(body),
          operation === "delete"
            ? secondExpenses.remove(
                f.tenantId,
                f.projectId,
                f.source.id,
                f.requester,
              )
            : operation === "metadata"
              ? secondExpenses.update(
                  f.tenantId,
                  f.projectId,
                  f.source.id,
                  { titulo: "Concurrent metadata" },
                  f.requester,
                )
              : secondCards.undoImport(
                  f.tenantId,
                  f.projectId,
                  f.card.id,
                  f.batch.id,
                  f.requester,
                ),
        ]);
        expect(results.some((result) => result.status === "fulfilled")).toBe(
          true,
        );
        for (const result of results)
          if (result.status === "rejected")
            expect([404, 409]).toContain(result.reason.status);
        const edges = await db.rateioAllocation.findMany({
          where: { tenantId: f.tenantId, isRefundCredit: true },
        });
        const targets = await db.expense.findMany({
          where: {
            tenantId: f.tenantId,
            projectId: f.targetProjectId,
            deletedAt: null,
          },
        });
        expect(targets.map((target) => target.id)).toEqual(
          edges.map((edge) => edge.targetExpenseId),
        );
        if (edges.length) {
          const source = await db.expense.findUniqueOrThrow({
            where: { id: f.source.id },
          });
          expect(source).toMatchObject({
            deletedAt: null,
            linkedExpenseId: targets[0].id,
            titulo: targets[0].titulo,
          });
        }
      } finally {
        await second.$disconnect();
      }
    },
  );

  it("drift prevents source deletion/import undo with full rollback", async () => {
    const result = await f.apply();
    await db.expense.update({
      where: { id: result.targetExpenseId },
      data: { valorTotal: -1 },
    });
    const before = await db.expense.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
    });
    await expect(
      expenses.remove(f.tenantId, f.projectId, f.source.id, f.requester),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      cards.undoImport(
        f.tenantId,
        f.projectId,
        f.card.id,
        f.batch.id,
        f.requester,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db.expense.findMany({
        where: { tenantId: f.tenantId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });

  it("parent and card identity deletion require unlink first", async () => {
    await f.apply();
    const projects = new ProjectService(prisma);
    await expect(
      projects.remove(f.tenantId, f.targetProjectId),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      cards.deleteCard(f.tenantId, f.projectId, f.card.id),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      cards.updateCard(f.tenantId, f.projectId, f.card.id, { last4: "0705" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      cards.updateCard(f.tenantId, f.projectId, f.card.id, {
        last4: f.card.last4,
      }),
    ).resolves.toMatchObject({ last4: f.card.last4 });
  });

  it("public redaction keeps the existing rateio response and hides internal ownership fields", async () => {
    const plain = await expenses.getRateio(
      f.tenantId,
      f.projectId,
      f.source.id,
      f.requester,
    );
    await f.apply();
    const hidden = {
      ...f.requester,
      role: "USER",
      allowedProjects: [f.projectId],
      allowedModules: ["expenses"],
      allowedProjectTypes: ["PESSOAL"],
    };
    expect(
      await expenses.getRateio(f.tenantId, f.projectId, f.source.id, hidden),
    ).toEqual(plain);
    expect(
      omitRefundPurposeEvidence({
        items: [{ id: "x", refundPurposeRevision: 1, isRefundCredit: true }],
      }),
    ).toEqual({ items: [{ id: "x" }] });
  });

  it("Playwright HTTP drives exact wire types, unknown-field rejection and non-disclosing ACL", async () => {
    const module = await Test.createTestingModule({
      controllers: [ExpenseController],
      providers: [
        RefundPurposeService,
        PaidOriginsService,
        JwtStrategy,
        { provide: ExpenseService, useValue: expenses },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    const app = module.createNestApplication();
    const reflector = new Reflector();
    app.useGlobalGuards(
      new JwtAuthGuard(reflector),
      new RolesGuard(reflector),
      new ModulesGuard(reflector, prisma),
      new ProjectAccessGuard(prisma, reflector),
    );
    app.useGlobalInterceptors(new RefundPurposePrivacyInterceptor(prisma));
    await app.listen(0, "127.0.0.1");
    const http = await playwrightRequest.newContext({
      baseURL: await app.getUrl(),
    });
    const endpoint = `/projects/${f.projectId}/expenses/${f.source.id}/refund-purpose`;
    const jwt = new JwtService({
      secret: process.env.JWT_SECRET || "dev-secret-change-me",
    });
    const headers = {
      Authorization: `Bearer ${jwt.sign({ sub: f.requester.id, tenantId: f.tenantId, sv: 0 })}`,
    };
    const intent = {
      mode: "preview",
      targetProjectId: f.targetProjectId,
      roomId: null,
    };
    try {
      expect((await http.post(endpoint, { data: intent })).status()).toBe(401);
      expect(
        (
          await http.post(endpoint, {
            headers,
            data: { ...intent, amount: -1 },
          })
        ).status(),
      ).toBe(400);
      const response = await http.post(endpoint, { headers, data: intent });
      expect(response.status()).toBe(201);
      const plan = await response.json();
      expect(Object.keys(plan).sort()).toEqual([
        "fingerprint",
        "mode",
        "revision",
        "summary",
      ]);
      expect(Object.keys(plan.summary).sort()).toEqual([
        "allocationCents",
        "cardId",
        "cashFlowDate",
        "dataCompra",
        "dataPagamento",
        "importId",
        "roomId",
        "sourceExpenseId",
        "targetProjectId",
        "tipoDespesa",
      ]);
      await db.user.update({
        where: { id: f.requester.id },
        data: {
          role: "USER",
          allowedProjects: JSON.stringify([f.projectId]),
          allowedModules: JSON.stringify(["expenses", "creditCards"]),
          allowedProjectTypes: JSON.stringify(["PESSOAL", "REFORMA"]),
        },
      });
      const hidden = await http.post(endpoint, { headers, data: intent });
      const missing = await http.post(endpoint, {
        headers,
        data: { ...intent, targetProjectId: "absent" },
      });
      expect(hidden.status()).toBe(404);
      expect(await hidden.json()).toEqual(await missing.json());
      await db.user.update({
        where: { id: f.requester.id },
        data: {
          role: "OWNER",
          allowedProjects: "[]",
          allowedModules: "[]",
          allowedProjectTypes: "[]",
        },
      });
      const body = {
        ...intent,
        mode: "apply",
        expectedRevision: plan.revision,
        expectedFingerprint: plan.fingerprint,
      };
      const applied = await http.post(endpoint, { headers, data: body });
      expect(applied.status()).toBe(201);
      expect(await applied.json()).toMatchObject({
        mode: "apply",
        revision: 1,
        alreadyApplied: false,
        fingerprint: plan.fingerprint,
      });
      const generic = await http.get(
        `/projects/${f.projectId}/expenses/${f.source.id}`,
        { headers },
      );
      expect(await generic.json()).not.toHaveProperty("refundPurposeRevision");
      const undone = await http.delete(endpoint, {
        headers,
        data: { expectedRevision: 1 },
      });
      expect(await undone.json()).toEqual({
        revision: 2,
        alreadyUndone: false,
      });
      expect(
        (await http.post(endpoint, { headers, data: body })).status(),
      ).toBe(409);
    } finally {
      await http.dispose();
      await app.close();
    }
  });
});
