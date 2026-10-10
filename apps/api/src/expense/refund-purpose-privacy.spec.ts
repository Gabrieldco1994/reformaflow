import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import {
  makeExpenseService,
  seedBankAccount,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import {
  AgentToolsService,
  ToolContext,
} from "../agent/tools/agent-tools.service";
import { CreditCardService } from "../credit-card/credit-card.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { PriceMonitorService } from "../price-compare/price-monitor.service";
import { PrismaService } from "../prisma/prisma.service";
import { ReceiptService } from "../receipt/receipt.service";
import { TenantFinancialService } from "../tenant-financial/tenant-financial.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";
import { ExpenseController } from "./expense.controller";
import { PaidOriginsService } from "./paid-origins.service";
import { serializeRefundPurposeResponse } from "./refund-purpose-privacy.interceptor";

describe("SEC-704-1 public refund references (real PrismaService)", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  let f: Awaited<ReturnType<typeof refundFixture>>;
  const queries: string[] = [];
  prisma.$use(async (params, next) => {
    queries.push(`${params.model}:${params.action}`);
    return next(params);
  });
  beforeAll(() => prisma.onModuleInit());
  beforeEach(async () => {
    f = await refundFixture(db, prisma, "refund-reference-privacy");
  });
  afterEach(async () => {
    await f.cleanup();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
    await db.$disconnect();
  });

  const revokeTarget = () =>
    db.user.update({
      where: { id: f.requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([f.projectId]),
        allowedModules: JSON.stringify(["expenses"]),
        allowedProjectTypes: "[]",
      },
    });
  const sourceRow = () =>
    prisma.expense.findFirstOrThrow({
      where: { id: f.source.id, tenantId: f.tenantId },
    });
  const serialize = (value: unknown) =>
    serializeRefundPurposeResponse(prisma, f.tenantId, f.requester, value);

  it("redacts a hidden refund link without losing #702 funding summaries or source budget", async () => {
    const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
    const controller = new ExpenseController(
      expenses,
      new PaidOriginsService(prisma),
      f.service,
    );
    const account = await seedBankAccount(db, {
      tenantId: f.tenantId,
      projectId: f.projectId,
      last4: "0702",
    });
    const project = await db.project.create({
      data: {
        tenantId: f.tenantId,
        name: "Visible funded project",
        type: "REFORMA",
      },
    });
    const source = await expenses.create(f.tenantId, f.projectId, {
      tipoDespesa: "OUTROS",
      valor: 400,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PAGO",
      dataPagamento: "2026-09-10",
      bankAccountId: account.id,
    });
    const target = await expenses.create(f.tenantId, project.id, {
      tipoDespesa: "MAO_DE_OBRA",
      valor: 800,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PLANEJADO",
      dataPagamento: "2026-09-20",
    });
    await expenses.conciliarParcela(
      f.tenantId,
      f.projectId,
      source.id,
      {
        mode: "ADDITIVE",
        targetExpenseId: target.id,
        parcelaIndex: 0,
        amountCents: 40000,
        requestId: "privacy-composition-funding",
      },
      f.requester,
    );
    const refund = await f.apply();
    await db.user.update({
      where: { id: f.requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([f.projectId, project.id]),
        allowedProjectTypes: JSON.stringify(["PESSOAL", "REFORMA"]),
        allowedModules: JSON.stringify(["expenses", "bankAccounts"]),
      },
    });
    const before = await sourceRow();
    const list = await serialize(
      await controller.findAll(
        f.tenantId,
        f.projectId,
        undefined,
        undefined,
        f.requester,
      ),
    );
    expect(list).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: f.source.id,
          linkedExpenseId: null,
          canDelete: false,
        }),
        expect.objectContaining({ id: source.id, sourceAvailableCents: 0 }),
      ]),
    });
    expect(JSON.stringify(list)).not.toContain(refund.targetExpenseId);
    expect(JSON.stringify(list)).not.toContain(f.targetProjectId);
    expect(await sourceRow()).toEqual(before);
    expect(
      await serialize(
        await controller.findById(
          f.tenantId,
          project.id,
          target.id,
          f.requester,
        ),
      ),
    ).toMatchObject({
      id: target.id,
      installmentSettlements: [
        {
          contractedCents: 80000,
          paidCents: 40000,
          remainingCents: 40000,
          settlementStatus: "PARTIAL",
          contributions: [{ sourceId: source.id, amountCents: 40000 }],
        },
      ],
    });
  });

  it("uses current ACL despite a stale OWNER and clones nested rows without financial writes or private lookup keys", async () => {
    const applied = await f.apply();
    await revokeTarget();
    const source = await sourceRow();
    const original = structuredClone(source);
    const payload = { items: [{ expense: source, canDelete: true }] };
    queries.length = 0;
    const result = await serialize(payload);
    expect(result).toMatchObject({
      items: [
        {
          expense: { id: source.id, linkedExpenseId: null },
          canDelete: true,
        },
      ],
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(applied.targetExpenseId);
    expect(json).not.toContain(f.targetProjectId);
    expect(json).not.toContain("refundPurposeRevision");
    expect(json).not.toContain("isRefundCredit");
    expect(source).toEqual(original);
    expect(await sourceRow()).toEqual(original);
    expect(queries.every((query) => /:find/.test(query))).toBe(true);
    expect(result).toEqual(await serialize(result));
  });

  it.each([
    "deleted-expense",
    "deleted-project",
    "cross-tenant",
    "module-revoked",
  ] as const)(
    "does not disclose an unavailable counterpart: %s",
    async (reason) => {
      const applied = await f.apply();
      const foreignTenantId = `${f.tenantId}-foreign`;
      try {
        if (reason === "deleted-expense")
          await db.expense.update({
            where: { id: applied.targetExpenseId },
            data: { deletedAt: new Date() },
          });
        if (reason === "deleted-project")
          await db.project.update({
            where: { id: f.targetProjectId },
            data: { deletedAt: new Date() },
          });
        if (reason === "cross-tenant") {
          await db.tenant.create({
            data: { id: foreignTenantId, name: "Synthetic foreign tenant" },
          });
          await db.expense.update({
            where: { id: applied.targetExpenseId },
            data: { tenantId: foreignTenantId },
          });
        }
        if (reason === "module-revoked")
          await db.user.update({
            where: { id: f.requester.id },
            data: {
              role: "USER",
              allowedProjects: "[]",
              allowedProjectTypes: "[]",
              allowedModules: JSON.stringify(["creditCards"]),
            },
          });
        expect(await serialize(await sourceRow())).toMatchObject({
          linkedExpenseId: null,
        });
      } finally {
        if (reason === "cross-tenant") {
          await db.expense.update({
            where: { id: applied.targetExpenseId },
            data: { tenantId: f.tenantId },
          });
          await db.tenant.delete({ where: { id: foreignTenantId } });
        }
      }
    },
  );

  it("batches repeated nested projections and fails closed on malformed current grants", async () => {
    await f.apply();
    await revokeTarget();
    const source = await sourceRow();
    queries.length = 0;
    await serialize(source);
    const single = queries.length;
    queries.length = 0;
    const result = await serialize(
      Array.from({ length: 26 }, () => ({ expense: source })),
    );
    expect(queries).toHaveLength(single);
    expect(result).toEqual(
      Array.from({ length: 26 }, () => ({
        expense: expect.objectContaining({ linkedExpenseId: null }),
      })),
    );
    await db.user.update({
      where: { id: f.requester.id },
      data: { allowedProjects: "{}" },
    });
    await expect(serialize(source)).rejects.toMatchObject({ status: 401 });
    await expect(
      serializeRefundPurposeResponse(prisma, f.tenantId, undefined, source),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(["undo", "reapply", "source-delete", "missing-edge"] as const)(
    "does not treat a captured reference as legacy after %s, even without loaded private fields",
    async (transition) => {
      const applied = await f.apply();
      const source = await sourceRow();
      const captured = {
        items: [
          { expense: source },
          { id: source.id, linkedExpenseId: source.linkedExpenseId },
        ],
      };
      expect(await serialize(captured)).toMatchObject({
        items: [
          { expense: { linkedExpenseId: applied.targetExpenseId } },
          { linkedExpenseId: applied.targetExpenseId },
        ],
      });
      if (transition === "missing-edge") {
        await db.rateioAllocation.deleteMany({
          where: { tenantId: f.tenantId },
        });
      } else if (transition === "source-delete") {
        await makeExpenseService(prisma).remove(
          f.tenantId,
          f.projectId,
          source.id,
          f.requester,
        );
      } else {
        await f.service.undo(f.tenantId, f.projectId, source.id, f.requester, {
          expectedRevision: applied.revision,
        });
        if (transition === "reapply") {
          const newer = await f.apply();
          expect(newer.targetExpenseId).not.toBe(applied.targetExpenseId);
          expect(newer.revision).toBe(applied.revision + 2);
          expect(await serialize(await sourceRow())).toMatchObject({
            linkedExpenseId: newer.targetExpenseId,
          });
        }
      }
      // Even a fully authorized reader must not receive a retired reference.
      expect(await serialize(captured)).toMatchObject({
        items: [
          { expense: { linkedExpenseId: null } },
          { linkedExpenseId: null },
        ],
      });
      expect(
        await serialize({
          items: [{ id: source.id, linkedExpenseId: source.linkedExpenseId }],
        }),
      ).toEqual({
        items: [{ id: source.id, linkedExpenseId: null }],
      });
      await revokeTarget();
      queries.length = 0;
      const redacted = await serialize(captured);
      expect(redacted).toMatchObject({
        items: [
          { expense: { linkedExpenseId: null } },
          { linkedExpenseId: null },
        ],
      });
      const json = JSON.stringify(redacted);
      expect(json).not.toContain(applied.targetExpenseId);
      expect(json).not.toContain("refundPurposeRevision");
      expect(json).not.toContain("isRefundCredit");
      expect(source.linkedExpenseId).toBe(applied.targetExpenseId);
      expect(queries.every((query) => /:find/.test(query))).toBe(true);
    },
  );

  it.each(["stable", "after-undo", "after-reapply"] as const)(
    "Maria shared tool boundary never passes a hidden captured ID to the model: %s",
    async (transition) => {
      const applied = await f.apply();
      const source = await sourceRow();
      if (transition !== "stable") {
        await f.service.undo(f.tenantId, f.projectId, source.id, f.requester, {
          expectedRevision: applied.revision,
        });
        if (transition === "after-reapply") await f.apply();
      }
      await revokeTarget();
      // Exercise execute's boundary with an expense-bearing service result too.
      const financial = { getUpcoming: jest.fn().mockResolvedValue([source]) };
      const module = await Test.createTestingModule({
        providers: [
          AgentToolsService,
          { provide: PrismaService, useValue: prisma },
          { provide: TenantFinancialService, useValue: financial },
          ...[
            ExpenseService,
            ReceiptService,
            CreditCardService,
            MerchantClassifierService,
            PriceMonitorService,
            MonthlyOverviewService,
          ].map((provide) => ({ provide, useValue: {} })),
        ],
      }).compile();
      try {
        const tools = module.get(AgentToolsService);
        const ctx: ToolContext = {
          tenantId: f.tenantId,
          userId: f.requester.id,
          role: "OWNER",
          projectScope: null,
          scopeFor: async () => [f.projectId],
        };
        const search = await tools.execute("find_expenses", ctx, {});
        expect(search).toMatchObject({
          despesas: [expect.objectContaining({ expenseId: source.id })],
        });
        expect(JSON.stringify(search)).not.toContain(applied.targetExpenseId);
        const result = await tools.execute("get_upcoming", ctx, {});
        expect(result).toMatchObject({
          itens: [{ id: source.id, linkedExpenseId: null }],
        });
        expect(JSON.stringify(result)).not.toContain(applied.targetExpenseId);
        expect(source.linkedExpenseId).toBe(applied.targetExpenseId);
        await db.user.update({
          where: { id: f.requester.id },
          data: { allowedModules: "{}" },
        });
        const denied = await tools.execute("get_upcoming", ctx, {});
        expect(denied).toEqual({ error: expect.any(String) });
        expect(JSON.stringify(denied)).not.toContain(applied.targetExpenseId);
      } finally {
        await module.close();
      }
    },
  );
});
