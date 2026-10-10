/**
 * #704 R3 QA — ledger evidence must not cross table namespaces.
 *
 * Expense.id, CashFlowEntry.id and ImportedInvoiceLiquidation columns live in different tables, so an
 * Expense.id may legitimately equal the CashFlowEntry.id of ANOTHER purchase. The pre-refactor query
 * asked "payment/purchase IN expense ids OR cashFlowEntryId IN cash-flow ids". `RemovalContext.ledgerOf`
 * merges both id sets and lets every keyer of the index test the union, so a liquidation that a
 * neighbouring row pulled into a batched context can become evidence of a purchase it never touched.
 * The same purchase read alone (N=1, what DELETE plans) would not load that row.
 *
 * Every id collision below is BETWEEN models (valid FKs, real PrismaService); no table holds a duplicate.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import {
  seedBankAccount,
  seedStatementImport,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { refundFixture } from "./__tests__/refund-purpose.fixture";
import { ExpenseService } from "./expense.service";

const removalContext = (() => {
  try {
    return require("./removal-context");
  } catch {
    return null; // pre-refactor tree
  }
})();

const db = new PrismaClient();
const prisma = new PrismaService();
const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));

type Fixture = Awaited<ReturnType<typeof refundFixture>>;
let f: Fixture;
let importId = "";

const negative = (over: Record<string, unknown> = {}) =>
  db.expense.create({
    data: {
      tenantId: f.tenantId,
      projectId: f.projectId,
      tipoDespesa: "OUTROS",
      valor: -1000,
      valorTotal: -1000,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PAGO",
      dataPagamento: new Date("2026-09-10T00:00:00Z"),
      ...over,
    } as never,
  });
const cfeFor = (expenseId: string, over: Record<string, unknown> = {}) =>
  db.cashFlowEntry.create({
    data: {
      tenantId: f.tenantId,
      projectId: f.projectId,
      expenseId,
      valor: -1000,
      tipo: "DESPESA",
      data: new Date("2026-09-10T00:00:00Z"),
      categoria: "OUTROS",
      formaPagamento: "A_VISTA",
      status: "PAGO",
      ...over,
    } as never,
  });
const claim = (expenseId: string, cashFlowEntryId: string) =>
  db.importedInvoiceLiquidation.create({
    data: {
      tenantId: f.tenantId,
      paymentExpenseId: expenseId,
      purchaseExpenseId: expenseId,
      importId,
      cashFlowEntryId,
      cardId: f.card.id,
      prevStatus: "PLANEJADO",
      entryValorCents: 100,
      dueMonth: "2026-09",
    } as never,
  });
/** A second refund-eligible purchase, applied through the real service (own expense + own CFE). */
async function appliedPurpose(tag: string) {
  const { id: _i, createdAt: _c, updatedAt: _u, ...base } = f.source;
  const source = await db.expense.create({
    data: { ...base, externalId: `ns-${tag}` } as never,
  });
  const { id: _ci, createdAt: _cc, updatedAt: _cu, ...cfe } = f.cfe;
  const sourceCfe = await db.cashFlowEntry.create({
    data: { ...cfe, expenseId: source.id } as never,
  });
  const preview = await f.service.execute(
    f.tenantId,
    f.projectId,
    source.id,
    f.requester,
    { mode: "preview", targetProjectId: f.targetProjectId, roomId: null },
  );
  await f.service.execute(f.tenantId, f.projectId, source.id, f.requester, {
    mode: "apply",
    targetProjectId: f.targetProjectId,
    roomId: null,
    expectedRevision: preview.revision,
    expectedFingerprint: preview.fingerprint,
  });
  const edge = await db.rateioAllocation.findFirstOrThrow({
    where: { sourceExpenseId: source.id },
  });
  return { source, sourceCfe, targetId: edge.targetExpenseId };
}
const capsOf = async (rows: Array<{ id: string }>) => {
  const loaded = await db.expense.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  const order = new Map(rows.map((r, i) => [r.id, i]));
  loaded.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const out = await expenses.withDeleteCapabilities(
    f.tenantId,
    loaded as never,
    f.requester as never,
  );
  return Object.fromEntries(
    out.map((r) => [r.id, (r as { canDelete?: boolean }).canDelete]),
  );
};
/** The pre-refactor question, asked literally through the ORM. */
const oldLedgerIds = async (expenseIds: string[]) => {
  const cfeIds = (
    await db.cashFlowEntry.findMany({
      where: { expenseId: { in: expenseIds } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const rows = await db.importedInvoiceLiquidation.findMany({
    where: {
      tenantId: f.tenantId,
      OR: [
        { paymentExpenseId: { in: expenseIds } },
        { purchaseExpenseId: { in: expenseIds } },
        { cashFlowEntryId: { in: cfeIds } },
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id).sort();
};
const contextLedgerIds = (sources: string[], graph: string[]) =>
  prisma.$transaction(async (tx) => {
    const ctx = new removalContext.RemovalContext(f.tenantId);
    await removalContext.loadRefundFacts(tx, ctx, sources);
    return (ctx.ledgerOf(graph) as Array<{ id: string }>)
      .map((r) => r.id)
      .sort();
  });

describe("#704 R3 QA ledger evidence is per namespace (cross-model id collisions)", () => {
  beforeAll(async () => {
    f = await refundFixture(db, prisma, "refund-r3-ns");
    const account = await seedBankAccount(db, {
      tenantId: f.tenantId,
      projectId: f.projectId,
      last4: "0707",
    });
    importId = `${f.tenantId}-imp`;
    await seedStatementImport(db, {
      tenantId: f.tenantId,
      accountId: account.id,
      id: importId,
    });
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
    await db.$disconnect();
    await prisma.$disconnect();
  });

  it("neighbour's liquidation whose CFE id equals this purchase's EXPENSE id is not this purchase's evidence", async () => {
    const a = await appliedPurpose("a");
    const b = await negative();
    const bCfe = await cfeFor(b.id, { id: a.source.id }); // CashFlowEntry.id === Expense.id of A (different tables)
    const l = await claim(b.id, bCfe.id);
    expect(bCfe.id).toBe(a.source.id);
    const graph = [a.source.id, a.targetId];

    expect(await oldLedgerIds(graph)).toEqual([]); // literal old query: nothing touches A

    const alone = await capsOf([a.source]);
    const batch = await capsOf([a.source, b]);
    expect(alone[a.source.id]).toBe(true);
    expect(batch[a.source.id]).toBe(true); // one purchase's answer must not depend on who else is in the page
    expect(batch[b.id]).toBe(false); // B really is claimed
    void l;
  });

  it("neighbour's liquidation whose payment/purchase id equals this purchase's CASH-FLOW id is not this purchase's evidence", async () => {
    const a = await appliedPurpose("c");
    const x = await negative({ id: a.sourceCfe.id }); // Expense.id === CashFlowEntry.id of A (different tables)
    const xCfe = await cfeFor(x.id);
    await claim(x.id, xCfe.id);
    expect(x.id).toBe(a.sourceCfe.id);
    const graph = [a.source.id, a.targetId];

    expect(await oldLedgerIds(graph)).toEqual([]);

    const alone = await capsOf([a.source]);
    const batch = await capsOf([a.source, x]);
    expect(alone[a.source.id]).toBe(true);
    expect(batch[a.source.id]).toBe(true);
    expect(batch[x.id]).toBe(false);
  });

  const itCtx = removalContext ? it : it.skip;
  itCtx(
    "context ledgerOf equals the old query, ids exactly (CFE id === Expense id)",
    async () => {
      const a = await appliedPurpose("ctx1");
      const b = await negative();
      const bCfe = await cfeFor(b.id, { id: a.source.id });
      const l = await claim(b.id, bCfe.id);
      const graph = [a.source.id, a.targetId];
      expect(await oldLedgerIds(graph)).toEqual([]);
      expect(await oldLedgerIds([b.id])).toEqual([l.id]); // the row exists and is B's
      expect(await contextLedgerIds([a.source.id, b.id], graph)).toEqual(
        await oldLedgerIds(graph),
      );
    },
  );
  itCtx(
    "context ledgerOf equals the old query, ids exactly (Expense id === CFE id)",
    async () => {
      const a = await appliedPurpose("ctx2");
      const x = await negative({ id: a.sourceCfe.id });
      const xCfe = await cfeFor(x.id);
      const l = await claim(x.id, xCfe.id);
      const graph = [a.source.id, a.targetId];
      expect(await oldLedgerIds(graph)).toEqual([]);
      expect(await oldLedgerIds([x.id])).toEqual([l.id]);
      expect(await contextLedgerIds([a.source.id, x.id], graph)).toEqual(
        await oldLedgerIds(graph),
      );
    },
  );

  it("the same page in either order gives the same answers, and DELETE agrees with the answer", async () => {
    const a = await appliedPurpose("d");
    const b = await negative();
    await claim(b.id, (await cfeFor(b.id, { id: a.source.id })).id);
    const ab = await capsOf([a.source, b]);
    const ba = await capsOf([b, a.source]);
    const alone = await capsOf([a.source]);
    let del: "ok" | number = "ok";
    try {
      await expenses.remove(
        f.tenantId,
        f.projectId,
        a.source.id,
        f.requester as never,
      );
    } catch (e) {
      del = (e as { status?: number }).status ?? -1;
    }
    const deleted =
      (await db.expense.findUniqueOrThrow({ where: { id: a.source.id } }))
        .deletedAt !== null;
    // One object so a red run shows the whole observable effect at once.
    expect({
      ab: ab[a.source.id],
      ba: ba[a.source.id],
      alone: alone[a.source.id],
      del,
      deleted,
    }).toEqual({
      ab: true,
      ba: true,
      alone: true,
      del: "ok",
      deleted: true,
    });
  });
});
