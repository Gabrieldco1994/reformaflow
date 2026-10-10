require("../../../../scripts/test-db-env.cjs");

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PaymentForm, buildInstallments } from "@reformaflow/domain";
import { PrismaClient } from "@prisma/client";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { CreditCardService } from "./credit-card.service";
import { parseStatement } from "./parsers";

/**
 * P04 (RED, test-only): two IDENTICAL installment purchases in ONE card statement
 * ("QA GEMEA LOJA 1/10", 2026-09-05, 69.84 x 10 = 69840 total each). Each twin is
 * its own purchase: 2 Expenses of 69840 and 2 x 10 CashFlowEntries of 6984.
 * Real CSV parser, real PrismaService and real CreditCardService; raw Prisma only
 * seeds and reads. Nothing here mocks the financial rules. The Expenses/entries a commit creates are future debt;
 * what is asserted untouched is cash, payment and settlement.
 *
 * Every scenario records what it OBSERVED (P04_EVIDENCE_DIR, mode 0600) BEFORE it
 * asserts, so a red assertion never loses the data. Expectations are literals.
 */
const TENANT = "qa-p04-twins";
const PROJECT = `${TENANT}-pessoal`;
const ACTOR = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const CLOCK = new Date("2026-09-28T12:00:00.000Z");
const TWIN = "2026-09-05,QA GEMEA LOJA 1/10,69.84";
const TWIN_NEXT_DAY = "2026-09-06,QA GEMEA LOJA 1/10,69.84";
// Installment dates of ONE purchase, pinned by the single-line controls on this frozen SHA
// (installment 1 is dated on the purchase day, then one month apart).
const DATES_0905 = [
  "2026-09-05",
  "2026-10-05",
  "2026-11-05",
  "2026-12-05",
  "2027-01-05",
  "2027-02-05",
  "2027-03-05",
  "2027-04-05",
  "2027-05-05",
  "2027-06-05",
];
const DATES_0906 = [
  "2026-09-06",
  "2026-10-06",
  "2026-11-06",
  "2026-12-06",
  "2027-01-06",
  "2027-02-06",
  "2027-03-06",
  "2027-04-06",
  "2027-05-06",
  "2027-06-06",
];
const LABELS = Array.from({ length: 10 }, (_, i) => `${i + 1}/10`);
const EVIDENCE_DIR = process.env.P04_EVIDENCE_DIR;

type CommitResult = Awaited<ReturnType<CreditCardService["commitImport"]>>;
type PreviewResult = Awaited<ReturnType<CreditCardService["previewImport"]>>;

