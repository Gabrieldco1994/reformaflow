require("../../../../scripts/test-db-env.cjs");

import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  buildSeriesKey,
  CARD_PURCHASE_INSPECTION,
  inspectCardPurchaseCompanions,
} from "./card-purchase-identity";

/**
 * P01 D1 stale-proof: `seriesKey` is not editable, but a native financial edit
 * (`ExpenseService.update` of `quantidadeParcela`) leaves its total stale. A
 * key total that differs from the incoming line's full count releases the pair
 * ONLY when the row's ACTIVE cash-flow labels confirm that total. Contract:
 * PAGO counts as evidence (only deletedAt matters), 1..N completeness is not
 * required, missing/unreadable labels never confirm, any contradicting readable
 * label vetoes, and remaining `quantidadeParcela` is never a full count.
 */
const TENANT = "qa-p01-series-confirmation";
const OTHER_TENANT = "qa-p01-series-confirmation-other";
const P1 = `${TENANT}-p1`;
const P2 = `${TENANT}-p2`;
const P_DELETED = `${TENANT}-pdel`;
const CARD_A = `${TENANT}-card-a`;
const CARD_B = `${TENANT}-card-b`;
const IMPORT_A = `${TENANT}-imp-a`;
const IMPORT_B = `${TENANT}-imp-b`;
const NOW = new Date("2026-09-28T12:00:00.000Z");
const SERIES_A10 = buildSeriesKey(CARD_A, "QA LOJA", 10000, 10);
const SERIES_A3 = buildSeriesKey(CARD_A, "QA LOJA", 5000, 3);
const LABELS_3_TO_10 = [
  "3/10",
  "4/10",
  "5/10",
  "6/10",
  "7/10",
  "8/10",
  "9/10",
  "10/10",
];

