import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { seedBankAccount } from "../bank-account/__tests__/invoice-undo.fixtures";
import { ExpenseService } from "./expense.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { applyParcelaFunding } from "../conciliacao/additive-settlement";
import { CreditCardService } from "../credit-card/credit-card.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import {
  CARD_PURCHASE_INSPECTION,
  inspectCardPurchaseCompanions,
} from "../credit-card/card-purchase-identity";
import { RestoreImportedExpenseService } from "../credit-card/restore-imported-expense.service";
import { RestoreImportedExpensesService } from "../bank-account/restore-imported-expenses.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { TenantFinancialService } from "../tenant-financial/tenant-financial.service";
import { parseStoredExpenseSchedule } from "./documented-schedule";

/**
 * #704 x #700/#701/#705/#706/#708 interplay. Each case drives the real services
 * against the disposable SQLite DB and compares full financial snapshots; none
 * of them redefines an existing rule of the neighbouring features.
 */
describe("#704 refund purpose next to CARD/BANK restore, funding, schedules and yearly carry", () => {
  const db = new PrismaClient();
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  const cards = new CreditCardService(
    prisma,
    conciliacao,
    new MerchantClassifierService(prisma),
  );
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  const tenantFinancial = new TenantFinancialService(prisma, monthly);
  let f: Awaited<ReturnType<typeof refundFixture>>;

  beforeEach(async () => {
    f = await refundFixture(db, prisma, "refund-interplay");
  });
  afterEach(async () => {
    await f.cleanup();
  });
  afterAll(async () => {
    await db.$disconnect();
    await prisma.$disconnect();
  });

  /** Every persisted financial row of the tenant, ordered, nothing masked. */
  const snapshot = async () => {
    const where = { tenantId: f.tenantId };
    const orderBy = { id: "asc" as const };
    return {
      expenses: await db.expense.findMany({ where, orderBy }),
      cash: await db.cashFlowEntry.findMany({ where, orderBy }),
      allocations: await db.rateioAllocation.findMany({ where, orderBy }),
      settlements: await db.crossProjectSettlement.findMany({ where, orderBy }),
      imports: await db.creditCardStatementImport.findMany({ where, orderBy }),
      receipts: await db.receipt.findMany({ where, orderBy }),
      accounts: await db.bankAccount.findMany({ where, orderBy }),
    };
  };
  const purchase = (over: Record<string, unknown> = {}) => ({
    id: "incoming-purchase",
    cardId: f.card.id,
    projectId: f.projectId,
    merchant: "Loja Sintetica 3/3",
    total: 3,
    seriesKey: null,
    externalId: "incoming-external",
    dedupeKeyStrong: null,
    ...over,
  });

  // ─── #700 / fix66f: import and restore intents ────────────────────────────
  it("an active refund source and its owned target are never companions of a same-merchant purchase, in either intent", async () => {
    await db.expense.update({
      where: { id: f.source.id },
      data: { fornecedor: "Loja Sintetica", titulo: "Loja Sintetica" },
    });
    await f.apply();
    const before = await snapshot();
    for (const intent of Object.values(CARD_PURCHASE_INSPECTION)) {
      const result = await prisma.$transaction((tx) =>
        inspectCardPurchaseCompanions(tx, f.tenantId, purchase(), intent),
      );
      expect(result.companions).toEqual([]);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("the refund source identity still blocks an import that reuses its external id (import intent keeps strong identities)", async () => {
    await f.apply();
    await expect(
      prisma.$transaction((tx) =>
        inspectCardPurchaseCompanions(
          tx,
          f.tenantId,
          purchase({ externalId: f.source.externalId }),
          CARD_PURCHASE_INSPECTION.IMPORT,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  // ─── #700 CARD restore ────────────────────────────────────────────────────
  it("CARD restore cannot resurrect a deleted refund source nor its owned target, and writes nothing", async () => {
    const result = await f.apply();
    await expenses.remove(f.tenantId, f.projectId, f.source.id, f.requester);
    const before = await snapshot();
    const restore = new RestoreImportedExpenseService(prisma);
    await expect(
      restore.restore(
        {
          tenantId: f.tenantId,
          projectId: f.projectId,
          cardId: f.card.id,
          importId: f.batch.id,
          expenseId: f.source.id,
        },
        f.requester,
        { mode: "preview" },
      ),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(
      restore.restore(
        {
          tenantId: f.tenantId,
          projectId: f.targetProjectId,
          cardId: f.card.id,
          importId: f.batch.id,
          expenseId: result.targetExpenseId,
        },
        f.requester,
        { mode: "preview" },
      ),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await snapshot()).toEqual(before);
    expect(
      await db.expense.findUnique({ where: { id: result.targetExpenseId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it("undoing the import twice is idempotent and a second batch undo never touches the refund graph", async () => {
    const other = await db.creditCardStatementImport.create({
      data: {
        tenantId: f.tenantId,
        cardId: f.card.id,
        source: "CSV_GENERIC",
        periodLabel: "2026-08",
      },
    });
    await f.apply();
    const before = await snapshot();
    await cards.undoImport(
      f.tenantId,
      f.projectId,
      f.card.id,
      other.id,
      f.requester,
    );
    const afterOther = await snapshot();
    expect(afterOther.allocations).toEqual(before.allocations);
    expect(afterOther.expenses).toEqual(before.expenses);
    expect(afterOther.cash).toEqual(before.cash);
    await cards.undoImport(
      f.tenantId,
      f.projectId,
      f.card.id,
      f.batch.id,
      f.requester,
    );
    const once = await snapshot();
    expect(once.allocations).toEqual([]);
    await expect(
      cards.undoImport(
        f.tenantId,
        f.projectId,
        f.card.id,
        f.batch.id,
        f.requester,
      ),
    ).resolves.toMatchObject({ alreadyUndone: true });
    expect(await snapshot()).toEqual(once);
  });

  // ─── #705 BANK ────────────────────────────────────────────────────────────
  it("a BANK-identified negative debit is refused by the card-credit contract without writes", async () => {
    const account = await seedBankAccount(db, {
      tenantId: f.tenantId,
      projectId: f.projectId,
      last4: "7050",
    });
    for (const identity of [
      { bankLast4: account.last4 },
      { accountId: account.id },
      { bankLast4: account.last4, accountId: account.id },
    ]) {
      await db.expense.update({
        where: { id: f.source.id },
        data: identity,
      });
      const before = await snapshot();
      await expect(
        f.service.execute(f.tenantId, f.projectId, f.source.id, f.requester, {
          mode: "preview",
          targetProjectId: f.targetProjectId,
          roomId: null,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
      await db.expense.update({
        where: { id: f.source.id },
        data: { bankLast4: null, accountId: null },
      });
    }
  });

  it("BANK restore of proven debits does not accept the card refund source id and keeps the graph intact", async () => {
    const account = await seedBankAccount(db, {
      tenantId: f.tenantId,
      projectId: f.projectId,
      last4: "7051",
    });
    await f.apply();
    await expenses.remove(f.tenantId, f.projectId, f.source.id, f.requester);
    const before = await snapshot();
    const bank = new RestoreImportedExpensesService(prisma);
    const outcome = await bank
      .restore(
        {
          tenantId: f.tenantId,
          projectId: f.projectId,
          accountId: account.id,
        },
        f.requester,
        {
          mode: "preview",
          externalIds: [f.source.externalId as string],
        },
      )
      .then(
        (value) => ({ value }),
        (error: { status?: number }) => ({ error }),
      );
    if ("value" in outcome)
      expect(JSON.stringify(outcome.value)).not.toContain(f.source.id);
    expect(await snapshot()).toEqual(before);
  });

  // ─── #706 funding / partial settlement ────────────────────────────────────
  it("an active funding on the source refuses the purpose; a funding command cannot target the refund credit afterwards", async () => {
    const planned = await db.expense.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.targetProjectId,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: 30000,
        valorTotal: 90000,
        quantidade: 3,
        quantidadeParcela: 3,
        formaPagamento: "PARCELADO",
        status: "PLANEJADO",
        dataInicioParcela: new Date("2026-10-10T00:00:00Z"),
      },
    });
    const targetCfe = (status: string) =>
      db.cashFlowEntry.create({
        data: {
          tenantId: f.tenantId,
          projectId: f.targetProjectId,
          expenseId: planned.id,
          valor: 100,
          tipo: "DESPESA",
          data: new Date("2026-10-10T00:00:00Z"),
          categoria: "MATERIAL_CONSTRUCAO",
          formaPagamento: "PARCELADO",
          status,
        },
      });
    const paid = await targetCfe("PAGO");
    const pending = await targetCfe("PLANEJADO");
    await db.crossProjectSettlement.create({
      data: {
        tenantId: f.tenantId,
        sourceExpenseId: f.source.id,
        targetExpenseId: planned.id,
        parcelaIndex: 0,
        realValor: 100,
        plannedValor: 30000,
        plannedStatus: "PLANEJADO",
        mode: "ADDITIVE",
        requestId: "synthetic-active-funding",
        createdByUserId: f.requester.id,
        sourceCashFlowEntryId: f.cfe.id,
        targetPaidCashFlowEntryId: paid.id,
        targetPendingCashFlowEntryId: pending.id,
        snapshot: "{}",
      },
    });
    const withFunding = await snapshot();
    await expect(
      f.service.execute(f.tenantId, f.projectId, f.source.id, f.requester, {
        mode: "preview",
        targetProjectId: f.targetProjectId,
        roomId: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(withFunding);

    await db.crossProjectSettlement.deleteMany({
      where: { tenantId: f.tenantId },
    });
    const applied = await f.apply();
    const before = await snapshot();
    await expect(
      applyParcelaFunding(
        prisma,
        f.tenantId,
        f.projectId,
        f.source.id,
        {
          mode: "ADDITIVE",
          targetExpenseId: applied.targetExpenseId,
          parcelaIndex: 0,
          amountCents: 100,
          requestId: "refund-interplay-funding",
        },
        f.requester,
      ),
    ).rejects.toBeDefined();
    expect(await snapshot()).toEqual(before);
    // direct edits of the linked source financial fields stay guarded too
    await expect(
      expenses.remove(
        f.tenantId,
        f.targetProjectId,
        applied.targetExpenseId,
        f.requester,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });

  // ─── #701 documented schedule (negative values are legitimate there) ──────
  const scheduleFor = (
    expenseId: string,
    valor: number,
    parcela = "3/3",
  ): string =>
    JSON.stringify({
      version: 1,
      kind: "source",
      tenantId: f.tenantId,
      sourceExpenseId: expenseId,
      sourceProjectId: f.projectId,
      cardId: f.card.id,
      recordedByUserId: f.requester.id,
      recordedAt: "2026-09-01T12:00:00.000Z",
      importId: f.batch.id,
      externalId: `schedule-${expenseId}`,
      occurrences: [
        {
          index: 0,
          parcela,
          valor,
          data: "2026-09-10",
          invoiceDueMonth: null,
          amountEvidence: null,
          cycleEvidence: null,
        },
      ],
      projections: [],
      lastOperation: null,
    });

  it("the purpose action neither rewrites nor rejects an unrelated negative documented schedule (-248), and leaves it in the ledger", async () => {
    const documentedId = "interplay-documented-negative";
    const schedule = scheduleFor(documentedId, -248);
    expect(parseStoredExpenseSchedule(schedule)).toMatchObject({
      kind: "source",
    });
    await db.expense.create({
      data: {
        id: documentedId,
        tenantId: f.tenantId,
        projectId: f.projectId,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: -248,
        valorTotal: -248,
        quantidade: 1,
        quantidadeParcela: 3,
        formaPagamento: "PARCELADO",
        status: "PLANEJADO",
        cardLast4: f.card.last4,
        importId: f.batch.id,
        externalId: `schedule-${documentedId}`,
        dataInicioParcela: new Date("2026-09-10T00:00:00Z"),
        documentedSchedule: schedule,
      },
    });
    await db.cashFlowEntry.create({
      data: {
        tenantId: f.tenantId,
        projectId: f.projectId,
        expenseId: documentedId,
        valor: -248,
        tipo: "DESPESA",
        data: new Date("2026-09-10T00:00:00Z"),
        categoria: "MATERIAL_CONSTRUCAO",
        formaPagamento: "CARTAO_CREDITO",
        status: "PLANEJADO",
        parcela: "3/3",
      },
    });
    const before = await snapshot();
    const applied = await f.apply();
    const after = await snapshot();
    const untouched = (rows: { id: string }[]) =>
      rows.find((row) => row.id === documentedId);
    expect(untouched(after.expenses)).toEqual(untouched(before.expenses));
    expect(after.cash.filter((row) => row.expenseId === documentedId)).toEqual(
      before.cash.filter((row) => row.expenseId === documentedId),
    );
    expect(after.cash.filter((row) => row.expenseId === f.source.id)).toEqual(
      before.cash.filter((row) => row.expenseId === f.source.id),
    );
    // only the refund graph moved: one target, one CFE, one allocation, source link/revision
    expect(after.expenses.length).toBe(before.expenses.length + 1);
    expect(after.cash.length).toBe(before.cash.length + 1);
    expect(after.allocations).toHaveLength(1);
    const target = after.expenses.find(
      (row) => row.id === applied.targetExpenseId,
    );
    expect(target?.documentedSchedule).toBeNull();
    // undo returns to the exact pre-apply ledger (source revision aside)
    await f.service.undo(
      f.tenantId,
      f.projectId,
      f.source.id,
      f.requester,
      { expectedRevision: applied.revision },
    );
    const undone = await snapshot();
    expect(untouched(undone.expenses)).toEqual(untouched(before.expenses));
    expect(undone.allocations).toEqual([]);
  });

  it("a documented schedule on the credit source itself is preserved byte-for-byte by apply and undo, and the credit is counted once", async () => {
    const schedule = scheduleFor(f.source.id, -12345, "1/1");
    await db.expense.update({
      where: { id: f.source.id },
      data: { documentedSchedule: schedule },
    });
    const applied = await f.apply();
    const linked = await db.expense.findUniqueOrThrow({
      where: { id: f.source.id },
    });
    expect(linked.documentedSchedule).toBe(schedule);
    const all = await monthly.getOverview(
      f.tenantId,
      f.projectId,
      "2026-09",
      f.requester,
    );
    expect(
      all.entries.filter((row) => !row.isEspelho).map((row) => row.valor),
    ).toEqual([-12345]);
    await f.service.undo(
      f.tenantId,
      f.projectId,
      f.source.id,
      f.requester,
      { expectedRevision: applied.revision },
    );
    expect(
      (await db.expense.findUniqueOrThrow({ where: { id: f.source.id } }))
        .documentedSchedule,
    ).toBe(schedule);
  });

  // ─── #708 yearly carry consumes these readers ─────────────────────────────
  it("yearly account view and consolidated series do not move on apply or undo (carry input stays cash-real)", async () => {
    const year = async () => ({
      account: await monthly.getAccountViewYearly(
        f.tenantId,
        f.projectId,
        "2026",
        f.requester,
      ),
      invoices: await monthly.getCardInvoicesYearly(
        f.tenantId,
        f.projectId,
        "2026",
        f.requester,
      ),
    });
    const before = await year();
    const applied = await f.apply();
    expect(await year()).toEqual(before);
    await f.service.undo(
      f.tenantId,
      f.projectId,
      f.source.id,
      f.requester,
      { expectedRevision: applied.revision },
    );
    expect(await year()).toEqual(before);
    expect(tenantFinancial).toBeDefined();
  });
});
