require("../../../../scripts/test-db-env.cjs");

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { buildSeriesKey, classifyCardImport } from "./card-purchase-identity";
import { CreditCardService } from "./credit-card.service";
import { parseStatement } from "./parsers";

/**
 * P04 ambiguity + fingerprint (RED, test-only). Design: p04-tw-fix-design.md +
 * p04-tw-fix-addendum.v1.1.md. Real CSV parser, real PrismaService, real
 * CreditCardService and the real classifier; raw Prisma only seeds and reads.
 *
 * k >= 2 LIVE roots of the SAME series that are not siblings of the document line
 * (a sibling = a root whose persisted externalId belongs to ANOTHER line of the same
 * document at the SAME current) are ambiguous: preview and commit answer
 * REVIEW_REQUIRED with exactly those roots as candidates, write nothing, and never
 * reuse one of them arbitrarily. The fingerprint is computed on the same roots at
 * every point (preview, commit without and with a decision).
 *
 * Every scenario records what it OBSERVED (P04_EVIDENCE_DIR, mode 0600) BEFORE it
 * asserts. Seeds of k >= 2 live roots are synthetic and isolated: root 1 is a real
 * commit, the others are exact clones of it (own externalId / strong key / cash flow).
 */
const TENANT = "qa-p04-ambiguity";
const PROJECT = `${TENANT}-pessoal`;
const ACTOR = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const CLOCK = new Date("2026-09-28T12:00:00.000Z");
const FIRST = "2026-09-05,QA GEMEA LOJA 1/10,69.84";
const SECOND = "2026-10-05,QA GEMEA LOJA 2/10,69.84";
const HEX64 = /^[0-9a-f]{64}$/;
const EVIDENCE_DIR = process.env.P04_EVIDENCE_DIR;
// A purchase that STARTS at installment 2 keeps only the remaining 9 installments:
// valorTotal = 6984 x 9, labels 2/10..10/10 (native behaviour, not a new rule).
const REMAINING_LABELS_FROM_2 = Array.from(
  { length: 9 },
  (_, i) => `${i + 2}/10|6984|PLANEJADO`,
);
const ALL_LABELS = Array.from(
  { length: 10 },
  (_, i) => `${i + 1}/10|6984|PLANEJADO`,
);

type CommitResult = Awaited<ReturnType<CreditCardService["commitImport"]>>;
type PreviewResult = Awaited<ReturnType<CreditCardService["previewImport"]>>;
type Purchase = Parameters<typeof classifyCardImport>[2];
// The designed 4th parameter of the classifier (design v1.1 §1). Until GREEN adds it the
// call still compiles through this alias and the extra argument is simply ignored.
type ClassifyWithSiblings = (
  tx: Parameters<typeof classifyCardImport>[0],
  tenantId: string,
  purchase: Purchase,
  isSibling?: (externalId: string) => boolean,
) => ReturnType<typeof classifyCardImport>;
// The optional 4th parameter keeps the real 3-argument signature assignable.
const classifyWithSiblings: ClassifyWithSiblings = classifyCardImport;