describe("card purchase identity: series total needs current cash-flow confirmation", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const inspect = async (
    purchase: Partial<Parameters<typeof inspectCardPurchaseCompanions>[2]>,
    intent: "import" | "restore" = CARD_PURCHASE_INSPECTION.IMPORT,
  ) => {
    return prisma.$transaction((tx) =>
      inspectCardPurchaseCompanions(
        tx,
        TENANT,
        {
          cardId: CARD_A,
          projectId: P1,
          merchant: "QA LOJA",
          total: 3,
          seriesKey: SERIES_A3,
          externalId: "purchase-ext",
          dedupeKeyStrong: "purchase-strong",
          ...purchase,
        },
        intent,
      ),
    );
  };

  let seq = 0;
  const expense = (data: Record<string, unknown> = {}) => {
    seq += 1;
    return setup.expense.create({
      data: {
        id: `${TENANT}-e-${String(seq).padStart(5, "0")}`,
        tenantId: TENANT,
        projectId: P1,
        tipoDespesa: "OUTROS",
        titulo: "QA LOJA",
        fornecedor: "QA LOJA",
        valor: 10000,
        quantidade: 1,
        valorTotal: 80000,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 8,
        status: "PLANEJADO",
        seriesKey: SERIES_A10,
        cardLast4: "1234",
        importId: IMPORT_A,
        externalId: `ext-${seq}`,
        ...data,
      } as never,
    });
  };
  const cfe = (
    expenseId: string | null,
    data: Record<string, unknown> = {},
    tenantId = TENANT,
  ) => {
    seq += 1;
    return setup.cashFlowEntry.create({
      data: {
        id: `${tenantId}-cf-${String(seq).padStart(5, "0")}`,
        tenantId,
        projectId: tenantId === TENANT ? P1 : `${OTHER_TENANT}-p`,
        expenseId,
        valor: 10000,
        tipo: "DESPESA",
        categoria: "OUTROS",
        data: NOW,
        status: "PLANEJADO",
        formaPagamento: "CARTAO_CREDITO",
        ...data,
      } as never,
    });
  };
  const bulkExpenses = async (rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += 100)
      await setup.expense.createMany({ data: rows.slice(i, i + 100) as never });
  };

  async function wipe() {
    for (const tenantId of [TENANT, OTHER_TENANT]) {
      await setup.cashFlowEntry.deleteMany({ where: { tenantId } });
      await setup.receipt.deleteMany({ where: { tenantId } });
      await setup.expense.deleteMany({ where: { tenantId } });
      await setup.creditCardStatementImport.deleteMany({ where: { tenantId } });
      await setup.creditCard.deleteMany({ where: { tenantId } });
      await setup.project.deleteMany({ where: { tenantId } });
      await setup.tenant.deleteMany({ where: { id: tenantId } });
    }
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.$connect();
  });
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
    await setup.$disconnect();
  });
  beforeEach(async () => {
    seq = 0;
    await wipe();
    await setup.tenant.createMany({
      data: [
        { id: TENANT, name: "scope" },
        { id: OTHER_TENANT, name: "other" },
      ],
    });
    await setup.project.createMany({
      data: [
        { id: P1, tenantId: TENANT, type: "PESSOAL", name: "p1" },
        { id: P2, tenantId: TENANT, type: "PESSOAL", name: "p2" },
        {
          id: P_DELETED,
          tenantId: TENANT,
          type: "PESSOAL",
          name: "pd",
          deletedAt: NOW,
        },
        {
          id: `${OTHER_TENANT}-p`,
          tenantId: OTHER_TENANT,
          type: "PESSOAL",
          name: "op",
        },
      ],
    });
    for (const [id, last4] of [
      [CARD_A, "1234"],
      [CARD_B, "1234"],
    ] as const)
      await setup.creditCard.create({
        data: {
          id,
          tenantId: TENANT,
          projectId: P1,
          institution: "ITAU",
          brand: "Visa",
          nickname: id,
          last4,
        },
      });
    await setup.creditCardStatementImport.createMany({
      data: [
        {
          id: IMPORT_A,
          tenantId: TENANT,
          cardId: CARD_A,
          periodLabel: "a",
          source: "OFX",
        },
        {
          id: IMPORT_B,
          tenantId: TENANT,
          cardId: CARD_B,
          periodLabel: "b",
          source: "OFX",
        },
      ],
    });
  });

  const withLabels = async (
    labels: (string | null)[],
    row: Record<string, unknown> = {},
    status = "PLANEJADO",
  ) => {
    const created = await expense(row);
    for (const parcela of labels) await cfe(created.id, { parcela, status });
    return created;
  };
  const expectReleased = async (purchase = {}) => {
    const out = await inspect(purchase);
    expect(out.companions).toEqual([]);
    expect(out.receipts).toEqual([]);
  };
  const expectConservative = async (purchase = {}) => {
    await expect(inspect(purchase)).rejects.toBeInstanceOf(ConflictException);
  };

  // ── Released: the key total is confirmed by current cash flow ────────────

  it("releases when active labels 3/10..10/10 confirm total 10 (remaining count 8 is not the full count)", async () => {
    await withLabels(LABELS_3_TO_10);
    await expectReleased();
  });
  it("releases when every confirming cash flow is PAGO (paid is evidence, not absence)", async () => {
    await withLabels(LABELS_3_TO_10, {}, "PAGO");
    await expectReleased();
  });
  it("releases with some PAGO and some PLANEJADO confirming labels", async () => {
    const row = await expense();
    await cfe(row.id, { parcela: "3/10", status: "PAGO" });
    await cfe(row.id, { parcela: "4/10", status: "PLANEJADO" });
    await expectReleased();
  });
  it("does not require a complete 1..N list: one readable confirming label is enough", async () => {
    await withLabels(["7/10"]);
    await expectReleased();
  });
  it("ignores null/unreadable labels next to a confirming one", async () => {
    await withLabels([null, "junk", "7/10"]);
    await expectReleased();
  });
  it("ignores a soft-deleted contradicting label; only active cash flow is current state", async () => {
    const row = await withLabels(["7/10"]);
    await cfe(row.id, { parcela: "1/3", deletedAt: NOW });
    await expectReleased();
  });

  // ── Conservative: stale, missing or contradicted evidence ────────────────

  it("stays conservative without any cash flow", async () => {
    await expense();
    await expectConservative();
  });
  it("stays conservative when labels are null", async () => {
    await withLabels([null, null]);
    await expectConservative();
  });
  it("stays conservative when labels are unreadable (0/1, 2/1, 4/3, text)", async () => {
    await withLabels(["0/1", "2/1", "4/3", "parcela"]);
    await expectConservative();
  });
  // The cash-flow generator emits `${i + 1}/${n}` with n >= 1, so "1/1" is a
  // readable N/M label (a single-installment schedule), not unreadable noise.
  it("a readable 1/1 label contradicts key total 10 and vetoes alone", async () => {
    await withLabels(["1/1"]);
    await expectConservative();
  });
  it("a readable 1/1 label vetoes beside a confirming 3/10 (mixture never releases)", async () => {
    await withLabels(["3/10", "1/1"]);
    await expectConservative();
  });
  it("an unreadable 0/1 or 2/1 beside a confirming label is still ignored", async () => {
    await withLabels(["3/10", "0/1", "2/1"]);
    await expectReleased();
  });
  it("stays conservative when only soft-deleted labels would confirm", async () => {
    const row = await expense();
    await cfe(row.id, { parcela: "3/10", deletedAt: NOW });
    await expectConservative();
  });
  it("stays conservative when every active label contradicts the key (edited 8 -> 3)", async () => {
    await withLabels(["1/3", "2/3", "3/3"], { quantidadeParcela: 3 });
    await expectConservative();
  });
  it("a contradicting readable label vetoes even beside confirming ones", async () => {
    await withLabels(["3/10", "4/10", "1/3"]);
    await expectConservative();
  });
  it("never reads remaining quantidadeParcela as the full count", async () => {
    // 3 remaining looks like the incoming full count, yet the key says 10 and
    // there is no confirming label: still conservative, not 'same N'.
    await withLabels([], { quantidadeParcela: 3 });
    await expectConservative();
  });
  it("title marker contradicting the key still vetoes despite confirming labels", async () => {
    await withLabels(LABELS_3_TO_10, { titulo: "QA LOJA (2/5)" });
    await expectConservative();
  });
  it("title alone (no confirming labels) never releases", async () => {
    await withLabels([], { titulo: "QA LOJA (3/10)" });
    await expectConservative();
  });

  // ── Independent guards keep working ──────────────────────────────────────

  it("strong externalId still blocks a confirmed-different series", async () => {
    await withLabels(LABELS_3_TO_10, { externalId: "purchase-ext" });
    await expectConservative();
  });
  it("same full count stays a family even with confirming labels", async () => {
    await withLabels(LABELS_3_TO_10);
    await expectConservative({ total: 10, seriesKey: SERIES_A10 });
  });

  // ── RESTORE keeps its own contract (labels never facilitate it) ──────────

  it("RESTORE ignores label confirmation: a live companion always conflicts", async () => {
    await withLabels(LABELS_3_TO_10);
    await expect(
      inspect({}, CARD_PURCHASE_INSPECTION.RESTORE),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("RESTORE returns the same companions whether or not labels confirm", async () => {
    await withLabels(LABELS_3_TO_10, { deletedAt: NOW });
    const confirmed = await inspect({}, CARD_PURCHASE_INSPECTION.RESTORE).catch(
      (e) => e,
    );
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    const bare = await inspect({}, CARD_PURCHASE_INSPECTION.RESTORE).catch(
      (e) => e,
    );
    // Tombstone with CFEs blocks; tombstone without CFEs is returned.
    expect(confirmed).toBeInstanceOf(ConflictException);
    expect(bare.companions).toHaveLength(1);
    expect(bare.unowned).toEqual([]);
  });

  // ── Cohort size: never lose candidates beyond the 999-parameter ceiling ──

  it("1281 confirming rows are all released, and a late unconfirmed row still blocks", async () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 1281; i++)
      rows.push({
        id: `${TENANT}-bulk-${String(i).padStart(5, "0")}`,
        tenantId: TENANT,
        projectId: P1,
        tipoDespesa: "OUTROS",
        titulo: "QA LOJA",
        fornecedor: "QA LOJA",
        valor: 10000,
        quantidade: 1,
        valorTotal: 80000,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 8,
        status: "PLANEJADO",
        seriesKey: SERIES_A10,
        cardLast4: "1234",
        importId: IMPORT_A,
      });
    await bulkExpenses(rows);
    for (let i = 0; i < rows.length; i += 100)
      await setup.cashFlowEntry.createMany({
        data: rows.slice(i, i + 100).map((row, j) => ({
          id: `${TENANT}-bulkcf-${String(i + j).padStart(5, "0")}`,
          tenantId: TENANT,
          projectId: P1,
          expenseId: row.id,
          valor: 10000,
          tipo: "DESPESA",
          categoria: "OUTROS",
          data: NOW,
          status: "PAGO",
          formaPagamento: "CARTAO_CREDITO",
          parcela: "3/10",
        })) as never,
      });
    await expectReleased();
    await setup.cashFlowEntry.updateMany({
      where: { id: `${TENANT}-bulkcf-01280` },
      data: { parcela: "1/3" },
    });
    await expectConservative();
    await withLabels([]);
    await expectConservative();
  });
});