describe("P04 identical installment twins in one statement (RED)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const cards = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  let cardId: string;
  let observedSeq = 0;

  const record = (name: string, data: unknown) => {
    if (!EVIDENCE_DIR) return;
    mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
    observedSeq += 1;
    const file = join(
      EVIDENCE_DIR,
      `${String(observedSeq).padStart(3, "0")}-${name}.json`,
    );
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  };

  const doc = (...rows: string[]) => `date,title,amount\n${rows.join("\n")}\n`;
  const parsed = (csv: string) =>
    parseStatement(csv, cardId, "CSV_GENERIC", "s.csv").transactions;
  // `selected` is the trailing selectedExternalIds argument of commitImport.
  const commit = (csv: string, selected?: string[]): Promise<CommitResult> =>
    cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      "s.csv",
      "CSV_GENERIC",
      undefined,
      undefined,
      undefined,
      ACTOR.id,
      ACTOR,
      selected,
    );
  const preview = (csv: string): Promise<PreviewResult> =>
    cards.previewImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      "s.csv",
      "CSV_GENERIC",
      undefined,
      ACTOR,
    );

  // Ordered by the first installment date, then creation, so a twin pair reads the same in every run.
  const roots = async () => {
    const rows = await setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { cashFlow: { orderBy: [{ id: "asc" }] } },
    });
    const first = (r: (typeof rows)[number]) =>
      Math.min(...r.cashFlow.map((c) => c.data.getTime()), Infinity);
    return rows.sort((a, b) => first(a) - first(b));
  };
  const cashAndSettlement = async () => ({
    receipts: await setup.receipt.count({ where: { tenantId: TENANT } }),
    settlements: await setup.crossProjectSettlement.count({
      where: { tenantId: TENANT },
    }),
    liquidations: await setup.importedInvoiceLiquidation.count({
      where: { tenantId: TENANT },
    }),
    bankImports: await setup.bankStatementImport.count({
      where: { tenantId: TENANT },
    }),
    bankAccounts: await setup.bankAccount.count({
      where: { tenantId: TENANT },
    }),
    paidEntries: await setup.cashFlowEntry.count({
      where: { tenantId: TENANT, status: "PAGO" },
    }),
  });
  const byLabel = (
    a: { parcela: string | null },
    b: { parcela: string | null },
  ) => parseInt(a.parcela ?? "0", 10) - parseInt(b.parcela ?? "0", 10);
  const shape = (rows: Awaited<ReturnType<typeof roots>>) =>
    rows
      .filter((r) => !r.deletedAt)
      .map((r) => ({
        valorTotal: r.valorTotal,
        quantidadeParcela: r.quantidadeParcela,
        entries: r.cashFlow
          .filter((c) => !c.deletedAt)
          .sort(byLabel)
          .map((c) => `${c.parcela}|${c.valor}|${c.status}`),
      }));
  const datesOf = (rows: Awaited<ReturnType<typeof roots>>) =>
    rows
      .filter((r) => !r.deletedAt)
      .map((r) =>
        r.cashFlow
          .filter((c) => !c.deletedAt)
          .sort(byLabel)
          .map((c) => c.data.toISOString().slice(0, 10)),
      );
  const lineOf = (res: CommitResult) => ({
    total: res.total,
    inserted: res.inserted,
    duplicated: res.duplicated,
    settled: res.settled,
    skipped: res.skipped,
    reviewRequired: res.reviewRequired.length,
    outcomes: res.lineResults.map((r) => r.outcome),
  });
  const entriesOf = (count: number, valor: number) =>
    LABELS.map((label) => `${label}|${valor}|PLANEJADO`).slice(0, count);
  // Only cash/payment/settlement are asserted untouched: the Expenses and PLANEJADO entries a purchase
  // creates ARE future debt. `bankAccounts: 0` proves nothing was CREATED, not that an existing bank
  // account with a real balance is preserved (no witness account is seeded here).
  const NO_CASH_OR_SETTLEMENT_EFFECT = {
    receipts: 0,
    settlements: 0,
    liquidations: 0,
    bankImports: 0,
    bankAccounts: 0,
    paidEntries: 0,
  };

  beforeAll(async () => {
    await prisma.$connect();
    await setup.$connect();
  });
  beforeEach(async () => {
    observedSeq = 0;
    jest.useFakeTimers({
      now: CLOCK,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: "0717",
      closingDay: 20,
      dueDay: 10,
    }));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.$disconnect();
    await setup.$disconnect();
  });

  // ── Controls: what the current engine already does for one purchase ──────

  it("[control] the real CSV parser gives the two identical lines two DIFFERENT externalIds; the first keeps the single-line id", () => {
    const twins = parsed(doc(TWIN, TWIN));
    record(
      "parser-twins",
      twins.map((t) => ({
        externalId: t.externalId,
        amountCents: t.amountCents,
        merchant: t.merchant,
        installment: `${t.installmentCurrent}/${t.installmentTotal}`,
        date: t.date.toISOString(),
      })),
    );
    expect(twins.map((t) => t.amountCents)).toEqual([6984, 6984]);
    expect(twins).toHaveLength(2);
    expect(twins[0]!.externalId).not.toBe(twins[1]!.externalId);
    expect(twins[0]!.externalId).toBe(parsed(doc(TWIN))[0]!.externalId);
  });

  it("[control] preview of the two identical lines lists 2 rows, both willImport, with the two distinct externalIds", async () => {
    const shown = await preview(doc(TWIN, TWIN));
    record("preview-twins", shown.preview);
    expect(shown.preview).toHaveLength(2);
    expect(shown.preview.map((r) => r.willImport)).toEqual([true, true]);
    expect(shown.preview.map((r) => r.externalId)).toEqual(
      parsed(doc(TWIN, TWIN)).map((t) => t.externalId),
    );
  });

  it("[control] ONE line creates ONE Expense of 69840 with 10 PLANEJADO entries of 6984 and no payment, receipt, settlement or bank write; the same file again has no effect", async () => {
    const first = await commit(doc(TWIN));
    const afterFirst = await roots();
    record("single-line", {
      result: lineOf(first),
      shape: shape(afterFirst),
      dates: datesOf(afterFirst),
      cashAndSettlement: await cashAndSettlement(),
    });
    expect(lineOf(first)).toEqual({
      total: 1,
      inserted: 1,
      duplicated: 0,
      settled: 0,
      skipped: 0,
      reviewRequired: 0,
      outcomes: ["CREATED"],
    });
    expect(shape(afterFirst)).toEqual([
      {
        valorTotal: 69840,
        quantidadeParcela: 10,
        entries: entriesOf(10, 6984),
      },
    ]);
    expect(datesOf(afterFirst)).toEqual([DATES_0905]);
    expect(await cashAndSettlement()).toEqual(NO_CASH_OR_SETTLEMENT_EFFECT);

    const replay = await commit(doc(TWIN));
    const afterReplay = await roots();
    record("single-line-replay", {
      result: lineOf(replay),
      unchanged: JSON.stringify(afterReplay) === JSON.stringify(afterFirst),
    });
    expect(lineOf(replay)).toEqual({
      total: 1,
      inserted: 0,
      duplicated: 1,
      settled: 0,
      skipped: 0,
      reviewRequired: 0,
      outcomes: ["DUPLICATED"],
    });
    expect(afterReplay).toEqual(afterFirst);
    expect(await cashAndSettlement()).toEqual(NO_CASH_OR_SETTLEMENT_EFFECT);
  });

  it("[control] ONE line dated 09-06 creates its own Expense of 69840 dated from 09-06 (the date shift TW1b relies on)", async () => {
    const res = await commit(doc(TWIN_NEXT_DAY));
    const rows = await roots();
    record("single-line-0906", {
      result: lineOf(res),
      shape: shape(rows),
      dates: datesOf(rows),
    });
    expect(lineOf(res).outcomes).toEqual(["CREATED"]);
    expect(shape(rows)).toEqual([
      {
        valorTotal: 69840,
        quantidadeParcela: 10,
        entries: entriesOf(10, 6984),
      },
    ]);
    expect(datesOf(rows)).toEqual([DATES_0906]);
  });

  it("[control] the REAL domain buildInstallments puts the cent remainder on the LAST installment: 204043/6 and 204042/6", () => {
    const build = (valorTotal: number) =>
      buildInstallments({
        valorTotal,
        formaPagamento: PaymentForm.PARCELADO,
        quantidadeParcela: 6,
        dataInicioParcela: new Date("2026-10-10T00:00:00.000Z"),
      }).map((i) => i.valor);
    expect(build(204043)).toEqual([34007, 34007, 34007, 34007, 34007, 34008]);
    expect(build(204042)).toEqual([34007, 34007, 34007, 34007, 34007, 34007]);
  });

  // ── TW1: two identical lines are two purchases ───────────────────────────

  const twoPurchases = (
    csv: string,
    firstDates: string[],
    secondDates: string[],
  ) => ({
    result: {
      total: 2,
      inserted: 2,
      duplicated: 0,
      settled: 0,
      skipped: 0,
      reviewRequired: 0,
      outcomes: ["CREATED", "CREATED"],
    },
    shape: [
      {
        valorTotal: 69840,
        quantidadeParcela: 10,
        entries: entriesOf(10, 6984),
      },
      {
        valorTotal: 69840,
        quantidadeParcela: 10,
        entries: entriesOf(10, 6984),
      },
    ],
    dates: [firstDates, secondDates],
    entrySum: 139680,
    externalIds: parsed(csv)
      .map((t) => t.externalId)
      .sort(),
    cashAndSettlement: NO_CASH_OR_SETTLEMENT_EFFECT,
  });
  const observe = async (name: string, res: CommitResult) => {
    const rows = await roots();
    const actual = {
      result: lineOf(res),
      shape: shape(rows),
      dates: datesOf(rows),
      entrySum: rows
        .filter((r) => !r.deletedAt)
        .flatMap((r) => r.cashFlow.filter((c) => !c.deletedAt))
        .reduce((sum, c) => sum + c.valor, 0),
      externalIds: rows
        .filter((r) => !r.deletedAt)
        .map((r) => r.externalId)
        .sort(),
      cashAndSettlement: await cashAndSettlement(),
    };
    record(name, {
      ...actual,
      lineResults: res.lineResults,
      externalIds: rows.map((r) => r.externalId),
    });
    return actual;
  };

  it("[RED] TW1 the same file with two identical lines commits TWO purchases: 2 Expenses of 69840 and 20 entries of 6984 (sum 139680), each root labelled 1/10..10/10", async () => {
    const csv = doc(TWIN, TWIN);
    const res = await commit(csv);
    expect(await observe("tw1", res)).toEqual(
      twoPurchases(csv, DATES_0905, DATES_0905),
    );
  });

  it("[RED] TW1b two intended purchases of the same store, N and amount on DIFFERENT dates (09-05 and 09-06) commit TWO purchases", async () => {
    const csv = doc(TWIN, TWIN_NEXT_DAY);
    const res = await commit(csv);
    expect(await observe("tw1b", res)).toEqual(
      twoPurchases(csv, DATES_0905, DATES_0906),
    );
  });

  // ── TW2: retry ───────────────────────────────────────────────────────────

  it("[RED] TW2a sending the SAME complete file again recreates nothing: ids, entries and the cash/settlement side stay identical and both lines answer DUPLICATED", async () => {
    const first = await commit(doc(TWIN, TWIN));
    const before = await roots();
    const cashAndSettlementBefore = await cashAndSettlement();
    const again = await commit(doc(TWIN, TWIN));
    const after = await roots();
    const actual = {
      firstInserted: first.inserted,
      replay: lineOf(again),
      unchanged: JSON.stringify(after) === JSON.stringify(before),
      ids: after.map((r) => r.id),
      idsBefore: before.map((r) => r.id),
      cashAndSettlementUnchanged:
        JSON.stringify(await cashAndSettlement()) ===
        JSON.stringify(cashAndSettlementBefore),
      expenses: after.filter((r) => !r.deletedAt).length,
    };
    record("tw2a", { ...actual, lineResults: again.lineResults });
    expect({
      firstInserted: actual.firstInserted,
      replay: actual.replay,
      unchanged: actual.unchanged,
      cashAndSettlementUnchanged: actual.cashAndSettlementUnchanged,
      expenses: actual.expenses,
    }).toEqual({
      firstInserted: 2,
      replay: {
        total: 2,
        inserted: 0,
        duplicated: 2,
        settled: 0,
        skipped: 0,
        reviewRequired: 0,
        outcomes: ["DUPLICATED", "DUPLICATED"],
      },
      unchanged: true,
      cashAndSettlementUnchanged: true,
      expenses: 2,
    });
  });

  it.each([
    {
      ordinal: 0,
      partial: ["CREATED", "NOT_SELECTED"],
      whole: ["DUPLICATED", "CREATED"],
    },
    {
      ordinal: 1,
      partial: ["NOT_SELECTED", "CREATED"],
      whole: ["CREATED", "DUPLICATED"],
    },
  ])(
    "[RED] TW2b importing ONLY the twin at ordinal $ordinal, then the SAME whole file, ends with 2 purchases and 20 entries; the selected root and a further replay are untouched",
    async ({ ordinal, partial: partialOutcomes, whole: wholeOutcomes }) => {
      const csv = doc(TWIN, TWIN);
      const twins = parsed(csv);
      const selectedId = twins[ordinal]!.externalId;
      const bothIds = twins.map((t) => t.externalId).sort();
      const partial = await commit(csv, [selectedId]);
      const afterPartial = await roots();
      const selectedRoot = afterPartial.find(
        (r) => r.externalId === selectedId,
      );
      const whole = await commit(csv);
      const afterWhole = await roots();
      const replay = await commit(csv);
      const afterReplay = await roots();
      const live = (rows: typeof afterWhole) =>
        rows.filter((r) => !r.deletedAt);
      const actual = {
        partial: { ...lineOf(partial), notSelected: partial.notSelected },
        partialExternalIds: live(afterPartial).map((r) => r.externalId),
        whole: lineOf(whole),
        finalExternalIds: live(afterWhole)
          .map((r) => r.externalId)
          .sort(),
        shape: shape(afterWhole),
        selectedRootUntouched:
          JSON.stringify(afterWhole.find((r) => r.id === selectedRoot?.id)) ===
          JSON.stringify(selectedRoot),
        replay: lineOf(replay),
        replayUnchanged:
          JSON.stringify(afterReplay) === JSON.stringify(afterWhole),
        cashAndSettlement: await cashAndSettlement(),
      };
      record(`tw2b-ordinal-${ordinal}`, {
        ...actual,
        selectedId,
        partialLineResults: partial.lineResults,
        wholeLineResults: whole.lineResults,
        replayLineResults: replay.lineResults,
        rootIds: afterReplay.map((r) => r.id),
      });
      expect(actual).toEqual({
        partial: {
          total: 2,
          inserted: 1,
          duplicated: 0,
          settled: 0,
          skipped: 0,
          reviewRequired: 0,
          outcomes: partialOutcomes,
          notSelected: 1,
        },
        partialExternalIds: [selectedId],
        whole: {
          total: 2,
          inserted: 1,
          duplicated: 1,
          settled: 0,
          skipped: 0,
          reviewRequired: 0,
          outcomes: wholeOutcomes,
        },
        finalExternalIds: bothIds,
        shape: [
          {
            valorTotal: 69840,
            quantidadeParcela: 10,
            entries: entriesOf(10, 6984),
          },
          {
            valorTotal: 69840,
            quantidadeParcela: 10,
            entries: entriesOf(10, 6984),
          },
        ],
        selectedRootUntouched: true,
        replay: {
          total: 2,
          inserted: 0,
          duplicated: 2,
          settled: 0,
          skipped: 0,
          reviewRequired: 0,
          outcomes: ["DUPLICATED", "DUPLICATED"],
        },
        replayUnchanged: true,
        cashAndSettlement: NO_CASH_OR_SETTLEMENT_EFFECT,
      });
    },
  );
});
