import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RefundPurposeService } from "./refund-purpose.service";
import {
  resetTenant,
  seedPessoal,
  seedCardWithClosingDue,
} from "../bank-account/__tests__/invoice-undo.fixtures";

describe("#704 refund purpose (real Prisma middleware)", () => {
  const tenantId = "refund-purpose-test";
  const projectId = "refund-personal";
  const targetProjectId = "refund-renovation";
  const requester = { id: "refund-owner", role: "OWNER" };
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const service = new RefundPurposeService(prisma);
  let expenseId: string;
  const date = new Date("2026-09-10T00:00:00Z");
  const preview = () =>
    service.execute(tenantId, projectId, expenseId, requester, {
      mode: "preview",
      targetProjectId,
      roomId: null,
    });
  const request = async () => {
    const plan = await preview();
    return {
      mode: "apply",
      targetProjectId,
      roomId: null,
      expectedRevision: plan.revision,
      expectedFingerprint: plan.fingerprint,
    };
  };
  const apply = (body: unknown) =>
    service.execute(tenantId, projectId, expenseId, requester, body);
  const snapshot = async () => ({
    expenses: await db.expense.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    cashflow: await db.cashFlowEntry.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    allocations: await db.rateioAllocation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    receipts: await db.receipt.findMany({ where: { tenantId } }),
    budgets: await db.budgetAllocation.findMany({ where: { tenantId } }),
    adjustments: await db.invoiceAdjustment.findMany({ where: { tenantId } }),
    settlements: await db.crossProjectSettlement.findMany({
      where: { tenantId },
    }),
    ledger: await db.importedInvoiceLiquidation.findMany({
      where: { tenantId },
    }),
  });

  beforeEach(async () => {
    await db.user.deleteMany({ where: { tenantId } });
    await db.room.deleteMany({ where: { project: { tenantId } } });
    await resetTenant(db, tenantId);
    await seedPessoal(db, { tenantId, projectId });
    await db.user.create({
      data: { ...requester, tenantId, username: "owner", name: "Owner" },
    });
    await db.project.create({
      data: {
        id: targetProjectId,
        tenantId,
        type: "REFORMA",
        name: "Renovation",
      },
    });
    const card = await seedCardWithClosingDue(db, {
      tenantId,
      projectId,
      last4: "1234",
    });
    const batch = await db.creditCardStatementImport.create({
      data: {
        tenantId,
        cardId: card.id,
        source: "CSV_GENERIC",
        periodLabel: "2026-09",
      },
    });
    const source = await db.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: -12345,
        valorTotal: -12345,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PAGO",
        origin: "import",
        cardLast4: card.last4,
        importId: batch.id,
        externalId: "synthetic-refund",
        dataPagamento: date,
        dataCompra: new Date("2026-08-26T00:00:00Z"),
      },
    });
    expenseId = source.id;
    await db.cashFlowEntry.create({
      data: {
        tenantId,
        projectId,
        expenseId,
        valor: -12345,
        tipo: "DESPESA",
        data: date,
        categoria: "Material",
        formaPagamento: "CARTAO_CREDITO",
        status: "PAGO",
      },
    });
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { tenantId } });
    await db.room.deleteMany({ where: { project: { tenantId } } });
    await resetTenant(db, tenantId);
    await db.$disconnect();
    await prisma.$disconnect();
  });

  it("creates exactly one owned negative projection, preserves source and retries without writes", async () => {
    const before = await snapshot();
    const body = await request();
    expect(await snapshot()).toEqual(before);
    const result = await apply(body);
    if (result.mode !== "apply") throw new Error("Expected apply");
    expect(result.summary).toMatchObject({
      allocationCents: -12345,
      cashFlowDate: date.toISOString(),
    });
    const after = await snapshot();
    expect(after.cashflow.filter((e) => e.expenseId === expenseId)).toEqual(
      before.cashflow,
    );
    const source = after.expenses.find((e) => e.id === expenseId)!;
    expect({
      ...source,
      linkedExpenseId: null,
      refundPurposeRevision: 0,
    }).toEqual(before.expenses[0]);
    expect(
      after.expenses.find((e) => e.id === result.targetExpenseId),
    ).toMatchObject({
      valor: -12345,
      valorTotal: -12345,
      quantidade: 1,
      status: "PAGO",
      origin: "none",
      cardLast4: null,
      bankLast4: null,
      accountId: null,
      importId: null,
      externalId: null,
      settlesInvoiceKey: null,
      dataCompra: before.expenses[0].dataCompra,
    });
    expect(after.allocations).toEqual([
      expect.objectContaining({
        sourceExpenseId: expenseId,
        targetExpenseId: result.targetExpenseId,
        allocation: -12345,
        isRefundCredit: true,
      }),
    ]);
    for (const key of [
      "receipts",
      "budgets",
      "adjustments",
      "settlements",
      "ledger",
    ] as const)
      expect(after[key]).toEqual(before[key]);
    expect(await apply(body)).toMatchObject({
      targetExpenseId: result.targetExpenseId,
      alreadyApplied: true,
    });
    expect(await snapshot()).toEqual(after);
  });

  it("failure after target and cashflow creation rolls the entire write back", async () => {
    const body = await request();
    const before = await snapshot();
    let fail = true;
    prisma.$use(async (params, next) => {
      if (
        fail &&
        params.model === "RateioAllocation" &&
        params.action === "create"
      )
        throw new Error("Synthetic owned-edge failure");
      return next(params);
    });
    try {
      await expect(apply(body)).rejects.toThrow("Synthetic owned-edge failure");
      expect(await snapshot()).toEqual(before);
    } finally {
      fail = false;
    }
  });

  it("database rejects a nonnegative marked allocation", async () => {
    await apply(await request());
    const edge = await db.rateioAllocation.findFirstOrThrow({
      where: { tenantId, sourceExpenseId: expenseId },
    });
    await expect(
      db.rateioAllocation.update({
        where: { id: edge.id },
        data: { allocation: 0 },
      }),
    ).rejects.toThrow();
    expect(
      await db.rateioAllocation.findUnique({ where: { id: edge.id } }),
    ).toEqual(edge);
  });

  it("room must be live and belong to the authorized destination", async () => {
    const room = await db.room.create({
      data: { projectId, name: "Wrong parent" },
    });
    await expect(
      apply({ mode: "preview", targetProjectId, roomId: room.id }),
    ).rejects.toMatchObject({ status: 404 });
    await db.room.update({
      where: { id: room.id },
      data: { projectId: targetProjectId, deletedAt: date },
    });
    await expect(
      apply({ mode: "preview", targetProjectId, roomId: room.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    "amount",
    "purchase-date",
    "category",
    "cfe-history",
    "metadata",
  ] as const)(
    "rejects eligible preview drift without writes: %s",
    async (mutation) => {
      const body = await request();
      if (mutation === "amount") {
        await db.expense.update({
          where: { id: expenseId },
          data: { valor: -15000, valorTotal: -15000 },
        });
        await db.cashFlowEntry.updateMany({
          where: { expenseId },
          data: { valor: -15000 },
        });
      } else if (mutation === "purchase-date") {
        await db.expense.update({
          where: { id: expenseId },
          data: { dataCompra: date },
        });
      } else if (mutation === "category") {
        await db.expense.update({
          where: { id: expenseId },
          data: { tipoDespesa: "OUTROS" },
        });
      } else if (mutation === "metadata") {
        await db.expense.update({
          where: { id: expenseId },
          data: { titulo: "Changed title" },
        });
      } else {
        await db.cashFlowEntry.create({
          data: {
            tenantId,
            projectId,
            expenseId,
            valor: -12345,
            tipo: "DESPESA",
            data: date,
            categoria: "Material",
            status: "PAGO",
            deletedAt: date,
          },
        });
      }
      const before = await snapshot();
      await expect(apply(body)).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("undo removes owned target and prevents ABA resurrection", async () => {
    const body = await request();
    const result = await apply(body);
    if (result.mode !== "apply") throw new Error("Expected apply");
    const before = await db.cashFlowEntry.findMany({ where: { expenseId } });
    expect(
      await service.undo(tenantId, projectId, expenseId, requester, {
        expectedRevision: 1,
      }),
    ).toEqual({ revision: 2, alreadyUndone: false });
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    expect(
      await db.cashFlowEntry.count({
        where: { expenseId: result.targetExpenseId, deletedAt: null },
      }),
    ).toBe(0);
    expect(await db.cashFlowEntry.findMany({ where: { expenseId } })).toEqual(
      before,
    );
    expect(
      await service.undo(tenantId, projectId, expenseId, requester, {
        expectedRevision: 1,
      }),
    ).toEqual({ revision: 2, alreadyUndone: true });
    await expect(apply(body)).rejects.toMatchObject({ status: 409 });
    await apply(await request());
    await expect(apply(body)).rejects.toMatchObject({ status: 409 });
  });

  it.each([0, 1])("rejects nonnegative source %s", async (value) => {
    await db.expense.update({
      where: { id: expenseId },
      data: { valor: value, valorTotal: value },
    });
    await db.cashFlowEntry.updateMany({
      where: { expenseId },
      data: { valor: value },
    });
    await expect(preview()).rejects.toMatchObject({ status: 409 });
  });

  it("uses current grants rather than the earlier authenticated role", async () => {
    const body = await request();
    await db.user.update({
      where: { id: requester.id },
      data: { role: "USER", allowedProjects: JSON.stringify([projectId]) },
    });
    await expect(apply(body)).rejects.toMatchObject({ status: 404 });
  });
  it("rejects unknown input fields", async () => {
    await expect(
      apply({ mode: "preview", targetProjectId, roomId: null, valor: -1 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    { origin: "account" },
    { importId: null },
    { externalId: null },
    { cardLast4: null },
    { bankLast4: "1234" },
    { recorrente: true },
    { recurrenceKey: "synthetic-series" },
    { formaPagamento: "PARCELADO", quantidadeParcela: 1 },
    { tipoDespesa: "PAGAMENTO_FATURA_CARTAO" },
    { status: "PLANEJADO" },
    { settlesInvoiceKey: "1234:2026-09" },
    { invoiceUndoState: "PROCESSED_NONE" },
  ])("ineligible source cannot create a purpose: %j", async (data) => {
    await db.expense.update({ where: { id: expenseId }, data });
    const before = await snapshot();
    await expect(preview()).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });

  it("accepts one cent and legacy origin=none using original import identity, not duplicate last4", async () => {
    const original = await preview();
    await db.creditCard.create({
      data: {
        tenantId,
        projectId,
        last4: "1234",
        nickname: "Unrelated duplicate",
        institution: "OUTROS",
      },
    });
    await db.expense.update({
      where: { id: expenseId },
      data: { valor: -1, valorTotal: -1, origin: "none" },
    });
    await db.cashFlowEntry.updateMany({
      where: { expenseId },
      data: { valor: -1 },
    });
    const applied = await apply(await request());
    expect(applied.summary).toMatchObject({
      allocationCents: -1,
      cardId: original.summary.cardId,
    });
  });

  it.each(["pending", "amount", "date", "second", "replace"] as const)(
    "invalidates CFE evidence: %s",
    async (mutation) => {
      const body = await request();
      const cfe = await db.cashFlowEntry.findFirstOrThrow({
        where: { expenseId },
      });
      if (mutation === "second" || mutation === "replace") {
        if (mutation === "replace")
          await db.cashFlowEntry.update({
            where: { id: cfe.id },
            data: { deletedAt: new Date() },
          });
        const { id, ...data } = cfe;
        await db.cashFlowEntry.create({ data });
      } else {
        await db.cashFlowEntry.update({
          where: { id: cfe.id },
          data:
            mutation === "pending"
              ? { status: "PLANEJADO" }
              : mutation === "amount"
                ? { valor: -1 }
                : { data: new Date("2026-09-11T00:00:00Z") },
        });
      }
      const before = await snapshot();
      await expect(apply(body)).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["source", "target", "incoming", "provenance", "cfe"] as const)(
    "exact retry refuses current evidence drift: %s",
    async (mutation) => {
      const body = await request();
      const result = await apply(body);
      if (result.mode !== "apply") throw new Error("Expected apply");
      if (mutation === "source")
        await db.expense.update({
          where: { id: expenseId },
          data: { titulo: "Changed" },
        });
      if (mutation === "target")
        await db.expense.update({
          where: { id: result.targetExpenseId },
          data: { titulo: "Changed" },
        });
      if (mutation === "cfe")
        await db.cashFlowEntry.updateMany({
          where: { expenseId },
          data: { categoria: "Changed" },
        });
      if (mutation === "provenance")
        await db.creditCardStatementImport.update({
          where: { id: result.summary.importId },
          data: { periodLabel: "2026-10" },
        });
      if (mutation === "incoming")
        await db.expense.create({
          data: {
            tenantId,
            projectId,
            tipoDespesa: "OUTROS",
            valor: 1,
            valorTotal: 1,
            formaPagamento: "A_VISTA",
            linkedExpenseId: result.targetExpenseId,
          },
        });
      const before = await snapshot();
      await expect(apply(body)).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("different destination cannot reuse a preview and current grant drift invalidates an otherwise eligible request", async () => {
    const body = await request();
    await db.project.create({
      data: {
        id: "refund-second-target",
        tenantId,
        name: "Other",
        type: "REFORMA",
      },
    });
    await expect(
      apply({ ...body, targetProjectId: "refund-second-target" }),
    ).rejects.toMatchObject({ status: 409 });
    await db.user.update({
      where: { id: requester.id },
      data: { allowedProjects: JSON.stringify([projectId, targetProjectId]) },
    });
    await expect(apply(body)).rejects.toMatchObject({ status: 409 });
  });

  it("historical CFE insertion order does not change the fingerprint", async () => {
    const sourceCfe = await db.cashFlowEntry.findFirstOrThrow({
      where: { expenseId },
    });
    const { id, ...data } = sourceCfe;
    for (const historyId of ["history-z", "history-a"])
      await db.cashFlowEntry.create({
        data: { ...data, id: historyId, deletedAt: date },
      });
    const before = await preview();
    await db.cashFlowEntry.deleteMany({
      where: { tenantId, id: { in: ["history-z", "history-a"] } },
    });
    for (const historyId of ["history-a", "history-z"])
      await db.cashFlowEntry.create({
        data: { ...data, id: historyId, deletedAt: date },
      });
    expect((await preview()).fingerprint).toBe(before.fingerprint);
  });

  it("an unauthorized incoming graph participant is opaque before conflict evaluation", async () => {
    const hiddenProjectId = "refund-hidden-project";
    await db.project.create({
      data: { id: hiddenProjectId, tenantId, name: "Hidden", type: "REFORMA" },
    });
    await db.expense.create({
      data: {
        tenantId,
        projectId: hiddenProjectId,
        tipoDespesa: "OUTROS",
        valor: 1,
        valorTotal: 1,
        formaPagamento: "A_VISTA",
        linkedExpenseId: expenseId,
      },
    });
    await db.user.update({
      where: { id: requester.id },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([projectId, targetProjectId]),
        allowedProjectTypes: JSON.stringify(["PESSOAL", "REFORMA"]),
        allowedModules: JSON.stringify(["expenses", "creditCards"]),
      },
    });
    await expect(preview()).rejects.toMatchObject({ status: 404 });
  });

  it("competing destinations cannot retarget a winning generation", async () => {
    const otherId = "refund-other-destination";
    await db.project.create({
      data: { id: otherId, tenantId, name: "Other", type: "REFORMA" },
    });
    const firstBody = await request();
    const otherPreview = await service.execute(
      tenantId,
      projectId,
      expenseId,
      requester,
      {
        mode: "preview",
        targetProjectId: otherId,
        roomId: null,
      },
    );
    const second = new PrismaService();
    try {
      const results = await Promise.allSettled([
        apply(firstBody),
        new RefundPurposeService(second).execute(
          tenantId,
          projectId,
          expenseId,
          requester,
          {
            ...firstBody,
            targetProjectId: otherId,
            expectedFingerprint: otherPreview.fingerprint,
          },
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({ status: 409 });
      expect(
        await db.rateioAllocation.count({
          where: { tenantId, isRefundCredit: true },
        }),
      ).toBe(1);
      expect(
        await db.expense.count({
          where: {
            tenantId,
            projectId: { in: [targetProjectId, otherId] },
            deletedAt: null,
          },
        }),
      ).toBe(1);
    } finally {
      await second.$disconnect();
    }
  });

  it("two real clients reserve the writer before re-reading and produce one target only", async () => {
    const second = new PrismaService();
    const events: string[] = [];
    prisma.$use(async (params, next) => {
      events.push(`${params.model ?? "raw"}:${params.action}`);
      return next(params);
    });
    try {
      const body = await request();
      events.length = 0;
      const results = await Promise.allSettled([
        apply(body),
        new RefundPurposeService(second).execute(
          tenantId,
          projectId,
          expenseId,
          requester,
          body,
        ),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({ status: 409 });
      const locked = events.indexOf("raw:executeRaw");
      expect(locked).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("User:findUnique")).toBeGreaterThan(locked);
      expect(events.indexOf("CashFlowEntry:findMany")).toBeGreaterThan(locked);
      expect(
        await db.rateioAllocation.count({
          where: { tenantId, isRefundCredit: true },
        }),
      ).toBe(1);
      expect(
        await db.expense.count({
          where: { tenantId, projectId: targetProjectId, deletedAt: null },
        }),
      ).toBe(1);
      expect(await apply(body)).toMatchObject({ alreadyApplied: true });
    } finally {
      await second.$disconnect();
    }
  });
});
