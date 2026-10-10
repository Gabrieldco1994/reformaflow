require("../../../../scripts/test-db-env.cjs");

import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import {
  bankOfx,
  ofxDebit,
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
  seedProject,
  seedSinglePurchase,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { CreditCardController } from "./credit-card.controller";
import { attachDedupeKeys } from "../import-dedupe/cross-origin-dedupe";
import { CreditCardService } from "./credit-card.service";
import { parseStatementBuffers } from "./parsers";

/**
 * P01 REVIEW / attempt selection: independent coverage (#714), authored against
 * the agreed contract (packages/domain/src/types/card-import-review.ts), not
 * against the builder's code.
 *
 * Entry is the real controller route handler (`importStatement`) over the real
 * service and the real PrismaService/soft-delete middleware, on the isolated
 * test DB. Statements are deterministic OFX; no financial rule is simulated.
 *
 * "No write" is proven three ways, none of them updatedAt alone (Prisma's engine
 * stamps updatedAt from the real clock, and a raw or same-value rewrite leaves
 * nothing to compare): a complete physical snapshot (soft-deleted rows
 * included), an SQLite trigger journal that records every INSERT/UPDATE/DELETE
 * (proved live by the INSTRUMENT test), and spies on the calls that must not
 * happen.
 */
const TENANT = "qa-p01-review-independent";
const PROJECT = `${TENANT}-pessoal`;
const OTHER_PROJECT = `${TENANT}-outro`;
const HIDDEN_PROJECT = `${TENANT}-oculto`;
const LAST4 = "0715";
const REQUESTER = {
  ...pessoalRequester(PROJECT),
  allowedProjects: [PROJECT, OTHER_PROJECT],
  id: `${TENANT}-actor`,
};

// Old purchase: 10 x 10000 (total 100000). New purchase: 10 x 15000, other date/FITID.
const OLD_DOC = bankOfx(
  LAST4,
  ofxDebit("20260105120000", 10000, "QA LOJA PARC 1/10", "old-10x10000-fit"),
);
const NEW_LINE = ofxDebit(
  "20260928120000",
  15000,
  "QA LOJA PARC 1/10",
  "new-10x15000-fit",
);
const NEW_DOC = bankOfx(LAST4, NEW_LINE);

const FINANCIAL_TABLES = [
  "expenses",
  "cash_flow_entries",
  "receipts",
  "cross_project_settlements",
  "rateio_allocations",
  "merchant_categories",
] as const;
const JOURNALED_TABLES = [...FINANCIAL_TABLES, "credit_card_imports"] as const;
const HEX64 = /^[0-9a-f]{64}$/;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("P01 REVIEW and attempt selection: independent coverage", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const classifier = new MerchantClassifierService(prisma);
  const cards = new CreditCardService(prisma, conciliacao, classifier);
  const controller = new CreditCardController(cards);
  let cardId: string;
  let oldExpenseId: string;
  let warn: jest.SpyInstance;

  // ── entry points ───────────────────────────────────────────────────────
  const file = (document: Buffer) =>
    [{ buffer: document, originalname: "qa.ofx" }] as never;
  const preview = (document: Buffer): Promise<Json> =>
    controller.importStatement(
      TENANT,
      REQUESTER,
      PROJECT,
      cardId,
      file(document),
      { source: "OFX", mode: "preview" } as never,
      {},
    ) as Promise<Json>;
  /** `selected` is sent as the multipart text field; strings are sent verbatim. */
  const commit = (
    document: Buffer,
    opts: { decisions?: Json[]; selected?: unknown } = {},
  ): Promise<Json> =>
    controller.importStatement(
      TENANT,
      REQUESTER,
      PROJECT,
      cardId,
      file(document),
      { source: "OFX", mode: "commit" } as never,
      {
        ...(opts.decisions
          ? { decisions: JSON.stringify(opts.decisions) }
          : {}),
        ...(opts.selected === undefined
          ? {}
          : {
              selectedExternalIds:
                typeof opts.selected === "string"
                  ? opts.selected
                  : JSON.stringify(opts.selected),
            }),
      } as never,
    ) as Promise<Json>;
  const httpError = async (
    run: Promise<unknown>,
  ): Promise<{ status: number; body: Json }> => {
    try {
      await run;
    } catch (error) {
      if (error instanceof HttpException)
        return {
          status: error.getStatus(),
          body: error.getResponse() as Json,
        };
      throw error;
    }
    throw new Error("expected an HttpException, but the call resolved");
  };

  // ── evidence ───────────────────────────────────────────────────────────
  const physical = async () => ({
    expenses: await setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    }),
    receipts: await setup.receipt.findMany({ where: { tenantId: TENANT } }),
    settlements: await setup.crossProjectSettlement.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
    allocations: await setup.rateioAllocation.findMany({
      where: { tenantId: TENANT },
    }),
    imports: await setup.creditCardStatementImport.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
  });
  const importCount = async () =>
    Number(
      (
        (await setup.$queryRawUnsafe(
          `SELECT COUNT(*) AS c FROM credit_card_imports WHERE tenant_id = '${TENANT}'`,
        )) as { c: bigint | number }[]
      )[0].c,
    );
  type Journal = { tbl: string; op: string; rid: string }[];
  const journal = async (): Promise<Journal> =>
    (await setup.$queryRawUnsafe(
      "SELECT tbl, op, rid FROM qa_write_log ORDER BY id",
    )) as Journal;
  const clearJournal = () =>
    setup.$executeRawUnsafe("DELETE FROM qa_write_log");
  const financialWrites = async () =>
    (await journal()).filter((row) =>
      (FINANCIAL_TABLES as readonly string[]).includes(row.tbl),
    );
  const dropJournal = async () => {
    for (const table of JOURNALED_TABLES)
      for (const op of ["i", "u", "d"])
        await setup.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS qa_w_${table}_${op}`,
        );
    await setup.$executeRawUnsafe("DROP TABLE IF EXISTS qa_write_log");
  };
  const createJournal = async () => {
    await dropJournal();
    await setup.$executeRawUnsafe(
      "CREATE TABLE qa_write_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT, op TEXT, rid TEXT)",
    );
    for (const table of JOURNALED_TABLES) {
      for (const [op, event, ref] of [
        ["i", "INSERT", "NEW"],
        ["u", "UPDATE", "NEW"],
        ["d", "DELETE", "OLD"],
      ]) {
        await setup.$executeRawUnsafe(
          `CREATE TRIGGER qa_w_${table}_${op} AFTER ${event} ON ${table} BEGIN INSERT INTO qa_write_log (tbl, op, rid) VALUES ('${table}', '${op.toUpperCase()}', ${ref}.id); END`,
        );
      }
    }
  };
  /** Rows of the old family (root + its cash flow) touched by any journaled write. */
  const oldFamilyWrites = async (): Promise<Journal> => {
    const ids = new Set([oldExpenseId]);
    for (const cfe of await setup.cashFlowEntry.findMany({
      where: { expenseId: oldExpenseId },
      select: { id: true },
    }))
      ids.add(cfe.id);
    return (await journal()).filter((row) => ids.has(row.rid));
  };

  const externalIdsInParseOrder = async (document: Buffer) =>
    (await preview(document)).preview.map(
      (line: Json) => line.externalId as string,
    );

  /** Counters and per-line results obey the agreed identity, in parse order. */
  async function expectCommitContract(
    result: Json,
    document: Buffer,
    parseOrder?: string[],
  ) {
    // Contract fields must exist before any counter arithmetic is attempted.
    expect(result).toEqual(
      expect.objectContaining({
        lineResults: expect.any(Array),
        reviewRequired: expect.any(Array),
        skippedItems: expect.any(Array),
        possibleDuplicates: expect.any(Array),
        notSelected: expect.any(Number),
      }),
    );
    const order = parseOrder ?? (await externalIdsInParseOrder(document));
    expect(result.total).toBe(order.length);
    expect(
      result.inserted +
        result.settled +
        result.duplicated +
        result.skipped +
        result.possibleDuplicates.length +
        result.reviewRequired.length +
        result.notSelected,
    ).toBe(result.total);
    expect(result.lineResults.map((r: Json) => r.externalId)).toEqual(order);
    for (const line of result.lineResults) {
      expect(Object.keys(line).sort()).toEqual(
        line.linked
          ? ["externalId", "linked", "outcome"]
          : ["externalId", "outcome"],
      );
      if (line.linked !== undefined) expect(line.linked).toBe(true);
    }
  }
  /** A preview line's review, required to be a reviewable one; returns its fingerprint. */
  const reviewFingerprintOf = (line: Json): string => {
    expect(line.review).toMatchObject({
      reason: "REVIEW_REQUIRED",
      fingerprint: expect.stringMatching(HEX64),
    });
    return line.review.fingerprint as string;
  };
  const outcomes = (result: Json) =>
    Object.fromEntries(
      result.lineResults.map((r: Json) => [r.externalId, r.outcome]),
    );

  // ── lifecycle ──────────────────────────────────────────────────────────
  beforeAll(async () => {
    await setup.$connect();
    await prisma.$connect();
    await createJournal();
  });

  beforeEach(async () => {
    jest.useFakeTimers({
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
    jest.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await resetTenant(setup, TENANT);
    await clearJournal();
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    for (const [projectId, name] of [
      [OTHER_PROJECT, "Outro"],
      [HIDDEN_PROJECT, "Oculto"],
    ])
      await seedProject(setup, {
        tenantId: TENANT,
        projectId,
        type: "PESSOAL",
        name,
      });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: LAST4,
      closingDay: 27,
      dueDay: 5,
    }));
    // The historical purchase enters through the legacy path (no selection).
    const imported = await commit(OLD_DOC);
    expect(imported).toMatchObject({ inserted: 1, skipped: 0, duplicated: 0 });
    const old = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: imported.importId },
      include: { cashFlow: true },
    });
    expect(old).toMatchObject({
      valorTotal: 100000,
      quantidadeParcela: 10,
      seriesKey: `${cardId}|qa loja|10000|10`,
    });
    expect(old.cashFlow).toHaveLength(10);
    oldExpenseId = old.id;
    // The journal is alive: setup's own writes are visible in it.
    const setupWrites = await journal();
    expect(
      setupWrites.filter((w) => w.tbl === "expenses" && w.op === "I"),
    ).toHaveLength(1);
    expect(
      setupWrites.filter((w) => w.tbl === "cash_flow_entries" && w.op === "I"),
    ).toHaveLength(10);
    expect(
      setupWrites.filter((w) => w.tbl === "credit_card_imports"),
    ).not.toEqual([]);
    await clearJournal();
    warn.mockClear();
  });

  afterEach(async () => {
    warn.mockRestore();
    jest.restoreAllMocks();
    try {
      await resetTenant(setup, TENANT);
    } finally {
      jest.useRealTimers();
    }
  });

  afterAll(async () => {
    await dropJournal();
    await prisma.$disconnect();
    await setup.$disconnect();
  });

  const readOld = () =>
    setup.expense.findUniqueOrThrow({
      where: { id: oldExpenseId },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    });

  // ── 0. instrument check ───────────────────────────────────────────────
  it("INSTRUMENT: the journal records a same-value rewrite (no value differs)", async () => {
    const before = await readOld();
    await clearJournal();
    await prisma.expense.update({
      where: { id: oldExpenseId },
      data: { titulo: before.titulo },
    });
    expect(await journal()).toEqual([
      { tbl: "expenses", op: "U", rid: oldExpenseId },
    ]);
  });

  // ── 1. real flow: same N, other price ─────────────────────────────────
  it("REVIEW flow: same shop/card/N with another price is reviewed, a human fingerprint creates the new purchase and leaves the old one untouched", async () => {
    const oldBefore = await readOld();
    const before = await physical();

    const proposed = await preview(NEW_DOC);
    expect(proposed.duplicated).toBe(0);
    expect(proposed.preview).toHaveLength(1);
    const line = proposed.preview[0];
    const externalId = line.externalId as string;
    expect(externalId).not.toBe(oldBefore.externalId);
    expect(line.duplicate).toBe(false);
    expect(line.willImport).toBe(false); // no longer a silent skip, and not importable unattended
    expect(line.review).toEqual({
      externalId,
      reason: "REVIEW_REQUIRED",
      fingerprint: expect.stringMatching(HEX64),
      candidates: [
        {
          expenseId: oldExpenseId,
          titulo: oldBefore.titulo,
          installmentCount: 10,
          seriesAmountCents: 10000,
          dataCompra: "2026-01-05",
        },
      ],
    });
    const fingerprint = reviewFingerprintOf(line);
    expect(await physical()).toEqual(before);

    // Legacy commit (no selection): the line waits for a human, nothing is written.
    await clearJournal();
    const waiting = await commit(NEW_DOC);
    await expectCommitContract(waiting, NEW_DOC, [externalId]);
    expect(waiting).toMatchObject({
      inserted: 0,
      settled: 0,
      duplicated: 0,
      skipped: 0,
      notSelected: 0,
      possibleDuplicates: [],
      skippedItems: [],
    });
    expect(waiting.reviewRequired).toEqual([line.review]);
    expect(waiting.lineResults).toEqual([
      { externalId, outcome: "REVIEW_REQUIRED" },
    ]);
    expect(await financialWrites()).toEqual([]);
    expect({ ...(await physical()), imports: 0 }).toEqual({
      ...before,
      imports: 0,
    });

    // `import` without the reviewed fingerprint is not a decision.
    await clearJournal();
    const noFingerprint = await commit(NEW_DOC, {
      decisions: [{ externalId, action: "import" }],
    });
    expect(outcomes(noFingerprint)).toEqual({
      [externalId]: "REVIEW_REQUIRED",
    });
    expect(noFingerprint.inserted).toBe(0);
    expect(await financialWrites()).toEqual([]);

    // The human confirms exactly what was reviewed.
    await clearJournal();
    const confirmed = await commit(NEW_DOC, {
      decisions: [
        { externalId, action: "import", reviewFingerprint: fingerprint },
      ],
    });
    await expectCommitContract(confirmed, NEW_DOC, [externalId]);
    expect(confirmed).toMatchObject({
      inserted: 1,
      settled: 0,
      duplicated: 0,
      skipped: 0,
      notSelected: 0,
      reviewRequired: [],
      skippedItems: [],
    });
    expect(confirmed.lineResults).toEqual([{ externalId, outcome: "CREATED" }]);

    const created = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: confirmed.importId },
      include: { cashFlow: { orderBy: { parcela: "asc" } } },
    });
    expect(created).toMatchObject({
      id: expect.not.stringMatching(oldExpenseId),
      externalId,
      valor: 150000,
      valorTotal: 150000,
      quantidadeParcela: 10,
      status: "PLANEJADO",
      seriesKey: `${cardId}|qa loja|15000|10`,
    });
    expect(created.cashFlow).toHaveLength(10);
    expect(new Set(created.cashFlow.map((c) => c.valor))).toEqual(
      new Set([15000]),
    );

    // The old purchase: identical row and cash flow, and never written to.
    expect(await readOld()).toEqual(oldBefore);
    expect(await oldFamilyWrites()).toEqual([]);
    const after = await physical();
    expect(after.expenses).toHaveLength(2);
    expect(after.expenses.reduce((sum, row) => sum + row.valorTotal, 0)).toBe(
      250000,
    );
    expect(after.expenses.flatMap((row) => row.cashFlow)).toHaveLength(20);
    expect(after.receipts).toEqual([]);
    expect(after.settlements).toEqual([]);

    // Replay: the created row is now a strong duplicate; no second creation.
    await clearJournal();
    const replay = await commit(NEW_DOC, {
      decisions: [
        { externalId, action: "import", reviewFingerprint: fingerprint },
      ],
    });
    expect(replay).toMatchObject({
      inserted: 0,
      duplicated: 1,
      reviewRequired: [],
    });
    expect(replay.lineResults).toEqual([{ externalId, outcome: "DUPLICATED" }]);
    expect(await financialWrites()).toEqual([]);
    expect((await physical()).expenses).toHaveLength(2);
  });

  // ── 2. two attempts: selection keeps finished lines finished ──────────
  describe("second attempt with selectedExternalIds", () => {
    const SINGLE_LINE = ofxDebit(
      "20260928120000",
      8000,
      "QA OUTRA LOJA",
      "single-8000-fit",
    );
    const TWO_LINES = bankOfx(LAST4, SINGLE_LINE, NEW_LINE);
    let target: { id: string; entryId: string };

    beforeEach(async () => {
      target = await seedSinglePurchase(setup, {
        tenantId: TENANT,
        projectId: OTHER_PROJECT,
        cardLast4: "9999",
        valorCents: 8000,
        data: new Date("2026-09-28T00:00:00.000Z"),
      });
      await clearJournal();
    });

    it("a line CREATED and linked in attempt 1 is not relinked, restamped or recounted when only the pending line is selected in attempt 2", async () => {
      const order = await externalIdsInParseOrder(TWO_LINES);
      const [singleId, reviewId] = [
        (await preview(TWO_LINES)).preview.find(
          (l: Json) => l.amountCents === 8000,
        ).externalId as string,
        (await preview(TWO_LINES)).preview.find(
          (l: Json) => l.amountCents === 15000,
        ).externalId as string,
      ];
      const linkSpy = jest.spyOn(cards, "linkToExpense");
      const preflightSpy = jest.spyOn(conciliacao, "assertCanSettleTargets");

      const first = await commit(TWO_LINES, {
        selected: [singleId, reviewId],
        decisions: [
          { externalId: singleId, action: "link", linkToExpenseId: target.id },
        ],
      });
      await expectCommitContract(first, TWO_LINES, order);
      expect(outcomes(first)).toEqual({
        [singleId]: "CREATED",
        [reviewId]: "REVIEW_REQUIRED",
      });
      expect(
        first.lineResults.find((l: Json) => l.externalId === singleId),
      ).toEqual({
        externalId: singleId,
        outcome: "CREATED",
        linked: true,
      });
      expect(first).toMatchObject({ inserted: 1, notSelected: 0, linked: 1 });
      expect(first.reviewRequired).toHaveLength(1);
      const fingerprint = first.reviewRequired[0].fingerprint as string;
      expect(fingerprint).toMatch(HEX64);
      expect(linkSpy).toHaveBeenCalledTimes(1);

      const single = await setup.expense.findFirstOrThrow({
        where: { tenantId: TENANT, externalId: singleId },
      });
      const settlementsAfterFirst = await setup.crossProjectSettlement.findMany(
        {
          where: { tenantId: TENANT },
          orderBy: { id: "asc" },
        },
      );
      expect(settlementsAfterFirst).toHaveLength(1);
      const stateAfterFirst = await physical();
      const firstRecord = stateAfterFirst.imports.find(
        (r) => r.id === first.importId,
      );
      linkSpy.mockClear();
      preflightSpy.mockClear();
      await clearJournal();

      // Attempt 2: only the pending line; the stale link decision for the
      // finished line is still in the payload and must be ignored.
      const second = await commit(TWO_LINES, {
        selected: [reviewId],
        decisions: [
          { externalId: singleId, action: "link", linkToExpenseId: target.id },
          {
            externalId: reviewId,
            action: "import",
            reviewFingerprint: fingerprint,
          },
        ],
      });
      await expectCommitContract(second, TWO_LINES, order);
      expect(outcomes(second)).toEqual({
        [singleId]: "NOT_SELECTED",
        [reviewId]: "CREATED",
      });
      expect(second).toMatchObject({
        inserted: 1,
        duplicated: 0, // not selected is not a duplicate
        notSelected: 1,
        linked: 0,
        skipped: 0,
        reviewRequired: [],
      });
      expect(linkSpy).not.toHaveBeenCalled();
      const settledTargets = preflightSpy.mock.calls.flatMap(
        ([, params]) => params.targetExpenseIds,
      );
      expect(settledTargets).not.toContain(target.id);

      // Nothing about the finished line, its target or the settlement moved.
      const writes = await journal();
      expect(
        writes.filter((w) =>
          [single.id, target.id, target.entryId].includes(w.rid),
        ),
      ).toEqual([]);
      expect(
        writes.filter((w) => w.tbl === "cross_project_settlements"),
      ).toEqual([]);
      expect(await oldFamilyWrites()).toEqual([]);
      const stateAfterSecond = await physical();
      expect(stateAfterSecond.settlements).toEqual(stateAfterFirst.settlements);
      const createdSecond = stateAfterSecond.expenses.filter(
        (row) => row.importId === second.importId,
      );
      expect(createdSecond).toHaveLength(1);
      expect(createdSecond[0].externalId).toBe(reviewId);
      expect(
        stateAfterSecond.expenses.filter(
          (row) => row.importId !== second.importId,
        ),
      ).toEqual(stateAfterFirst.expenses);
      // Attempt 1's record is preserved; attempt 2 persists the unselected line
      // inside its own `skipped`.
      expect(
        stateAfterSecond.imports.find((r) => r.id === first.importId),
      ).toEqual(firstRecord);
      expect(
        stateAfterSecond.imports.find((r) => r.id === second.importId),
      ).toMatchObject({ inserted: 1, skipped: 1 });
    });

    it("a line REUSED and linked in attempt 1 is not restamped or relinked in attempt 2 when it is not selected", async () => {
      const reuseLine = ofxDebit(
        "20260205120000",
        10000,
        "QA LOJA PARC 2/10",
        "reuse-2of10-fit",
      );
      const doc = bankOfx(LAST4, reuseLine, NEW_LINE);
      const reuseTarget = await seedSinglePurchase(setup, {
        tenantId: TENANT,
        projectId: OTHER_PROJECT,
        cardLast4: "9999",
        valorCents: 10000,
        data: new Date("2026-02-05T00:00:00.000Z"),
      });
      // A legacy root that carries no import stamp, so the reuse in attempt 1 adopts it.
      await setup.expense.update({
        where: { id: oldExpenseId },
        data: { externalId: null, dedupeKeyStrong: null, importId: null },
      });
      const first0 = await preview(doc);
      const reuseId = first0.preview.find((l: Json) => l.amountCents === 10000)
        .externalId as string;
      const reviewId = first0.preview.find((l: Json) => l.amountCents === 15000)
        .externalId as string;
      const order = first0.preview.map((l: Json) => l.externalId as string);
      const linkSpy = jest.spyOn(cards, "linkToExpense");

      const first = await commit(doc, {
        selected: [reuseId, reviewId],
        decisions: [
          {
            externalId: reuseId,
            action: "link",
            linkToExpenseId: reuseTarget.id,
          },
        ],
      });
      await expectCommitContract(first, doc, order);
      expect(
        first.lineResults.find((l: Json) => l.externalId === reuseId),
      ).toEqual({
        externalId: reuseId,
        outcome: "REUSED",
        linked: true,
      });
      expect(outcomes(first)[reviewId]).toBe("REVIEW_REQUIRED");
      expect(first).toMatchObject({ inserted: 0, settled: 1, linked: 1 });
      const reusedRoot = await readOld();
      expect(reusedRoot).toMatchObject({
        externalId: reuseId, // adoption stamp from attempt 1
        importId: first.importId,
      });
      const settlementsAfterFirst = await setup.crossProjectSettlement.findMany(
        {
          where: { tenantId: TENANT },
          orderBy: { id: "asc" },
        },
      );
      expect(settlementsAfterFirst).toHaveLength(1);
      // Between attempts the stamp is gone (as an undone adoption leaves it): an
      // unselected line must not be able to stamp the root again.
      await setup.expense.update({
        where: { id: oldExpenseId },
        data: { externalId: null, dedupeKeyStrong: null, importId: null },
      });
      // Re-preview after the reuse: the family context legitimately moved.
      const fingerprint = reviewFingerprintOf(
        (await preview(doc)).preview.find(
          (l: Json) => l.externalId === reviewId,
        ),
      );
      const rootBefore = await readOld();
      linkSpy.mockClear();
      await clearJournal();

      const second = await commit(doc, {
        selected: [reviewId],
        decisions: [
          {
            externalId: reuseId,
            action: "link",
            linkToExpenseId: reuseTarget.id,
          },
          {
            externalId: reviewId,
            action: "import",
            reviewFingerprint: fingerprint,
          },
        ],
      });
      await expectCommitContract(second, doc, order);
      expect(outcomes(second)).toEqual({
        [reuseId]: "NOT_SELECTED",
        [reviewId]: "CREATED",
      });
      expect(second).toMatchObject({
        settled: 0,
        duplicated: 0,
        notSelected: 1,
        linked: 0,
      });
      expect(linkSpy).not.toHaveBeenCalled();
      expect(await readOld()).toEqual(rootBefore);
      expect(await oldFamilyWrites()).toEqual([]);
      expect(
        await setup.crossProjectSettlement.findMany({
          where: { tenantId: TENANT },
          orderBy: { id: "asc" },
        }),
      ).toEqual(settlementsAfterFirst);
      expect(
        (await journal()).filter((w) =>
          [reuseTarget.id, reuseTarget.entryId].includes(w.rid),
        ),
      ).toEqual([]);
    });
  });

  // ── 3. unselected lines never reach the link preflight ────────────────
  describe("a link decision on a line outside the selection", () => {
    const SINGLE_LINE = ofxDebit(
      "20260928120000",
      8000,
      "QA OUTRA LOJA",
      "single-8000-fit",
    );
    const DOC = bankOfx(LAST4, SINGLE_LINE, NEW_LINE);
    let hiddenTarget: { id: string };

    beforeEach(async () => {
      hiddenTarget = await seedSinglePurchase(setup, {
        tenantId: TENANT,
        projectId: HIDDEN_PROJECT,
        cardLast4: "9999",
        valorCents: 8000,
        data: new Date("2026-09-28T00:00:00.000Z"),
      });
      await clearJournal();
    });

    const targets: [string, () => string][] = [
      ["a target id that does not exist", () => "qa-no-such-expense"],
      [
        "a real target in a project outside the requester's ACL",
        () => hiddenTarget.id,
      ],
    ];

    it.each(targets)(
      "does not run preflight, link or stamp for %s, and the selected lines still complete",
      async (_name, pickTarget) => {
        const linkTarget = pickTarget();
        const preview0 = await preview(DOC);
        const singleId = preview0.preview.find(
          (l: Json) => l.amountCents === 8000,
        ).externalId as string;
        const reviewId = preview0.preview.find(
          (l: Json) => l.amountCents === 15000,
        ).externalId as string;
        const preflightSpy = jest.spyOn(conciliacao, "assertCanSettleTargets");
        const linkSpy = jest.spyOn(cards, "linkToExpense");
        const learnSpy = jest.spyOn(classifier, "learnFromImportOverrides");

        const result = await commit(DOC, {
          selected: [singleId],
          decisions: [
            { externalId: singleId },
            {
              externalId: reviewId,
              action: "link",
              linkToExpenseId: linkTarget,
              overrides: { category: "MORADIA", titulo: "QA nao selecionada" },
            },
          ],
        });
        await expectCommitContract(
          result,
          DOC,
          preview0.preview.map((l: Json) => l.externalId),
        );
        expect(outcomes(result)).toEqual({
          [singleId]: "CREATED",
          [reviewId]: "NOT_SELECTED",
        });
        expect(result).toMatchObject({
          inserted: 1,
          notSelected: 1,
          linked: 0,
          skipped: 0,
          duplicated: 0,
          reviewRequired: [],
          possibleDuplicates: [],
        });
        expect(
          preflightSpy.mock.calls.flatMap(
            ([, params]) => params.targetExpenseIds,
          ),
        ).not.toContain(linkTarget);
        expect(linkSpy).not.toHaveBeenCalled();
        // The unselected line's override is not learned either.
        expect(
          learnSpy.mock.calls.flatMap(([entries]) =>
            entries.map((e) => e.merchant),
          ),
        ).not.toContain("QA nao selecionada");
        const writes = await journal();
        expect(
          writes.filter((w) => w.tbl === "cross_project_settlements"),
        ).toEqual([]);
        expect(writes.filter((w) => w.tbl === "merchant_categories")).toEqual(
          [],
        );
        expect(await oldFamilyWrites()).toEqual([]);
        const rows = await setup.expense.findMany({
          where: { tenantId: TENANT, externalId: { in: [singleId, reviewId] } },
        });
        expect(rows.map((r) => r.externalId)).toEqual([singleId]);
      },
    );

    it.each(targets)(
      "CONTROL: the same %s on a SELECTED line is rejected by the preflight before any write",
      async (_name, pickTarget) => {
        const linkTarget = pickTarget();
        const preview0 = await preview(DOC);
        const singleId = preview0.preview.find(
          (l: Json) => l.amountCents === 8000,
        ).externalId as string;
        const before = await physical();
        const preflightSpy = jest.spyOn(conciliacao, "assertCanSettleTargets");
        const failure = await httpError(
          commit(DOC, {
            selected: [singleId],
            decisions: [
              {
                externalId: singleId,
                action: "link",
                linkToExpenseId: linkTarget,
              },
            ],
          }),
        );
        expect(failure.status).toBe(404);
        expect(
          preflightSpy.mock.calls.flatMap(
            ([, params]) => params.targetExpenseIds,
          ),
        ).toContain(linkTarget);
        expect(await journal()).toEqual([]);
        expect(await physical()).toEqual(before);
      },
    );
  });

  // ── 4. a replaced root or cash flow invalidates the fingerprint ───────
  describe("fingerprint after the reviewed family changes", () => {
    async function reviewedFingerprint() {
      const proposed = await preview(NEW_DOC);
      return {
        externalId: proposed.preview[0].externalId as string,
        fingerprint: reviewFingerprintOf(proposed.preview[0]),
      };
    }
    const decide = (externalId: string, reviewFingerprint: string) => ({
      decisions: [{ externalId, action: "import", reviewFingerprint }],
    });

    /** Same key, same amounts, same dates: only the row identities change. */
    async function replaceRoot() {
      const old = await readOld();
      const { cashFlow, id: _oldId, ...root } = old;
      const replacement = await setup.expense.create({
        data: {
          ...(root as Record<string, unknown>),
          externalId: null,
          dedupeKeyStrong: null,
          importId: null,
        } as never,
      });
      for (const { id: _cfeId, expenseId: _e, ...cfe } of cashFlow)
        await setup.cashFlowEntry.create({
          data: {
            ...(cfe as Record<string, unknown>),
            expenseId: replacement.id,
          } as never,
        });
      const stamp = new Date("2026-09-28T12:00:00.000Z");
      await setup.cashFlowEntry.updateMany({
        where: { expenseId: oldExpenseId },
        data: { deletedAt: stamp },
      });
      await setup.expense.update({
        where: { id: oldExpenseId },
        data: { deletedAt: stamp },
      });
      return replacement.id;
    }
    async function replaceCashFlowOnly() {
      const cashFlow = await setup.cashFlowEntry.findMany({
        where: { expenseId: oldExpenseId },
      });
      for (const { id: _id, ...cfe } of cashFlow)
        await setup.cashFlowEntry.create({ data: cfe as never });
      await setup.cashFlowEntry.updateMany({
        where: { id: { in: cashFlow.map((c) => c.id) } },
        data: { deletedAt: new Date("2026-09-28T12:00:00.000Z") },
      });
    }
    /** Only the root's identity changes: the same cash-flow rows are re-pointed at a clone. */
    async function replaceRootKeepingCashFlow() {
      const { cashFlow, id: _oldId, ...root } = await readOld();
      const replacement = await setup.expense.create({
        data: {
          ...(root as Record<string, unknown>),
          externalId: null,
          dedupeKeyStrong: null,
          // importId is kept: the fingerprint also hashes it, so only the root id differs.
        } as never,
      });
      await setup.cashFlowEntry.updateMany({
        where: { id: { in: cashFlow.map((c) => c.id) } },
        data: { expenseId: replacement.id },
      });
      await setup.expense.update({
        where: { id: oldExpenseId },
        data: { deletedAt: new Date("2026-09-28T12:00:00.000Z") },
      });
    }
    const mutations: [string, () => Promise<unknown>][] = [
      ["a replacement root with the same key and cash flow", replaceRoot],
      ["replacement cash-flow rows under the same root", replaceCashFlowOnly],
      [
        "a replacement root adopting the same cash-flow rows",
        replaceRootKeepingCashFlow,
      ],
      [
        "a replacement root adopting the same cash-flow rows",
        replaceRootKeepingCashFlow,
      ],
      [
        "one cash-flow date moved",
        () =>
          setup.cashFlowEntry.updateMany({
            where: { expenseId: oldExpenseId, parcela: "1/10" },
            data: { data: new Date("2026-01-06T00:00:00.000Z") },
          }),
      ],
      [
        "the series paid (root and cash flow status)",
        async () => {
          await setup.expense.update({
            where: { id: oldExpenseId },
            data: { status: "PAGO", paidParcelas: "[0,1,2,3,4,5,6,7,8,9]" },
          });
          await setup.cashFlowEntry.updateMany({
            where: { expenseId: oldExpenseId },
            data: { status: "PAGO" },
          });
        },
      ],
    ];

    it.each(mutations)(
      "%s makes the old fingerprint stale: REVIEW_STALE with a fresh fingerprint and zero effects",
      async (_name, mutate) => {
        const { externalId, fingerprint } = await reviewedFingerprint();
        await mutate();
        const before = await physical();
        await clearJournal();

        const stale = await commit(NEW_DOC, decide(externalId, fingerprint));
        await expectCommitContract(stale, NEW_DOC, [externalId]);
        expect(stale).toMatchObject({ inserted: 0, skipped: 0, duplicated: 0 });
        expect(stale.lineResults).toEqual([
          { externalId, outcome: "REVIEW_REQUIRED" },
        ]);
        expect(stale.reviewRequired).toHaveLength(1);
        expect(stale.reviewRequired[0]).toMatchObject({
          externalId,
          reason: "REVIEW_STALE",
          fingerprint: expect.stringMatching(HEX64),
        });
        expect(stale.reviewRequired[0].fingerprint).not.toBe(fingerprint);
        expect(stale.reviewRequired[0].candidates).not.toEqual([]);
        expect(await financialWrites()).toEqual([]);
        expect({ ...(await physical()), imports: 0 }).toEqual({
          ...before,
          imports: 0,
        });

        // The fresh fingerprint is the one that can be confirmed.
        const created = await commit(
          NEW_DOC,
          decide(externalId, stale.reviewRequired[0].fingerprint),
        );
        expect(created).toMatchObject({ inserted: 1, reviewRequired: [] });
        expect(created.lineResults).toEqual([
          { externalId, outcome: "CREATED" },
        ]);
      },
    );

    it("MIXED STATUS: paying only some nominal cash flows is not BLOCKED; the old fingerprint is STALE, the new review is eligible, and the paid parcels are untouched", async () => {
      const { externalId, fingerprint } = await reviewedFingerprint();
      // Parcels 1-3 paid, 4-10 planned; same amounts, dates and key, no other
      // identity or protective trail on the root.
      await setup.expense.update({
        where: { id: oldExpenseId },
        data: { paidParcelas: "[0,1,2]" },
      });
      await setup.cashFlowEntry.updateMany({
        where: {
          expenseId: oldExpenseId,
          parcela: { in: ["1/10", "2/10", "3/10"] },
        },
        data: { status: "PAGO" },
      });
      const paidBefore = (await readOld()).cashFlow
        .map(({ id, parcela, valor, status, data }) => ({
          id,
          parcela,
          valor,
          status,
          data,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(paidBefore.filter((c) => c.status === "PAGO")).toHaveLength(3);
      const before = await physical();
      await clearJournal();

      const stale = await commit(NEW_DOC, decide(externalId, fingerprint));
      expect(stale.inserted).toBe(0);
      expect(stale.skippedItems).toEqual([]);
      expect(stale.reviewRequired).toHaveLength(1);
      expect(stale.reviewRequired[0]).toMatchObject({
        externalId,
        reason: "REVIEW_STALE",
        fingerprint: expect.stringMatching(HEX64),
      });
      expect(stale.reviewRequired[0].fingerprint).not.toBe(fingerprint);
      expect(stale.reviewRequired[0].candidates).toEqual([
        expect.objectContaining({
          expenseId: oldExpenseId,
          installmentCount: 10,
          seriesAmountCents: 10000,
        }),
      ]);
      expect(await financialWrites()).toEqual([]);
      expect({ ...(await physical()), imports: 0 }).toEqual({
        ...before,
        imports: 0,
      });

      // A fresh preview offers the same eligible review, never BLOCKED_IDENTITY.
      const fresh = (await preview(NEW_DOC)).preview[0];
      expect(fresh.willImport).toBe(false);
      expect(fresh.review).toMatchObject({
        reason: "REVIEW_REQUIRED",
        fingerprint: stale.reviewRequired[0].fingerprint,
      });

      const created = await commit(
        NEW_DOC,
        decide(externalId, stale.reviewRequired[0].fingerprint),
      );
      expect(created).toMatchObject({
        inserted: 1,
        skipped: 0,
        reviewRequired: [],
        skippedItems: [],
      });
      expect(created.lineResults).toEqual([{ externalId, outcome: "CREATED" }]);
      // The reviewed purchase, including its paid parcels, is exactly as before.
      const paidAfter = (await readOld()).cashFlow
        .map(({ id, parcela, valor, status, data }) => ({
          id,
          parcela,
          valor,
          status,
          data,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(paidAfter).toEqual(paidBefore);
      expect(await oldFamilyWrites()).toEqual([]);
    });

    it("CONTROL: touching only volatile timestamps keeps the fingerprint valid", async () => {
      const { externalId, fingerprint } = await reviewedFingerprint();
      await setup.$executeRawUnsafe(
        `UPDATE expenses SET updated_at = '2030-01-01 00:00:00' WHERE id = '${oldExpenseId}'`,
      );
      await setup.$executeRawUnsafe(
        `UPDATE cash_flow_entries SET updated_at = '2030-01-01 00:00:00' WHERE expense_id = '${oldExpenseId}'`,
      );
      const created = await commit(NEW_DOC, decide(externalId, fingerprint));
      expect(created).toMatchObject({ inserted: 1, reviewRequired: [] });
      expect(created.lineResults).toEqual([{ externalId, outcome: "CREATED" }]);
    });

    it("the reviewed family vanishing is STALE with nothing left to confirm (fingerprint null, no candidates) and creates nothing", async () => {
      const { externalId, fingerprint } = await reviewedFingerprint();
      const stamp = new Date("2026-09-28T12:00:00.000Z");
      await setup.cashFlowEntry.updateMany({
        where: { expenseId: oldExpenseId },
        data: { deletedAt: stamp },
      });
      await setup.expense.update({
        where: { id: oldExpenseId },
        data: { deletedAt: stamp },
      });
      await clearJournal();
      const stale = await commit(NEW_DOC, decide(externalId, fingerprint));
      expect(stale.inserted).toBe(0);
      expect(stale.reviewRequired).toEqual([
        {
          externalId,
          reason: "REVIEW_STALE",
          fingerprint: null,
          candidates: [],
        },
      ]);
      expect(stale.lineResults).toEqual([
        { externalId, outcome: "REVIEW_REQUIRED" },
      ]);
      expect(await financialWrites()).toEqual([]);
    });
  });

  // ── 5. a vanished selected id: zero effects, ImportRecord included ────
  describe("selectedExternalIds that no longer match the parsed statement", () => {
    const DOC = bankOfx(
      LAST4,
      ofxDebit("20260928120000", 8000, "QA OUTRA LOJA", "single-8000-fit"),
      NEW_LINE,
    );

    it("answers 409 SELECTED_ROWS_CHANGED with only the ids the client sent, before any record, dedupe, preflight or link", async () => {
      const proposed = await preview(DOC);
      const [firstId] = proposed.preview.map(
        (l: Json) => l.externalId as string,
      );
      const target = await seedSinglePurchase(setup, {
        tenantId: TENANT,
        projectId: OTHER_PROJECT,
        cardLast4: "9999",
        valorCents: 8000,
        data: new Date("2026-09-28T00:00:00.000Z"),
      });
      const before = await physical();
      const importsBefore = await importCount();
      await clearJournal();
      const preflightSpy = jest.spyOn(conciliacao, "assertCanSettleTargets");
      const linkSpy = jest.spyOn(cards, "linkToExpense");
      const learnSpy = jest.spyOn(classifier, "learnFromImportOverrides");
      const gone = Array.from(
        { length: 60 },
        (_, i) => `gone-${String(i).padStart(2, "0")}`,
      );

      const failure = await httpError(
        commit(DOC, {
          selected: [firstId, ...gone],
          decisions: [
            { externalId: firstId, action: "link", linkToExpenseId: target.id },
          ],
        }),
      );
      expect(failure.status).toBe(409);
      expect(failure.body).toMatchObject({
        code: "SELECTED_ROWS_CHANGED",
        missingCount: 60,
        missingExternalIds: gone.slice(0, 50),
      });
      expect(await importCount()).toBe(importsBefore);
      expect(await journal()).toEqual([]);
      expect(await physical()).toEqual(before);
      expect(preflightSpy).not.toHaveBeenCalled();
      expect(linkSpy).not.toHaveBeenCalled();
      expect(learnSpy).not.toHaveBeenCalled();
    });

    // Own test so the zero-effect assertions above still run while this one is
    // red: CardImportSelectedRowsChanged declares exactly these three fields.
    it("the 409 body carries exactly the contract fields (CardImportSelectedRowsChanged)", async () => {
      const preview0 = await preview(DOC);
      const validId = preview0.preview[0].externalId as string;
      const failure = await httpError(
        commit(DOC, { selected: [validId, "gone-1"] }),
      );
      expect(failure.status).toBe(409);
      expect(failure.body).toEqual({
        code: "SELECTED_ROWS_CHANGED",
        missingCount: 1,
        missingExternalIds: ["gone-1"],
      });
    });

    it("an id taken from a different statement is the same 409, not a partial import of the valid ids", async () => {
      const other = bankOfx(
        LAST4,
        ofxDebit(
          "20260929120000",
          4100,
          "QA LOJA DE OUTRO EXTRATO",
          "other-doc-fit",
        ),
      );
      const foreignId = (await preview(other)).preview[0].externalId as string;
      const validId = (await preview(DOC)).preview[0].externalId as string;
      const before = await physical();
      const importsBefore = await importCount();
      const failure = await httpError(
        commit(DOC, { selected: [validId, foreignId] }),
      );
      expect(failure.status).toBe(409);
      expect(failure.body).toMatchObject({
        code: "SELECTED_ROWS_CHANGED",
        missingCount: 1,
        missingExternalIds: [foreignId],
      });
      expect(await importCount()).toBe(importsBefore);
      expect(await physical()).toEqual(before);
    });

    it.each([
      ["an empty array", "[]"],
      ["a repeated id", '["a","a"]'],
      ["an empty-string entry", '["a",""]'],
      ["a non-string entry", '["a",7]'],
      ["a non-array JSON value", '{"a":1}'],
      ["text that is not JSON", "not-json"],
    ])(
      "%s is 400 INVALID_SELECTION with zero effects (no ImportRecord)",
      async (_name, raw) => {
        const before = await physical();
        const importsBefore = await importCount();
        await clearJournal();
        const failure = await httpError(commit(DOC, { selected: raw }));
        expect(failure.status).toBe(400);
        expect(failure.body).toMatchObject({ code: "INVALID_SELECTION" });
        expect(await importCount()).toBe(importsBefore);
        expect(await journal()).toEqual([]);
        expect(await physical()).toEqual(before);
      },
    );
  });

  // ── 6. controls: legacy, strong identity, ERROR shape ─────────────────
  describe("controls", () => {
    it("legacy mode (no selectedExternalIds) still processes every parsed line and reports per-line results in parse order", async () => {
      const single = bankOfx(
        LAST4,
        ofxDebit("20260928120000", 8000, "QA OUTRA LOJA", "single-8000-fit"),
      );
      const firstRun = await commit(single);
      expect(firstRun.inserted).toBe(1);
      const doc = bankOfx(
        LAST4,
        ofxDebit("20260928120000", 8000, "QA OUTRA LOJA", "single-8000-fit"),
        ofxDebit("20260929120000", 4100, "QA MERCADO", "market-4100-fit"),
      );
      const result = await commit(doc);
      await expectCommitContract(result, doc);
      expect(result).toMatchObject({
        total: 2,
        inserted: 1,
        duplicated: 1,
        skipped: 0,
        notSelected: 0,
        reviewRequired: [],
        skippedItems: [],
      });
      expect(result.lineResults.map((l: Json) => l.outcome)).toEqual([
        "DUPLICATED",
        "CREATED",
      ]);
    });

    it("a strong duplicate cannot be forced by a fingerprint-shaped `import` decision", async () => {
      const before = await physical();
      await clearJournal();
      const oldId = (await preview(OLD_DOC)).preview[0].externalId as string;
      const result = await commit(OLD_DOC, {
        decisions: [
          {
            externalId: oldId,
            action: "import",
            reviewFingerprint: "a".repeat(64),
          },
        ],
      });
      expect(result).toMatchObject({
        inserted: 0,
        duplicated: 1,
        reviewRequired: [],
      });
      expect(result.lineResults).toEqual([
        { externalId: oldId, outcome: "DUPLICATED" },
      ]);
      expect(await financialWrites()).toEqual([]);
      expect({ ...(await physical()), imports: 0 }).toEqual({
        ...before,
        imports: 0,
      });
    });

    it("a strong identity of another project on the reviewed line is BLOCKED_IDENTITY: no fingerprint, no override, nothing created", async () => {
      const proposed = await preview(NEW_DOC);
      const externalId = proposed.preview[0].externalId as string;
      const foreign = await setup.expense.create({
        data: {
          tenantId: TENANT,
          projectId: OTHER_PROJECT,
          tipoDespesa: "OUTROS",
          titulo: "Homonimo com identidade forte",
          valor: 15000,
          quantidade: 1,
          valorTotal: 15000,
          formaPagamento: "A_VISTA",
          dataPagamento: new Date("2026-09-28T00:00:00.000Z"),
          status: "PLANEJADO",
          externalId,
          cardLast4: "9999",
        },
      });
      await setup.cashFlowEntry.create({
        data: {
          tenantId: TENANT,
          projectId: OTHER_PROJECT,
          expenseId: foreign.id,
          valor: 15000,
          tipo: "DESPESA",
          categoria: "OUTROS",
          data: new Date("2026-09-28T00:00:00.000Z"),
          status: "PLANEJADO",
          formaPagamento: "CARTAO_CREDITO",
        },
      });
      const shown = await preview(NEW_DOC);
      expect(shown.preview[0].willImport).toBe(false);
      expect(shown.preview[0].review).toEqual({
        externalId,
        reason: "BLOCKED_IDENTITY",
        fingerprint: null,
        candidates: [],
      });
      const before = await physical();
      await clearJournal();
      const result = await commit(NEW_DOC, {
        decisions: [
          { externalId, action: "import", reviewFingerprint: "b".repeat(64) },
        ],
      });
      await expectCommitContract(result, NEW_DOC, [externalId]);
      expect(result).toMatchObject({
        inserted: 0,
        skipped: 1,
        reviewRequired: [],
      });
      expect(result.skippedItems).toEqual([
        { externalId, reason: "BLOCKED_IDENTITY" },
      ]);
      expect(result.lineResults).toEqual([{ externalId, outcome: "BLOCKED" }]);
      expect(await financialWrites()).toEqual([]);
      expect({ ...(await physical()), imports: 0 }).toEqual({
        ...before,
        imports: 0,
      });
    });

    it("a technical failure inside the row transaction is ERROR: it rolls back, stays retryable, and the retry creates the purchase once", async () => {
      const failing = ofxDebit(
        "20260929120000",
        4100,
        "QA MERCADO",
        "market-4100-fit",
      );
      const healthy = ofxDebit(
        "20260928120000",
        8000,
        "QA OUTRA LOJA",
        "single-8000-fit",
      );
      const doc = bankOfx(LAST4, failing, healthy);
      const order = await externalIdsInParseOrder(doc);
      const rowsOf = async (needle: string) =>
        Number(
          (
            (await setup.$queryRawUnsafe(
              `SELECT COUNT(*) AS c FROM expenses WHERE tenant_id = '${TENANT}' AND titulo LIKE '%${needle}%'`,
            )) as { c: bigint | number }[]
          )[0].c,
        );
      const cashFlowRows = async (valor: number) =>
        Number(
          (
            (await setup.$queryRawUnsafe(
              `SELECT COUNT(*) AS c FROM cash_flow_entries WHERE tenant_id = '${TENANT}' AND valor = ${valor}`,
            )) as { c: bigint | number }[]
          )[0].c,
        );
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      // The root expense is inserted first and the cash-flow FK needs it, so this
      // real database error fires after the row's effect has started (Prisma reports
      // a trigger ABORT as a constraint violation on the cash-flow insert).
      await setup.$executeRawUnsafe(
        `CREATE TRIGGER qa_fail_cfe BEFORE INSERT ON cash_flow_entries WHEN NEW.tenant_id = '${TENANT}' AND NEW.valor = 4100 BEGIN SELECT RAISE(ABORT, 'qa injected technical failure'); END`,
      );
      try {
        const rootsBefore = await rowsOf("");
        const result = await commit(doc);
        await expectCommitContract(result, doc, order);
        expect(result).toMatchObject({
          total: 2,
          inserted: 1,
          skipped: 1,
          notSelected: 0,
          skippedItems: [],
          reviewRequired: [],
        });
        expect(result.lineResults).toEqual([
          { externalId: order[0], outcome: "ERROR" },
          { externalId: order[1], outcome: "CREATED" },
        ]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("tx skipped"),
          expect.stringContaining("cashFlowEntry.create"),
        );
        // Rolled back: no root and no cash flow of the failed line, only the healthy purchase.
        expect(await rowsOf("MERCADO")).toBe(0);
        expect(await cashFlowRows(4100)).toBe(0);
        expect(await rowsOf("OUTRA LOJA")).toBe(1);
        expect(await rowsOf("")).toBe(rootsBefore + 1);
        const afterFirst = await physical();

        // Still failing: the retry names only the ERROR line and it stays pending.
        const stillFailing = await commit(doc, { selected: [order[0]] });
        await expectCommitContract(stillFailing, doc, order);
        expect(outcomes(stillFailing)).toEqual({
          [order[0]]: "ERROR",
          [order[1]]: "NOT_SELECTED",
        });
        expect(stillFailing).toMatchObject({
          inserted: 0,
          skipped: 1,
          notSelected: 1,
          duplicated: 0,
        });
        expect(await rowsOf("MERCADO")).toBe(0);
        expect(await cashFlowRows(4100)).toBe(0);
        expect({ ...(await physical()), imports: 0 }).toEqual({
          ...afterFirst,
          imports: 0,
        });

        // Failure cleared: the same retry creates the purchase exactly once.
        await setup.$executeRawUnsafe("DROP TRIGGER qa_fail_cfe");
        const retried = await commit(doc, { selected: [order[0]] });
        await expectCommitContract(retried, doc, order);
        expect(outcomes(retried)).toEqual({
          [order[0]]: "CREATED",
          [order[1]]: "NOT_SELECTED",
        });
        expect(retried).toMatchObject({
          inserted: 1,
          skipped: 0,
          notSelected: 1,
          duplicated: 0,
        });
        expect(await rowsOf("MERCADO")).toBe(1);
        expect(await cashFlowRows(4100)).toBe(1);
        expect(await rowsOf("")).toBe(rootsBefore + 2);
        // The healthy purchase of the first attempt is untouched.
        const healthyRow = (snapshot: Awaited<ReturnType<typeof physical>>) =>
          snapshot.expenses.find((e) => e.titulo?.includes("OUTRA LOJA"));
        expect(healthyRow(await physical())).toEqual(healthyRow(afterFirst));
      } finally {
        await setup.$executeRawUnsafe("DROP TRIGGER IF EXISTS qa_fail_cfe");
        warn.mockRestore();
      }
    });

    // The document amount is valid and tiny; only the explicit valorCents override is
    // invalid, so the ImportRecord total (parsed amount) never overflows.
    it.each([
      ["zero", 0, "20260901120000", 4101],
      ["int32-max-plus-one", 2_147_483_648, "20260902120000", 4102],
      ["fractional", 10.5, "20260903120000", 4103],
    ])(
      "an invalid valorCents override (%s) makes that line a retryable ERROR with no effect, and the corrected value creates it once",
      async (label, invalid, stamp, cents) => {
        const doc = bankOfx(
          LAST4,
          ofxDebit(stamp, cents, `QA OVERRIDE ${label}`, `ovr-${label}-fit`),
        );
        const [externalId] = await externalIdsInParseOrder(doc);
        const decide = (valorCents: number) => ({
          decisions: [
            { externalId, action: "create", overrides: { valorCents } },
          ],
        });
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const before = await physical();
          await clearJournal();
          const failed = await commit(doc, decide(invalid));
          await expectCommitContract(failed, doc, [externalId]);
          expect(failed).toMatchObject({
            total: 1,
            inserted: 0,
            settled: 0,
            duplicated: 0,
            skipped: 1,
            skippedItems: [],
            reviewRequired: [],
          });
          expect(failed.lineResults).toEqual([
            { externalId, outcome: "ERROR" },
          ]);
          expect(await financialWrites()).toEqual([]);
          expect({ ...(await physical()), imports: 0 }).toEqual({
            ...before,
            imports: 0,
          });

          const fixed = await commit(doc, decide(cents));
          await expectCommitContract(fixed, doc, [externalId]);
          expect(fixed).toMatchObject({ inserted: 1, skipped: 0 });
          expect(fixed.lineResults).toEqual([
            { externalId, outcome: "CREATED" },
          ]);
          const known = new Set(before.expenses.map((e) => e.id));
          const created = (await physical()).expenses.filter(
            (e) => !known.has(e.id),
          );
          expect(created).toHaveLength(1);
          expect(created[0]).toMatchObject({ valorTotal: cents });
          expect(created[0].cashFlow.map((c) => c.valor)).toEqual([cents]);

          const replay = await commit(doc, decide(cents));
          expect(outcomes(replay)).toEqual({ [externalId]: "DUPLICATED" });
          expect(
            (await physical()).expenses.filter((e) => !known.has(e.id)),
          ).toHaveLength(1);
        } finally {
          warn.mockRestore();
        }
      },
    );

    it("an invoice-payment line is a terminal SKIPPED policy outcome: no effect, not ERROR, not retryable", async () => {
      const doc = bankOfx(
        LAST4,
        ofxDebit(
          "20260928120000",
          25000,
          "PAGAMENTO EFETUADO",
          "invoice-payment-fit",
        ),
        ofxDebit("20260929120000", 4100, "QA MERCADO", "market-4100-fit"),
      );
      const order = await externalIdsInParseOrder(doc);
      const rootsBefore = await setup.expense.count({
        where: { tenantId: TENANT },
      });
      await clearJournal();
      const result = await commit(doc);
      await expectCommitContract(result, doc, order);
      expect(result).toMatchObject({
        total: 2,
        inserted: 1,
        skipped: 1,
        notSelected: 0,
        skippedItems: [],
        reviewRequired: [],
      });
      expect(result.lineResults).toEqual([
        { externalId: order[0], outcome: "SKIPPED" },
        { externalId: order[1], outcome: "CREATED" },
      ]);
      const created = await setup.expense.findMany({
        where: { tenantId: TENANT },
      });
      expect(created).toHaveLength(rootsBefore + 1);
      expect(created.filter((e) => /PAGAMENTO/i.test(e.titulo ?? ""))).toEqual(
        [],
      );
      expect(
        await setup.cashFlowEntry.count({
          where: { tenantId: TENANT, valor: 25000 },
        }),
      ).toBe(0);
      // Terminal: naming the line again is a no-op that keeps the same outcome.
      const before = await physical();
      await clearJournal();
      const retry = await commit(doc, { selected: [order[0]] });
      expect(outcomes(retry)).toEqual({
        [order[0]]: "SKIPPED",
        [order[1]]: "NOT_SELECTED",
      });
      expect(retry).toMatchObject({ inserted: 0, notSelected: 1 });
      expect(await financialWrites()).toEqual([]);
      expect({ ...(await physical()), imports: 0 }).toEqual({
        ...before,
        imports: 0,
      });
    });
  });

  // ── 7. preview payment signal (design v2, files/p01-payment-preview-design.md) ──
  describe("invoice-payment lines in the preview", () => {
    /** A CREDIT line: TRNAMT positive, which the card parser reads as a negative amount. */
    const ofxCredit = (
      date: string,
      amountCents: number,
      memo: string,
      fitId: string,
    ) =>
      ofxDebit(date, amountCents, memo, fitId)
        .replace("<TRNTYPE>DEBIT</TRNTYPE>", "<TRNTYPE>CREDIT</TRNTYPE>")
        .replace("<TRNAMT>-", "<TRNAMT>");
    // Literal expectation: the design's wire value, not a constant under protection.
    const INVOICE_PAYMENT = "INVOICE_PAYMENT";
    const PAYMENTS = [
      [
        "PAGAMENTO EFETUADO",
        ofxCredit(
          "20260910120000",
          5000,
          "PAGAMENTO EFETUADO",
          "pay-credit-fit",
        ),
      ],
      [
        "PAGAMENTO EFETUADO 2",
        ofxDebit(
          "20260911120000",
          5000,
          "PAGAMENTO EFETUADO 2",
          "pay-debit-fit",
        ),
      ],
      [
        "PAGAMENTO PIX",
        ofxDebit("20260912120000", 2000, "PAGAMENTO PIX", "pay-pix-fit"),
      ],
      [
        "PGTO FAT ITAU",
        ofxDebit("20260913120000", 3000, "PGTO FAT ITAU", "pay-pgto-fit"),
      ],
      [
        "FATURA PAG 09",
        ofxDebit("20260914120000", 3500, "FATURA PAG 09", "pay-fatura-fit"),
      ],
    ] as const;
    const NOT_A_PAYMENT = ofxDebit(
      "20260915120000",
      1500,
      "PAGAMENTO CONTA LUZ",
      "pay-conta-fit",
    );
    const PURCHASE = ofxDebit(
      "20260916120000",
      4100,
      "QA MERCADO",
      "pay-market-fit",
    );
    const MIXED = bankOfx(
      LAST4,
      ...PAYMENTS.map(([, line]) => line),
      NOT_A_PAYMENT,
      PURCHASE,
    );
    const lineOf = (shown: Json, needle: string): Json => {
      const found = shown.preview.filter((l: Json) => l.merchant === needle);
      expect(found).toHaveLength(1);
      return found[0];
    };
    const newExpenses = async (
      before: Awaited<ReturnType<typeof physical>>,
    ) => {
      const known = new Set(before.expenses.map((e) => e.id));
      return (await physical()).expenses.filter((e) => !known.has(e.id));
    };
    /** Witness of ANOTHER engine that matches only the natural key (real Tier B). */
    const seedNaturalWitness = async (document: Buffer, needle: string) => {
      const parsed = await parseStatementBuffers(
        [document],
        cardId,
        "OFX",
        "qa.ofx",
        undefined,
      );
      attachDedupeKeys(parsed.transactions, {
        tenantId: TENANT,
        projectId: PROJECT,
        fileContentHash: "qa-other-engine",
      });
      const line = parsed.transactions.filter((t) =>
        t.merchant.includes(needle),
      );
      expect(line).toHaveLength(1);
      expect(line[0].dedupeKeyNatural).toEqual(expect.any(String));
      return setup.expense.create({
        data: {
          tenantId: TENANT,
          projectId: PROJECT,
          tipoDespesa: "OUTROS",
          titulo: "Testemunha de outro motor",
          valor: Math.abs(line[0].amountCents),
          valorTotal: Math.abs(line[0].amountCents),
          quantidade: 1,
          formaPagamento: "A_VISTA",
          status: "PLANEJADO",
          origin: "import",
          dedupeKeyNatural: line[0].dedupeKeyNatural ?? null,
        },
      });
    };

    it("marks every invoice-payment line (credit and debit sign, PIX, PGTO FAT, FATURA PAG) as ignored while the file total stays factual", async () => {
      const shown = await preview(MIXED);
      expect(shown.total).toBe(PAYMENTS.length + 2);
      expect(shown.duplicated).toBe(0);
      for (const [needle] of PAYMENTS) {
        const line = lineOf(shown, needle);
        expect(line).toMatchObject({
          ignored: INVOICE_PAYMENT,
          willImport: false,
          duplicate: false,
          review: null,
        });
      }
      expect(lineOf(shown, "PAGAMENTO CONTA LUZ")).toMatchObject({
        ignored: null,
        willImport: true,
        duplicate: false,
      });
      expect(lineOf(shown, "QA MERCADO")).toMatchObject({
        ignored: null,
        willImport: true,
      });
      expect(shown.possibleDuplicates).toEqual([]);
    });

    it("a legacy commit without selection creates nothing for ignored lines and stamps none, while the purchases are CREATED", async () => {
      const shown = await preview(MIXED);
      const before = await physical();
      await clearJournal();
      const result = await commit(MIXED);
      await expectCommitContract(result, MIXED);
      const outcomeOf = (needle: string) =>
        outcomes(result)[lineOf(shown, needle).externalId as string];
      for (const [needle] of PAYMENTS)
        expect(["SKIPPED", "POSSIBLE_DUPLICATE", "NOT_SELECTED"]).toContain(
          outcomeOf(needle),
        );
      expect(outcomeOf("PAGAMENTO CONTA LUZ")).toBe("CREATED");
      expect(outcomeOf("QA MERCADO")).toBe("CREATED");
      const created = await newExpenses(before);
      expect(created.map((e) => e.titulo).sort()).toEqual([
        "PAGAMENTO CONTA LUZ",
        "QA MERCADO",
      ]);
      expect(created.every((e) => e.importId === result.importId)).toBe(true);
      const cashFlowWrites = (await financialWrites()).filter(
        (w) => w.tbl === "cash_flow_entries",
      );
      expect(cashFlowWrites).toHaveLength(2);
    });

    it("payment + strong witness: the strong identity wins, the line is a duplicate and never ignored", async () => {
      const shown = await preview(MIXED);
      const target = lineOf(shown, "PAGAMENTO PIX");
      await setup.expense.create({
        data: {
          tenantId: TENANT,
          projectId: PROJECT,
          tipoDespesa: "OUTROS",
          titulo: "Testemunha forte",
          valor: 2000,
          valorTotal: 2000,
          quantidade: 1,
          formaPagamento: "A_VISTA",
          status: "PLANEJADO",
          externalId: target.externalId,
        },
      });
      const again = await preview(MIXED);
      expect(lineOf(again, "PAGAMENTO PIX")).toMatchObject({
        duplicate: true,
        ignored: null,
        willImport: false,
        review: null,
      });
      expect(lineOf(again, "PAGAMENTO EFETUADO 2")).toMatchObject({
        ignored: INVOICE_PAYMENT,
        duplicate: false,
      });
      expect(again.duplicated).toBe(1);
      const before = await physical();
      const result = await commit(MIXED);
      expect(outcomes(result)[target.externalId as string]).toBe("DUPLICATED");
      expect((await newExpenses(before)).map((e) => e.titulo).sort()).toEqual([
        "PAGAMENTO CONTA LUZ",
        "QA MERCADO",
      ]);
    });

    describe("payment + Tier B witness of another engine", () => {
      it("preview: still ignored (independent of Tier B), the possibleDuplicate metadata stays, no review, not importable", async () => {
        const witness = await seedNaturalWitness(MIXED, "PGTO FAT ITAU");
        const shown = await preview(MIXED);
        const line = lineOf(shown, "PGTO FAT ITAU");
        expect(line).toMatchObject({
          ignored: INVOICE_PAYMENT,
          duplicate: false,
          willImport: false,
          review: null,
        });
        expect(line.possibleDuplicate).toMatchObject({
          externalId: line.externalId,
          existingId: witness.id,
        });
        expect(shown.possibleDuplicates.map((p: Json) => p.externalId)).toEqual(
          [line.externalId],
        );
      });

      it("legacy commit without decision keeps the Tier B precedence (POSSIBLE_DUPLICATE) with zero expenses for it", async () => {
        await seedNaturalWitness(MIXED, "PGTO FAT ITAU");
        const shown = await preview(MIXED);
        const target = lineOf(shown, "PGTO FAT ITAU").externalId as string;
        const before = await physical();
        const result = await commit(MIXED);
        await expectCommitContract(result, MIXED);
        expect(outcomes(result)[target]).toBe("POSSIBLE_DUPLICATE");
        expect(
          result.possibleDuplicates.map((p: Json) => p.externalId),
        ).toEqual([target]);
        expect((await newExpenses(before)).map((e) => e.titulo).sort()).toEqual(
          ["PAGAMENTO CONTA LUZ", "QA MERCADO"],
        );
      });

      it("a forced `import` decision on it ends SKIPPED, never a purchase", async () => {
        await seedNaturalWitness(MIXED, "PGTO FAT ITAU");
        const shown = await preview(MIXED);
        const target = lineOf(shown, "PGTO FAT ITAU").externalId as string;
        const before = await physical();
        const result = await commit(MIXED, {
          decisions: [{ externalId: target, action: "import" }],
        });
        await expectCommitContract(result, MIXED);
        expect(outcomes(result)[target]).toBe("SKIPPED");
        expect(result.skippedItems).toEqual([]);
        expect((await newExpenses(before)).map((e) => e.titulo).sort()).toEqual(
          ["PAGAMENTO CONTA LUZ", "QA MERCADO"],
        );
      });

      it("CONTROL: a purchase with the same Tier B witness is not ignored and keeps its possibleDuplicate", async () => {
        const witness = await seedNaturalWitness(MIXED, "QA MERCADO");
        const shown = await preview(MIXED);
        const line = lineOf(shown, "QA MERCADO");
        expect(line).toMatchObject({
          ignored: null,
          willImport: false,
          duplicate: false,
        });
        expect(line.possibleDuplicate).toMatchObject({
          existingId: witness.id,
        });
      });
    });

    describe("explicit selection", () => {
      it("selecting only the purchase leaves every payment NOT_SELECTED with no expense, stamp, link or settlement", async () => {
        const shown = await preview(MIXED);
        const purchase = lineOf(shown, "QA MERCADO").externalId as string;
        const linkSpy = jest.spyOn(cards, "linkToExpense");
        const preflightSpy = jest.spyOn(conciliacao, "assertCanSettleTargets");
        const before = await physical();
        await clearJournal();
        const result = await commit(MIXED, { selected: [purchase] });
        await expectCommitContract(result, MIXED);
        const byLine = outcomes(result);
        expect(byLine[purchase]).toBe("CREATED");
        for (const [needle] of PAYMENTS)
          expect(byLine[lineOf(shown, needle).externalId as string]).toBe(
            "NOT_SELECTED",
          );
        expect(
          byLine[lineOf(shown, "PAGAMENTO CONTA LUZ").externalId as string],
        ).toBe("NOT_SELECTED");
        expect(result).toMatchObject({
          inserted: 1,
          notSelected: PAYMENTS.length + 1,
        });
        const created = await newExpenses(before);
        expect(created.map((e) => e.titulo)).toEqual(["QA MERCADO"]);
        const after = await physical();
        expect(after.receipts).toEqual(before.receipts);
        expect(after.settlements).toEqual(before.settlements);
        expect(after.allocations).toEqual(before.allocations);
        const financial = await financialWrites();
        expect(financial.filter((w) => w.tbl === "expenses")).toEqual([
          { tbl: "expenses", op: "I", rid: created[0].id },
        ]);
        expect(
          financial.filter((w) => w.tbl === "cash_flow_entries"),
        ).toHaveLength(1);
        expect(linkSpy).not.toHaveBeenCalled();
        expect(preflightSpy).not.toHaveBeenCalled();
      });

      it.each(["create", "import"])(
        "a legacy client that selects a payment with a `%s` decision and value/title overrides still creates nothing",
        async (action) => {
          const shown = await preview(MIXED);
          const target = lineOf(shown, "PAGAMENTO PIX").externalId as string;
          const before = await physical();
          await clearJournal();
          const result = await commit(MIXED, {
            selected: [target],
            decisions: [
              {
                externalId: target,
                action,
                overrides: { valorCents: 7777, titulo: "QA COMPRA DISFARCADA" },
              },
            ],
          });
          await expectCommitContract(result, MIXED);
          expect(outcomes(result)[target]).toBe("SKIPPED");
          expect(await newExpenses(before)).toEqual([]);
          expect(await financialWrites()).toEqual([]);
          expect(
            await setup.cashFlowEntry.count({
              where: { tenantId: TENANT, valor: 7777 },
            }),
          ).toBe(0);
        },
      );
    });
  });
});
