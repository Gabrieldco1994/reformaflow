require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import {
  bankOfx,
  ofxDebit,
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
  seedProject,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { CreditCardService } from "./credit-card.service";

/**
 * P01 (#714 independent review): installment x installment admission.
 *
 * Two installment purchases at the same card+merchant whose DOCUMENTED full
 * counts are provably different (3/10 vs 1/3) are different purchases. The
 * preview says they are importable; commit must agree. Controls pin every
 * guard that must NOT relax: same full count, remaining-only legacy counts,
 * contradictory explicit counts and strong external identity.
 */
const TENANT = "qa-p01-installment-count-admission";
const PROJECT = `${TENANT}-pessoal`;
const OTHER_PROJECT = `${TENANT}-outro`;
const LAST4 = "0714";
const REQUESTER = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const OLD_DOCUMENT = bankOfx(
  LAST4,
  ofxDebit("20260105120000", 10000, "QA LOJA PARC 3/10", "canonical-3of10-fit"),
);

describe("P01 installment purchases with provably different full counts", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const cards = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  let cardId: string;
  let oldExpenseId: string;
  let warn: jest.SpyInstance;

  const commit = (document: Buffer, fileName: string) =>
    cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      document,
      fileName,
      "OFX",
      undefined,
      undefined,
      undefined,
      REQUESTER.id,
      REQUESTER,
    );
  const preview = (document: Buffer, fileName: string) =>
    cards.previewImport(
      TENANT,
      PROJECT,
      cardId,
      document,
      fileName,
      "OFX",
      undefined,
      REQUESTER,
    );
  const readOld = () =>
    setup.expense.findUniqueOrThrow({
      where: { id: oldExpenseId },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    });
  const readState = async () => ({
    expenses: await setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    }),
    receipts: await setup.receipt.findMany({ where: { tenantId: TENANT } }),
    settlements: await setup.crossProjectSettlement.findMany({
      where: { tenantId: TENANT },
    }),
    allocations: await setup.rateioAllocation.findMany({
      where: { tenantId: TENANT },
    }),
  });
  const conflictWarnings = () =>
    warn.mock.calls.filter(([message]) =>
      String(message).includes("tx skipped"),
    ).length;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.$connect();
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
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    await seedProject(setup, {
      tenantId: TENANT,
      projectId: OTHER_PROJECT,
      type: "PESSOAL",
      name: "Outro",
    });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: LAST4,
      closingDay: 27,
      dueDay: 5,
    }));
    const imported = await commit(OLD_DOCUMENT, "canonical-series.ofx");
    expect(imported).toMatchObject({ inserted: 1, skipped: 0, duplicated: 0 });
    const old = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: imported.importId },
    });
    oldExpenseId = old.id;
    // Fixture preconditions (setup, not the behavior under test): the canonical
    // series is 3/10, so the row stores REMAINING count 8 but full count 10.
    expect(old).toMatchObject({
      valor: 80000,
      valorTotal: 80000,
      quantidadeParcela: 8,
      seriesKey: `${cardId}|qa loja|10000|10`,
    });
    expect(old.dedupeKeyStrong).toEqual(expect.any(String));
    warn.mockClear();
  });

  afterEach(async () => {
    warn.mockRestore();
    try {
      await resetTenant(setup, TENANT);
    } finally {
      jest.useRealTimers();
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await setup.$disconnect();
  });

  const NEW_DOCUMENT = bankOfx(
    LAST4,
    ofxDebit("20260928120000", 5000, "QA LOJA PARC 1/3", "new-1of3-fit"),
  );

  async function expectNewThreeInstallmentPurchaseAdmitted(): Promise<void> {
    const before = await readState();
    const oldBefore = await readOld();
    const proposed = await preview(NEW_DOCUMENT, "new-1of3.ofx");
    // Preview already promises this row is importable.
    expect(proposed.possibleDuplicates).toEqual([]);
    expect(proposed.duplicated).toBe(0);
    expect(proposed.preview).toHaveLength(1);
    expect(proposed.preview[0]).toMatchObject({
      amountCents: 5000,
      duplicate: false,
      willImport: true,
    });

    const result = await commit(NEW_DOCUMENT, "new-1of3.ofx");
    // Commit must agree with the preview it followed.
    expect(result).toMatchObject({
      total: 1,
      inserted: 1,
      duplicated: 0,
      settled: 0,
      skipped: 0,
      possibleDuplicates: [],
    });
    expect(conflictWarnings()).toBe(0);
    const created = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: result.importId },
      include: { cashFlow: { orderBy: { parcela: "asc" } } },
    });
    expect(created).toMatchObject({
      valor: 15000,
      valorTotal: 15000,
      formaPagamento: "PARCELADO",
      quantidadeParcela: 3,
      status: "PLANEJADO",
      cardLast4: LAST4,
      seriesKey: `${cardId}|qa loja|5000|3`,
    });
    expect(created.id).not.toBe(oldExpenseId);
    expect(created.externalId).not.toBe(oldBefore.externalId);
    expect(created.dedupeKeyStrong).not.toBe(oldBefore.dedupeKeyStrong);
    expect(
      created.cashFlow.map(({ parcela, valor, status }) => ({
        parcela,
        valor,
        status,
      })),
    ).toEqual([
      { parcela: "1/3", valor: 5000, status: "PLANEJADO" },
      { parcela: "2/3", valor: 5000, status: "PLANEJADO" },
      { parcela: "3/3", valor: 5000, status: "PLANEJADO" },
    ]);
    // The canonical series is byte-for-byte untouched.
    expect(await readOld()).toEqual(oldBefore);
    const after = await readState();
    expect({
      ...after,
      expenses: after.expenses.filter(({ id }) => id !== created.id),
    }).toEqual(before);
    expect(after.expenses).toHaveLength(2);
    expect(after.expenses.reduce((sum, row) => sum + row.valorTotal, 0)).toBe(
      95000,
    );
    expect(after.expenses.flatMap(({ cashFlow }) => cashFlow)).toHaveLength(11);

    // Idempotent: replaying the same document is a strong duplicate, not a
    // second admission and not a new skip.
    const replayBefore = await readState();
    const replay = await commit(NEW_DOCUMENT, "new-1of3-replay.ofx");
    expect(replay).toMatchObject({
      total: 1,
      inserted: 0,
      duplicated: 1,
      skipped: 0,
    });
    expect(await readState()).toEqual(replayBefore);
  }

  it("admits 1/3 next to the canonical 3/10 series (seriesKey carries the documented full count)", async () => {
    await expectNewThreeInstallmentPurchaseAdmitted();
  });

  // ── Controls: these pass today and must keep passing after the fix ──────

  it("CONTROL: same full count with another FITID and a one-cent change is not proof of a new purchase", async () => {
    const before = await readState();
    const document = bankOfx(
      LAST4,
      ofxDebit("20260105120000", 10001, "QA LOJA PARC 4/10", "same-10-fit-2"),
    );
    const result = await commit(document, "same-total.ofx");
    expect(result).toMatchObject({
      total: 1,
      inserted: 0,
      duplicated: 0,
      settled: 0,
      skipped: 0,
      reviewRequired: [expect.objectContaining({ reason: "REVIEW_REQUIRED" })],
    });
    expect(await readState()).toEqual(before);
  });

  it("CONTROL: a title-only legacy count (no seriesKey) is not sufficient proof of an independent purchase", async () => {
    // Contract: the title is user-mutable presentation text. It may veto a
    // release (see the contradictory control below) but can never be the only
    // evidence that releases an ambiguity. Without a valid seriesKey the
    // evidence is incomplete, so the import stays conservative.
    await setup.expense.update({
      where: { id: oldExpenseId },
      data: { seriesKey: null, titulo: "QA LOJA (3/10)" },
    });
    const before = await readState();
    const result = await commit(NEW_DOCUMENT, "new-1of3-title-only.ofx");
    expect(result).toMatchObject({
      total: 1,
      inserted: 0,
      duplicated: 0,
      settled: 0,
      skipped: 1,
    });
    expect(await readState()).toEqual(before);
  });

  it("CONTROL: a legacy row with only REMAINING quantidadeParcela is not full-count proof", async () => {
    // No seriesKey, no count in the title: quantidadeParcela=8 is the REMAINING
    // count, so a document with count 3 must not be treated as "different".
    await setup.expense.update({
      where: { id: oldExpenseId },
      data: { seriesKey: null, titulo: "QA LOJA" },
    });
    const before = await readState();
    const result = await commit(NEW_DOCUMENT, "new-1of3-legacy-remaining.ofx");
    expect(result).toMatchObject({
      total: 1,
      inserted: 0,
      duplicated: 0,
      settled: 0,
      skipped: 1,
    });
    expect(await readState()).toEqual(before);
  });

  it("CONTROL: contradictory explicit full counts on the old row stay ambiguous", async () => {
    // seriesKey says 10 and the title says 5: neither is trustworthy.
    await setup.expense.update({
      where: { id: oldExpenseId },
      data: { titulo: "QA LOJA (3/5)" },
    });
    const before = await readState();
    const result = await commit(NEW_DOCUMENT, "new-1of3-contradictory.ofx");
    expect(result).toMatchObject({
      total: 1,
      inserted: 0,
      duplicated: 0,
      settled: 0,
      skipped: 1,
    });
    expect(await readState()).toEqual(before);
  });

  it("CONTROL: a strong external identity in another project blocks a single line with a different count", async () => {
    const single = bankOfx(
      LAST4,
      ofxDebit("20260928120000", 7300, "QA LOJA UNICA", "strong-single-fit"),
    );
    const proposed = await preview(single, "single.ofx");
    const externalId = proposed.preview[0]?.externalId;
    expect(externalId).toEqual(expect.any(String));
    const foreign = await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: OTHER_PROJECT,
        tipoDespesa: "OUTROS",
        titulo: "Homonimo com identidade forte",
        valor: 7300,
        quantidade: 1,
        valorTotal: 7300,
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
        valor: 7300,
        tipo: "DESPESA",
        categoria: "OUTROS",
        data: new Date("2026-09-28T00:00:00.000Z"),
        status: "PLANEJADO",
        formaPagamento: "CARTAO_CREDITO",
      },
    });
    const before = await readState();
    const result = await commit(single, "single.ofx");
    expect(result).toMatchObject({ total: 1, inserted: 0, skipped: 1 });
    expect(await readState()).toEqual(before);
  });
});