describe("P04 k>=2 ambiguity and fingerprint (RED)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const cards = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  let cardId: string;
  let seq = 0;

  const record = (name: string, data: unknown) => {
    if (!EVIDENCE_DIR) return;
    mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
    seq += 1;
    writeFileSync(
      join(EVIDENCE_DIR, `${String(seq).padStart(3, "0")}-${name}.json`),
      JSON.stringify(data, null, 2),
      { mode: 0o600 },
    );
  };

  const doc = (...rows: string[]) => `date,title,amount\n${rows.join("\n")}\n`;
  const parsed = (csv: string) =>
    parseStatement(csv, cardId, "CSV_GENERIC", "s.csv").transactions;
  const commit = (
    csv: string,
    decisions?: unknown,
    selected?: string[],
  ): Promise<CommitResult> =>
    cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      "s.csv",
      "CSV_GENERIC",
      undefined,
      undefined,
      decisions,
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
  const importDecisions = (
    items: Array<{ externalId: string; fingerprint: string | null }>,
  ) =>
    items.map((i) => ({
      externalId: i.externalId,
      action: "import",
      reviewFingerprint: i.fingerprint,
    }));

  /** Everything persisted, every column, tombstones included. */
  const everything = () =>
    setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    });
  const liveIds = async () =>
    (await everything()).filter((r) => !r.deletedAt).map((r) => r.id);
  const cashSide = async () => ({
    receipts: await setup.receipt.count({ where: { tenantId: TENANT } }),
    settlements: await setup.crossProjectSettlement.count({
      where: { tenantId: TENANT },
    }),
    liquidations: await setup.importedInvoiceLiquidation.count({
      where: { tenantId: TENANT },
    }),
  });
  const NO_CASH_SIDE = { receipts: 0, settlements: 0, liquidations: 0 };
  const outcomes = (res: CommitResult) => res.lineResults.map((l) => l.outcome);
  const countsOf = (res: CommitResult) => ({
    total: res.total,
    inserted: res.inserted,
    duplicated: res.duplicated,
    settled: res.settled,
    skipped: res.skipped,
  });
  const labelsOf = (row: Awaited<ReturnType<typeof everything>>[number]) =>
    row.cashFlow
      .filter((c) => !c.deletedAt)
      .sort(
        (a, b) =>
          parseInt(a.parcela ?? "0", 10) - parseInt(b.parcela ?? "0", 10),
      )
      .map((c) => `${c.parcela}|${c.valor}|${c.status}`);

  /**
   * k live roots of QA GEMEA LOJA 1/10: root 1 is a REAL commit, the others exact clones
   * with their own externalId, strong key and cash flow (isolated synthetic seed).
   */
  const seedRoots = async (k: number, prefix = "seed") => {
    await commit(doc(FIRST));
    const base = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT },
      include: { cashFlow: true },
    });
    for (let i = 1; i < k; i += 1) {
      const { id: _id, createdAt: _c, updatedAt: _u, cashFlow, ...row } = base;
      const clone = await setup.expense.create({
        data: {
          ...row,
          externalId: `${prefix}-x${i + 1}`,
          dedupeKeyStrong: `${prefix}-strong-${i + 1}`,
        },
      });
      for (const entry of cashFlow) {
        const {
          id: _eid,
          createdAt: _ec,
          updatedAt: _eu,
          expenseId: _x,
          ...rest
        } = entry;
        await setup.cashFlowEntry.create({
          data: { ...rest, expenseId: clone.id },
        });
      }
    }
    return liveIds();
  };
  // The confirmation needs the fingerprints the PREVIEW must already carry; asserting them
  // first keeps the RED behavioural (no fingerprint yet) instead of a 400 on a null.
  const previewFingerprints = (shown: PreviewResult, name: string) => {
    const fingerprints = shown.preview.map(
      (r) => r.review?.fingerprint ?? null,
    );
    record(`${name}-preview`, {
      rows: shown.preview.map((r) => ({
        externalId: r.externalId,
        willImport: r.willImport,
        review: r.review,
      })),
    });
    expect(fingerprints.map((f) => HEX64.test(f ?? ""))).toEqual([true, true]);
    return fingerprints.map((f) => {
      if (f === null) throw new Error("preview carries no review fingerprint");
      return f;
    });
  };
  const TWO_LINES = () => doc(SECOND, SECOND);
  const candidateIds = (item: { candidates: Array<{ expenseId: string }> }) =>
    item.candidates.map((c) => c.expenseId).sort();

  beforeAll(async () => {
    await prisma.$connect();
    await setup.$connect();
  });
  beforeEach(async () => {
    seq = 0;
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

  // ── Controls: seeds and legacy behaviour that must survive the fix ───────

  it("[control] the seed is k=2 live nominal roots of ONE series: root 1 is the real commit (10 entries of 6984), root 2 an exact clone with its own ids", async () => {
    const ids = await seedRoots(2);
    const rows = (await everything()).filter((r) => !r.deletedAt);
    record("seed-k2", {
      ids,
      roots: rows.map((r) => ({
        externalId: r.externalId,
        seriesKey: r.seriesKey,
        valorTotal: r.valorTotal,
        labels: labelsOf(r),
      })),
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.seriesKey)).toEqual([
      buildSeriesKey(cardId, "QA GEMEA LOJA", 6984, 10),
      buildSeriesKey(cardId, "QA GEMEA LOJA", 6984, 10),
    ]);
    expect(rows.map((r) => r.valorTotal)).toEqual([69840, 69840]);
    expect(rows.map(labelsOf)).toEqual([ALL_LABELS, ALL_LABELS]);
    expect(rows.map((r) => r.externalId).sort()).toEqual(
      [parsed(doc(FIRST, FIRST))[0]!.externalId, "seed-x2"].sort(),
    );
  });

  it("[control] 1/10 and 2/10 of the same series in ONE file are two different occurrences: ONE root, the 2nd line is REUSED (no claim without `current`)", async () => {
    const res = await commit(doc(FIRST, SECOND));
    const rows = (await everything()).filter((r) => !r.deletedAt);
    record("occurrences", {
      counts: countsOf(res),
      outcomes: outcomes(res),
      roots: rows.length,
      cash: await cashSide(),
    });
    expect(outcomes(res)).toEqual(["CREATED", "REUSED"]);
    expect(countsOf(res)).toEqual({
      total: 2,
      inserted: 1,
      duplicated: 0,
      settled: 1,
      skipped: 0,
    });
    expect(rows).toHaveLength(1);
    expect(await cashSide()).toEqual(NO_CASH_SIDE);
  });

  it("[control] a legacy root WITHOUT externalId is still reused and stamped with the line's externalId (k=1, S6 stays)", async () => {
    await commit(doc(FIRST));
    const root = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT },
    });
    await setup.expense.update({
      where: { id: root.id },
      data: { externalId: null, dedupeKeyStrong: null, dedupeKeyNatural: null },
    });
    const res = await commit(doc(SECOND));
    const after = await setup.expense.findMany({ where: { tenantId: TENANT } });
    record("legacy-null-external-id", {
      counts: countsOf(res),
      outcomes: outcomes(res),
      externalIds: after.map((r) => r.externalId),
      lineExternalId: parsed(doc(SECOND))[0]!.externalId,
    });
    expect(outcomes(res)).toEqual(["REUSED"]);
    expect(after).toHaveLength(1);
    expect(after[0]!.externalId).toBe(parsed(doc(SECOND))[0]!.externalId);
  });

  it("[control] native creation of ONE '2/10' line: one root of 62856 with the 9 remaining entries 2/10..10/10 of 6984 PLANEJADO (the numbers the RED confirmations expect)", async () => {
    const res = await commit(doc(SECOND));
    const rows = (await everything()).filter((r) => !r.deletedAt);
    record("native-2-of-10", {
      outcomes: outcomes(res),
      rows: rows.map((r) => ({
        valorTotal: r.valorTotal,
        labels: labelsOf(r),
      })),
    });
    expect(outcomes(res)).toEqual(["CREATED"]);
    expect(
      rows.map((r) => ({ valorTotal: r.valorTotal, labels: labelsOf(r) })),
    ).toEqual([{ valorTotal: 62856, labels: REMAINING_LABELS_FROM_2 }]);
  });

  // The classifier is called for real; only its inputs are surgical (Prisma is real).
  const purchaseOf = (
    externalId: string,
    dedupeKeyStrong: string | null,
  ): Purchase => ({
    cardId,
    projectId: PROJECT,
    merchant: "QA GEMEA LOJA",
    total: 10,
    seriesKey: buildSeriesKey(cardId, "QA GEMEA LOJA", 6984, 10),
    externalId,
    dedupeKeyStrong,
  });
  const admissionKinds = (a: Awaited<ReturnType<typeof classifyCardImport>>) =>
    a.kind === "BLOCKED" ? `BLOCKED/sameSeries=${a.sameSeries}` : a.kind;

  it("[control] fail-closed helper: a root whose strong key or externalId IS the line's stays blocking even if the sibling callback claims it", async () => {
    await seedRoots(2);
    const [r1] = await setup.expense.findMany({
      where: { tenantId: TENANT, externalId: { not: null } },
      orderBy: { id: "asc" },
    });
    await setup.expense.update({
      where: { id: r1!.id },
      data: { dedupeKeyStrong: "p04-line-strong" },
    });
    const claimAll = () => true;
    const sameStrong = await classifyWithSiblings(
      prisma,
      TENANT,
      purchaseOf("some-other-line", "p04-line-strong"),
      claimAll,
    );
    const sameExternal = await classifyWithSiblings(
      prisma,
      TENANT,
      purchaseOf(r1!.externalId!, null),
      claimAll,
    );
    record("helper-fail-closed", {
      sameStrong: admissionKinds(sameStrong),
      sameExternal: admissionKinds(sameExternal),
    });
    expect(admissionKinds(sameStrong)).toBe("BLOCKED/sameSeries=false");
    expect(admissionKinds(sameExternal)).toBe("BLOCKED/sameSeries=false");
  });

  it("[control] barrier: even when the sibling callback claims EVERY externalId, a soft-deleted root that still carries live cash flow stays a blocker (BLOCKED, sameSeries=false)", async () => {
    await seedRoots(2);
    const rows = await everything();
    await setup.expense.update({
      where: { id: rows[1]!.id },
      data: { deletedAt: new Date("2026-09-20T00:00:00.000Z") },
    });
    const admission = await classifyWithSiblings(
      prisma,
      TENANT,
      purchaseOf("line-not-in-any-root", "line-strong"),
      () => true,
    );
    record("barrier-tombstone", { admission: admissionKinds(admission) });
    expect(admissionKinds(admission)).toBe("BLOCKED/sameSeries=false");
  });

  // ── RED: k>=2 non-sibling live roots are AMBIGUOUS ───────────────────────

  it("[RED] A1 preview: two live same-series roots and two '2/10' lines => both rows REVIEW_REQUIRED with exactly those roots, willImport=false", async () => {
    const roots = await seedRoots(2);
    const shown = await preview(TWO_LINES());
    record("a1-preview", {
      roots,
      rows: shown.preview.map((r) => ({
        externalId: r.externalId,
        willImport: r.willImport,
        review: r.review,
      })),
    });
    expect(
      shown.preview.map((r) => ({
        willImport: r.willImport,
        reason: r.review?.reason ?? null,
        candidates: r.review ? candidateIds(r.review) : null,
        fingerprint: HEX64.test(r.review?.fingerprint ?? ""),
      })),
    ).toEqual([
      {
        willImport: false,
        reason: "REVIEW_REQUIRED",
        candidates: [...roots].sort(),
        fingerprint: true,
      },
      {
        willImport: false,
        reason: "REVIEW_REQUIRED",
        candidates: [...roots].sort(),
        fingerprint: true,
      },
    ]);
    expect(shown.preview[0]!.review!.fingerprint).not.toBe(
      shown.preview[1]!.review!.fingerprint,
    );
  });

  it("[RED] A1 commit: no decisions => REVIEW_REQUIRED x2 with the SAME candidates and fingerprints the preview showed, inserted 0, settled 0, every Expense and cash-flow column untouched", async () => {
    const roots = await seedRoots(2);
    const shown = await preview(TWO_LINES());
    const before = await everything();
    const res = await commit(TWO_LINES());
    const after = await everything();
    record("a1-commit", {
      roots,
      counts: countsOf(res),
      outcomes: outcomes(res),
      reviewRequired: res.reviewRequired,
      previewFingerprints: shown.preview.map(
        (r) => r.review?.fingerprint ?? null,
      ),
      unchanged: JSON.stringify(after) === JSON.stringify(before),
      cash: await cashSide(),
    });
    expect(outcomes(res)).toEqual(["REVIEW_REQUIRED", "REVIEW_REQUIRED"]);
    expect(countsOf(res)).toMatchObject({ inserted: 0, settled: 0 });
    expect(res.reviewRequired.map((r) => candidateIds(r))).toEqual([
      [...roots].sort(),
      [...roots].sort(),
    ]);
    expect(res.reviewRequired.map((r) => r.fingerprint)).toEqual(
      shown.preview.map((r) => r.review?.fingerprint ?? null),
    );
    expect(after).toEqual(before);
    expect(await cashSide()).toEqual(NO_CASH_SIDE);
  });

  it("[RED] A3 confirming both lines with the preview fingerprints creates TWO independent purchases with no false STALE; the replay is DUPLICATED x2", async () => {
    const roots = await seedRoots(2);
    const shown = await preview(TWO_LINES());
    const fingerprints = previewFingerprints(shown, "a3");
    const items = shown.preview.map((r, i) => ({
      externalId: r.externalId,
      fingerprint: fingerprints[i]!,
    }));
    const before = await everything();
    const decisions = importDecisions(items);
    const res = await commit(TWO_LINES(), decisions);
    const after = await everything();
    const created = after.filter((r) => !roots.includes(r.id));
    const replay = await commit(TWO_LINES(), decisions);
    const afterReplay = await everything();
    const allEntries = after.flatMap((r) => r.cashFlow);
    record("a3-confirm", {
      roots,
      counts: countsOf(res),
      outcomes: outcomes(res),
      reviewRequired: res.reviewRequired,
      rows: after.length,
      created: created.map((r) => ({
        valorTotal: r.valorTotal,
        labels: labelsOf(r),
      })),
      entries: allEntries.length,
      sum: allEntries.reduce((s, c) => s + c.valor, 0),
      replayOutcomes: outcomes(replay),
      replayUnchanged: JSON.stringify(afterReplay) === JSON.stringify(after),
      cash: await cashSide(),
    });
    expect({
      outcomes: outcomes(res),
      counts: countsOf(res),
      rows: after.length,
      created: created.map((r) => ({
        valorTotal: r.valorTotal,
        labels: labelsOf(r),
      })),
      oldRootsUntouched:
        JSON.stringify(after.filter((r) => roots.includes(r.id))) ===
        JSON.stringify(before),
      entries: allEntries.length,
      sum: allEntries.reduce((s, c) => s + c.valor, 0),
      cash: await cashSide(),
    }).toEqual({
      outcomes: ["CREATED", "CREATED"],
      counts: { total: 2, inserted: 2, duplicated: 0, settled: 0, skipped: 0 },
      rows: 4,
      created: [
        { valorTotal: 62856, labels: REMAINING_LABELS_FROM_2 },
        { valorTotal: 62856, labels: REMAINING_LABELS_FROM_2 },
      ],
      oldRootsUntouched: true,
      entries: 38,
      sum: 265392,
      cash: NO_CASH_SIDE,
    });
    expect({
      outcomes: outcomes(replay),
      counts: countsOf(replay),
      unchanged: JSON.stringify(afterReplay) === JSON.stringify(after),
    }).toEqual({
      outcomes: ["DUPLICATED", "DUPLICATED"],
      counts: { total: 2, inserted: 0, duplicated: 2, settled: 0, skipped: 0 },
      unchanged: true,
    });
  });

  it("[RED] A2 after ONE line was confirmed, the whole file again: that line is DUPLICATED (strong, no review) and the other stays REVIEW_REQUIRED on the ORIGINAL two roots with the ORIGINAL fingerprint", async () => {
    const roots = await seedRoots(2);
    const shown = await preview(TWO_LINES());
    const [first, second] = shown.preview;
    previewFingerprints(shown, "a2");
    const partial = await commit(
      TWO_LINES(),
      importDecisions([
        {
          externalId: first!.externalId,
          fingerprint: first!.review?.fingerprint ?? null,
        },
      ]),
    );
    const previewAfter = await preview(TWO_LINES());
    const resend = await commit(TWO_LINES());
    const after = await everything();
    record("a2-preview-after-partial", {
      rows: previewAfter.preview.map((r) => ({
        externalId: r.externalId,
        duplicate: r.duplicate,
        willImport: r.willImport,
        review: r.review,
      })),
    });
    record("a2-resend", {
      roots,
      partialOutcomes: outcomes(partial),
      partialReview: partial.reviewRequired,
      resendOutcomes: outcomes(resend),
      resendReview: resend.reviewRequired,
      originalFingerprint: second!.review?.fingerprint ?? null,
      rows: after.length,
    });
    expect(outcomes(partial)).toEqual(["CREATED", "REVIEW_REQUIRED"]);
    expect(partial.reviewRequired.map((r) => r.fingerprint)).toEqual([
      second!.review?.fingerprint ?? null,
    ]);
    expect(
      previewAfter.preview.map((r) => ({
        duplicate: r.duplicate,
        willImport: r.willImport,
        review: r.review
          ? {
              reason: r.review.reason,
              candidates: candidateIds(r.review),
              fingerprint: r.review.fingerprint,
            }
          : null,
      })),
    ).toEqual([
      { duplicate: true, willImport: false, review: null },
      {
        duplicate: false,
        willImport: false,
        review: {
          reason: "REVIEW_REQUIRED",
          candidates: [...roots].sort(),
          fingerprint: second!.review?.fingerprint ?? null,
        },
      },
    ]);
    expect(outcomes(resend)).toEqual(["DUPLICATED", "REVIEW_REQUIRED"]);
    expect(resend.reviewRequired.map((r) => candidateIds(r))).toEqual([
      [...roots].sort(),
    ]);
    expect(resend.reviewRequired.map((r) => r.fingerprint)).toEqual([
      second!.review?.fingerprint ?? null,
    ]);
    expect(after).toHaveLength(3);
  });

  it("[RED] A4 drift: a NEW live nominal non-sibling root of the same series after the preview => both decisions STALE and nothing is written", async () => {
    await seedRoots(2);
    const shown = await preview(TWO_LINES());
    const fingerprints = previewFingerprints(shown, "a4");
    const items = shown.preview.map((r, i) => ({
      externalId: r.externalId,
      fingerprint: fingerprints[i]!,
    }));
    const base = (await everything())[0]!;
    const { id: _id, createdAt: _c, updatedAt: _u, cashFlow, ...row } = base;
    const drift = await setup.expense.create({
      data: { ...row, externalId: "seed-x9", dedupeKeyStrong: "seed-strong-9" },
    });
    for (const entry of cashFlow) {
      const {
        id: _e,
        createdAt: _ec,
        updatedAt: _eu,
        expenseId: _x,
        ...rest
      } = entry;
      await setup.cashFlowEntry.create({
        data: { ...rest, expenseId: drift.id },
      });
    }
    const before = await everything();
    const res = await commit(TWO_LINES(), importDecisions(items));
    const after = await everything();
    record("a4-drift", {
      itemsHadFingerprint: items.map((i) => i.fingerprint !== null),
      outcomes: outcomes(res),
      review: res.reviewRequired.map((r) => ({
        reason: r.reason,
        fp: r.fingerprint,
      })),
      unchanged: JSON.stringify(after) === JSON.stringify(before),
    });
    expect(items.map((i) => HEX64.test(i.fingerprint ?? ""))).toEqual([
      true,
      true,
    ]);
    expect(outcomes(res)).toEqual(["REVIEW_REQUIRED", "REVIEW_REQUIRED"]);
    expect(res.reviewRequired.map((r) => r.reason)).toEqual([
      "REVIEW_STALE",
      "REVIEW_STALE",
    ]);
    expect(countsOf(res)).toMatchObject({ inserted: 0, settled: 0 });
    expect(after).toEqual(before);
  });

  // ── RED: an already-persisted sibling with a PAGO entry is preserved ─────

  it("[RED] TW2d root 1 has a PAGO entry and a strong externalId; the same file with a sibling line creates the 2nd root and leaves the PAGO row byte-identical", async () => {
    await commit(doc(FIRST));
    const root = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT },
      include: { cashFlow: true },
    });
    const paid = root.cashFlow.find((c) => c.parcela === "1/10")!;
    await setup.cashFlowEntry.update({
      where: { id: paid.id },
      data: { status: "PAGO" },
    });
    const before = await everything();
    const paidBefore = before[0]!.cashFlow.find((c) => c.id === paid.id);
    const res = await commit(doc(FIRST, FIRST));
    const after = await everything();
    const paidAfter = after
      .find((r) => r.id === root.id)!
      .cashFlow.find((c) => c.id === paid.id);
    record("tw2d-paid", {
      outcomes: outcomes(res),
      counts: countsOf(res),
      rows: after.length,
      paidBefore,
      paidAfter,
      cash: await cashSide(),
    });
    expect({
      outcomes: outcomes(res),
      rows: after.length,
      paidPreserved: JSON.stringify(paidAfter) === JSON.stringify(paidBefore),
      paidStatus: paidAfter?.status,
      cash: await cashSide(),
    }).toEqual({
      outcomes: ["DUPLICATED", "CREATED"],
      rows: 2,
      paidPreserved: true,
      paidStatus: "PAGO",
      cash: NO_CASH_SIDE,
    });
  });

  // ── PAGO is data, not a ban (mediation A5): a PAGO nominal root keeps its standing ──

  const markPaid = async (expenseId: string) => {
    const entry = await setup.cashFlowEntry.findFirstOrThrow({
      where: { expenseId, parcela: "1/10" },
    });
    await setup.cashFlowEntry.update({
      where: { id: entry.id },
      data: { status: "PAGO" },
    });
    return entry.id;
  };
  const admissionOf = (a: Awaited<ReturnType<typeof classifyCardImport>>) =>
    a.kind === "REVIEW"
      ? { kind: a.kind, roots: a.roots.map((r) => r.id).sort() }
      : a.kind === "BLOCKED"
        ? { kind: a.kind, sameSeries: a.sameSeries }
        : { kind: a.kind };
  const lineOfSecond = () => parsed(TWO_LINES())[0]!.externalId;

  it("[RED] A10 classifier, NO callback: two live nominal roots of the line's series => REVIEW on exactly those roots (today BLOCKED sameSeries)", async () => {
    const roots = await seedRoots(2);
    const admission = await classifyWithSiblings(
      prisma,
      TENANT,
      purchaseOf(lineOfSecond(), null),
    );
    record("a10-no-callback-k2", { roots, admission: admissionOf(admission) });
    expect(admissionOf(admission)).toEqual({
      kind: "REVIEW",
      roots: [...roots].sort(),
    });
  });

  it("[RED] A10 classifier WITH a callback that excludes nothing relevant: same REVIEW on the two roots", async () => {
    const roots = await seedRoots(2);
    const admission = await classifyWithSiblings(
      prisma,
      TENANT,
      purchaseOf(lineOfSecond(), null),
      () => false,
    );
    record("a10-callback-k2", { roots, admission: admissionOf(admission) });
    expect(admissionOf(admission)).toEqual({
      kind: "REVIEW",
      roots: [...roots].sort(),
    });
  });

  it("[RED] A10 PAGO nominal: k=2 where root 1 has a PAGO entry is still REVIEW on BOTH roots, with and without the callback", async () => {
    const roots = await seedRoots(2);
    const rows = await everything();
    const paidEntryId = await markPaid(rows[0]!.id);
    const without = await classifyWithSiblings(
      prisma,
      TENANT,
      purchaseOf(lineOfSecond(), null),
    );
    const withCallback = await classifyWithSiblings(
      prisma,
      TENANT,
      purchaseOf(lineOfSecond(), null),
      () => false,
    );
    record("a10-paid-k2", {
      roots,
      paidEntryId,
      without: admissionOf(without),
      withCallback: admissionOf(withCallback),
    });
    const expected = { kind: "REVIEW", roots: [...roots].sort() };
    expect([admissionOf(without), admissionOf(withCallback)]).toEqual([
      expected,
      expected,
    ]);
  });

  it("[control] PAGO nominal, k=1: the classifier keeps the legacy BLOCKED sameSeries (reuse decides, S6 unchanged); PAGO alone is not a ban", async () => {
    await seedRoots(1);
    const [root] = await everything();
    await markPaid(root!.id);
    const admission = await classifyWithSiblings(
      prisma,
      TENANT,
      purchaseOf(lineOfSecond(), null),
    );
    const res = await commit(doc(SECOND));
    const after = await everything();
    const paid = after[0]!.cashFlow.find((c) => c.parcela === "1/10");
    record("paid-k1", {
      admission: admissionOf(admission),
      outcomes: outcomes(res),
      rows: after.length,
      paidStatus: paid?.status,
    });
    expect(admissionOf(admission)).toEqual({
      kind: "BLOCKED",
      sameSeries: true,
    });
    expect(outcomes(res)).toEqual(["REUSED"]);
    expect(after).toHaveLength(1);
    expect(paid?.status).toBe("PAGO");
  });

  it("[RED] PAGO in the fingerprint: a PAGO nominal among k=2 roots is previewed as review; confirming both keeps the PAGO row byte-identical and the replay is DUPLICATED x2", async () => {
    const roots = await seedRoots(2);
    const paidEntryId = await markPaid((await everything())[0]!.id);
    const shown = await preview(TWO_LINES());
    const fingerprints = previewFingerprints(shown, "paid-confirm");
    const before = await everything();
    const paidBefore = before
      .flatMap((r) => r.cashFlow)
      .find((c) => c.id === paidEntryId);
    const decisions = importDecisions(
      shown.preview.map((r, i) => ({
        externalId: r.externalId,
        fingerprint: fingerprints[i]!,
      })),
    );
    const res = await commit(TWO_LINES(), decisions);
    const after = await everything();
    const paidAfter = after
      .flatMap((r) => r.cashFlow)
      .find((c) => c.id === paidEntryId);
    const replay = await commit(TWO_LINES(), decisions);
    record("paid-confirm", {
      roots,
      outcomes: outcomes(res),
      rows: after.length,
      paidBefore,
      paidAfter,
      replay: outcomes(replay),
      cash: await cashSide(),
    });
    expect({
      outcomes: outcomes(res),
      rows: after.length,
      paidStatus: paidAfter?.status,
      paidUnchanged: JSON.stringify(paidAfter) === JSON.stringify(paidBefore),
      replay: outcomes(replay),
      cash: await cashSide(),
    }).toEqual({
      outcomes: ["CREATED", "CREATED"],
      rows: 4,
      paidStatus: "PAGO",
      paidUnchanged: true,
      replay: ["DUPLICATED", "DUPLICATED"],
      cash: NO_CASH_SIDE,
    });
  });

  it("[RED] PAGO drift: the PAGO entry changes AFTER the preview => the fingerprint (it includes status) no longer matches: REVIEW_STALE x2, nothing written", async () => {
    await seedRoots(2);
    const paidEntryId = await markPaid((await everything())[0]!.id);
    const shown = await preview(TWO_LINES());
    const fingerprints = previewFingerprints(shown, "paid-drift");
    await setup.cashFlowEntry.update({
      where: { id: paidEntryId },
      data: { status: "PLANEJADO" },
    });
    const before = await everything();
    const res = await commit(
      TWO_LINES(),
      importDecisions(
        shown.preview.map((r, i) => ({
          externalId: r.externalId,
          fingerprint: fingerprints[i]!,
        })),
      ),
    );
    const after = await everything();
    record("paid-drift", {
      outcomes: outcomes(res),
      reasons: res.reviewRequired.map((r) => r.reason),
      unchanged: JSON.stringify(after) === JSON.stringify(before),
    });
    expect(outcomes(res)).toEqual(["REVIEW_REQUIRED", "REVIEW_REQUIRED"]);
    expect(res.reviewRequired.map((r) => r.reason)).toEqual([
      "REVIEW_STALE",
      "REVIEW_STALE",
    ]);
    expect(countsOf(res)).toMatchObject({ inserted: 0, settled: 0 });
    expect(after).toEqual(before);
  });
});
