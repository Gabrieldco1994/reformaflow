import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { seedBankAccount } from "../bank-account/__tests__/invoice-undo.fixtures";
import { ExpenseService } from "./expense.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { applyParcelaFunding } from "../conciliacao/additive-settlement";
import {
  CARD_PURCHASE_INSPECTION,
  inspectCardPurchaseCompanions,
} from "../credit-card/card-purchase-identity";
import { RestoreImportedExpenseService } from "../credit-card/restore-imported-expense.service";
import { RestoreImportedExpensesService } from "../bank-account/restore-imported-expenses.service";

/**
 * #704 QA guards. Each refusal is pinned as a controlled 4xx (never a 5xx) with a
 * positive control that proves the harness reaches the guarded business logic,
 * and with a full-ledger before/after comparison that includes soft-deleted rows.
 */
describe("#704 QA: funding, strong identity and restore stay closed around a refund graph", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
  let f: Awaited<ReturnType<typeof refundFixture>>;

  beforeEach(async () => {
    jest.useFakeTimers({
      now: new Date("2026-09-23T12:00:00Z"),
      doNotFake: [
        "nextTick",
        "setImmediate",
        "clearImmediate",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "hrtime",
        "performance",
        "queueMicrotask",
      ],
    });
    f = await refundFixture(db, prisma, "refund-qa-guards");
  });
  afterEach(async () => {
    jest.useRealTimers();
    await f.cleanup();
  });
  afterAll(async () => {
    await db.$disconnect();
    await prisma.$disconnect();
  });

  /** Every row of the tenant, soft-deleted included (raw client, no middleware). */
  const ledger = async () => {
    const where = { tenantId: f.tenantId };
    const orderBy = { id: "asc" as const };
    return {
      expenses: await db.expense.findMany({ where, orderBy }),
      cash: await db.cashFlowEntry.findMany({ where, orderBy }),
      allocations: await db.rateioAllocation.findMany({ where, orderBy }),
      settlements: await db.crossProjectSettlement.findMany({ where, orderBy }),
      audit: await db.userActivityLog.findMany({ where, orderBy }),
      bankImports: await db.bankStatementImport.findMany({ where, orderBy }),
      cardImports: await db.creditCardStatementImport.findMany({
        where,
        orderBy,
      }),
    };
  };
  const outcome = async (run: () => Promise<unknown>) =>
    run().then(
      () => ({ ok: true as const }),
      (error: { status?: number }) => ({
        ok: false as const,
        status: error.status,
      }),
    );
  const controlled = (o: { ok: boolean; status?: number }) => {
    expect(o.ok).toBe(false);
    expect(o.status).toBeGreaterThanOrEqual(400);
    expect(o.status).toBeLessThan(500);
  };

  // ── ADDITIVE funding ─────────────────────────────────────────────────────
  const fundingCommand = (targetExpenseId: string, requestId: string) => ({
    mode: "ADDITIVE",
    targetExpenseId,
    parcelaIndex: 0,
    amountCents: 100,
    requestId,
  });

  it("ADDITIVE funding is refused with a controlled 4xx when the refund graph is source or target, while an ordinary pair is accepted", async () => {
    const account = await seedBankAccount(db, {
      tenantId: f.tenantId,
      projectId: f.projectId,
      last4: "7041",
    });
    const bankSource = await expenses.create(f.tenantId, f.projectId, {
      tipoDespesa: "OUTROS",
      valor: 400,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PAGO",
      dataPagamento: "2026-09-10",
      bankAccountId: account.id,
    });
    const ordinaryTarget = await expenses.create(
      f.tenantId,
      f.targetProjectId,
      {
        tipoDespesa: "MAO_DE_OBRA",
        valor: 800,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        dataPagamento: "2026-09-20",
      },
    );
    const applied = await f.apply();
    const fund = (
      sourceProject: string,
      sourceId: string,
      targetId: string,
      key: string,
    ) =>
      applyParcelaFunding(
        prisma,
        f.tenantId,
        sourceProject,
        sourceId,
        fundingCommand(targetId, key),
        f.requester,
      );
    const before = await ledger();

    // refund credit as the funding source (card purchase, negative)
    controlled(
      await outcome(() =>
        fund(
          f.projectId,
          f.source.id,
          ordinaryTarget.id,
          "qa-refund-as-source",
        ),
      ),
    );
    // ordinary bank source funding the refund's owned (paid, negative) target
    controlled(
      await outcome(() =>
        fund(
          f.projectId,
          bankSource.id,
          applied.targetExpenseId,
          "qa-refund-as-target",
        ),
      ),
    );
    expect(await ledger()).toEqual(before);
    expect(before.settlements).toEqual([]);

    // positive control: the very same call shape on an ordinary pair succeeds
    const funded = await fund(
      f.projectId,
      bankSource.id,
      ordinaryTarget.id,
      "qa-ordinary-control",
    );
    expect(funded).toBeDefined();
    const after = await ledger();
    expect(after.settlements).toHaveLength(1);
    expect(after.settlements[0]).toMatchObject({
      mode: "ADDITIVE",
      sourceExpenseId: bankSource.id,
      targetExpenseId: ordinaryTarget.id,
      realValor: 100,
    });
    // the refund graph rows were not touched by the successful control
    const refundRows = (rows: { id: string }[]) =>
      rows.filter((r) => [f.source.id, applied.targetExpenseId].includes(r.id));
    expect(refundRows(after.expenses)).toEqual(refundRows(before.expenses));
    expect(after.allocations).toEqual(before.allocations);
  });

  // ── strong identity in both intents ──────────────────────────────────────
  const incoming = (over: Record<string, unknown>) => ({
    id: "qa-incoming",
    cardId: f.card.id,
    projectId: f.projectId,
    merchant: "Loja Sintetica 3/3",
    total: 3,
    seriesKey: null,
    externalId: "qa-incoming-external",
    dedupeKeyStrong: null,
    ...over,
  });
  const inspect = (
    purchase: ReturnType<typeof incoming>,
    intent: (typeof CARD_PURCHASE_INSPECTION)[keyof typeof CARD_PURCHASE_INSPECTION],
  ) =>
    prisma.$transaction((tx) =>
      inspectCardPurchaseCompanions(tx, f.tenantId, purchase, intent),
    );

  it("a strong external id or dedupe key of the credit source blocks IMPORT and RESTORE intents before and after the purpose is applied", async () => {
    await db.expense.update({
      where: { id: f.source.id },
      data: { dedupeKeyStrong: "qa-strong-refund" },
    });
    for (const phase of ["unlinked", "applied"]) {
      if (phase === "applied") await f.apply();
      const before = await ledger();
      for (const intent of Object.values(CARD_PURCHASE_INSPECTION)) {
        for (const identity of [
          { externalId: f.source.externalId },
          { dedupeKeyStrong: "qa-strong-refund" },
        ]) {
          await expect(
            inspect(incoming(identity), intent),
          ).rejects.toMatchObject({ status: 409 });
        }
      }
      // control: an unrelated identity is not blocked
      await expect(
        inspect(
          incoming({ externalId: "qa-unrelated" }),
          CARD_PURCHASE_INSPECTION.IMPORT,
        ),
      ).resolves.toMatchObject({ companions: [] });
      expect(await ledger()).toEqual(before);
    }
  });

  // ── restore never resurrects the refund graph ────────────────────────────
  it("CARD and BANK restore refuse a deleted credit source or owned target with a controlled 4xx, in preview and with a forged apply fingerprint, and change nothing", async () => {
    const applied = await f.apply();
    await expenses.remove(f.tenantId, f.projectId, f.source.id, f.requester);
    const bankAccount = await seedBankAccount(db, {
      tenantId: f.tenantId,
      projectId: f.projectId,
      last4: "7042",
    });
    const before = await ledger();
    expect(
      before.expenses.filter((r) => r.deletedAt !== null).map((r) => r.id),
    ).toEqual(expect.arrayContaining([f.source.id, applied.targetExpenseId]));

    const card = new RestoreImportedExpenseService(prisma);
    const bank = new RestoreImportedExpensesService(prisma);
    const forged = "0".repeat(64);
    for (const [projectId, expenseId] of [
      [f.projectId, f.source.id],
      [f.targetProjectId, applied.targetExpenseId],
    ] as const) {
      const scope = {
        tenantId: f.tenantId,
        projectId,
        cardId: f.card.id,
        importId: f.batch.id,
        expenseId,
      };
      controlled(
        await outcome(() =>
          card.restore(scope, f.requester, { mode: "preview" }),
        ),
      );
      controlled(
        await outcome(() =>
          card.restore(scope, f.requester, {
            mode: "apply",
            expectedFingerprint: forged,
          }),
        ),
      );
    }
    for (const mode of ["preview", "apply"] as const) {
      const body =
        mode === "preview"
          ? { mode, externalIds: [f.source.externalId as string] }
          : {
              mode,
              externalIds: [f.source.externalId as string],
              expectedFingerprint: forged,
            };
      controlled(
        await outcome(() =>
          bank.restore(
            {
              tenantId: f.tenantId,
              projectId: f.projectId,
              accountId: bankAccount.id,
            },
            f.requester,
            body,
          ),
        ),
      );
    }
    // deleted rows stay deleted, no CFE resurrected, nothing written (audit included)
    expect(await ledger()).toEqual(before);
  });
});
