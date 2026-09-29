require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import {
  bankOfx,
  ofxDebit,
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { CreditCardService } from "./credit-card.service";

const TENANT = "qa-p01-independent-card-purchase";
const PROJECT = `${TENANT}-pessoal`;
const LAST4 = "0701";
const REQUESTER = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const OLD_DOCUMENT = bankOfx(
  LAST4,
  ofxDebit("20260105120000", 10000, "QA LOJA PARC 1/3", "old-purchase-fit-1"),
);

describe("#701 independent card purchase versus historical purchase barriers", () => {
  // Raw Prisma is used only for fixture setup and complete physical snapshots.
  // Every preview/commit uses the real service and its real soft-delete middleware.
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const cards = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  let cardId: string;
  let oldExpenseId: string;
  let oldExternalId: string;

  const commit = (
    document: Buffer,
    fileName: string,
    decisions?: Parameters<CreditCardService["commitImport"]>[8],
  ) =>
    cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      document,
      fileName,
      "OFX",
      undefined,
      undefined,
      decisions,
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

  const readOldPurchase = () =>
    setup.expense.findUniqueOrThrow({
      where: { id: oldExpenseId },
      include: { cashFlow: { orderBy: { parcela: "asc" } } },
    });

  const readFinancialState = async () => ({
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

  beforeAll(async () => {
    await setup.$connect();
    await prisma.$connect();
  });

  beforeEach(async () => {
    // Keep Prisma's asynchronous scheduling real; only the clock is frozen.
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
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: LAST4,
      closingDay: 27,
      dueDay: 5,
    }));

    const imported = await commit(OLD_DOCUMENT, "old-purchase.ofx");
    expect(imported).toMatchObject({
      inserted: 1,
      settled: 0,
      duplicated: 0,
      skipped: 0,
    });
    const old = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: imported.importId },
    });
    expect(old.seriesKey).toEqual(expect.any(String));
    expect(old.dedupeKeyStrong).toEqual(expect.any(String));
    if (!old.externalId)
      throw new Error("Imported fixture must have externalId");
    oldExpenseId = old.id;
    oldExternalId = old.externalId;

    // Historical payment is a fixture precondition, not a simulated invoice
    // payment workflow. Do not infer PAGO from importing the old statement.
    await setup.expense.update({
      where: { id: oldExpenseId },
      data: { status: "PAGO", paidParcelas: "[0,1,2]" },
    });
    await setup.cashFlowEntry.updateMany({
      where: { tenantId: TENANT, expenseId: oldExpenseId },
      data: { status: "PAGO" },
    });
    const paid = await readOldPurchase();
    expect(paid).toMatchObject({
      status: "PAGO",
      quantidadeParcela: 3,
      valorTotal: 30000,
      paidParcelas: "[0,1,2]",
    });
    expect(
      paid.cashFlow.map(({ parcela, valor, status }) => ({
        parcela,
        valor,
        status,
      })),
    ).toEqual([
      { parcela: "1/3", valor: 10000, status: "PAGO" },
      { parcela: "2/3", valor: 10000, status: "PAGO" },
      { parcela: "3/3", valor: 10000, status: "PAGO" },
    ]);
  });

  afterEach(async () => {
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

  it("imports a later independent single purchase from the same shop without skipping it or rewriting the paid series", async () => {
    const document = bankOfx(
      LAST4,
      ofxDebit("20260928120000", 7500, "QA LOJA", "independent-purchase-fit-2"),
    );
    expect(document.equals(OLD_DOCUMENT)).toBe(false);
    const before = await readOldPurchase();
    const proposed = await preview(document, "new-independent-purchase.ofx");
    expect(proposed.possibleDuplicates).toEqual([]);
    expect(proposed.duplicated).toBe(0);
    expect(proposed.preview).toHaveLength(1);
    expect(proposed.preview[0]).toMatchObject({
      amountCents: 7500,
      duplicate: false,
      willImport: true,
    });
    expect(proposed.preview[0]?.externalId).not.toBe(oldExternalId);

    // No natural-key candidate, so no UI opt-in is needed or fabricated.
    const result = await commit(document, "new-independent-purchase.ofx");
    expect(await readOldPurchase()).toEqual(before);
    expect(result).toMatchObject({
      total: 1,
      inserted: 1,
      duplicated: 0,
      settled: 0,
      skipped: 0,
      possibleDuplicates: [],
    });
    const created = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: result.importId },
      include: { cashFlow: true },
    });
    expect(created).toMatchObject({
      valor: 7500,
      valorTotal: 7500,
      formaPagamento: "A_VISTA",
      quantidadeParcela: null,
      status: "PLANEJADO",
      cardLast4: LAST4,
      accountId: null,
      seriesKey: null,
      dataCompra: new Date("2026-09-28T00:00:00.000Z"),
    });
    expect(created.externalId).not.toBe(oldExternalId);
    expect(created.dedupeKeyStrong).toEqual(expect.any(String));
    expect(created.dedupeKeyStrong).not.toBe(before.dedupeKeyStrong);
    expect(created.cashFlow).toHaveLength(1);
    expect(created.cashFlow[0]).toMatchObject({
      valor: 7500,
      status: "PLANEJADO",
      formaPagamento: "CARTAO_CREDITO",
      parcela: null,
    });
    const state = await readFinancialState();
    expect(state.expenses).toHaveLength(2);
    expect(state.expenses.reduce((sum, row) => sum + row.valorTotal, 0)).toBe(
      37500,
    );
    expect(state.expenses.flatMap((row) => row.cashFlow)).toHaveLength(4);
    expect(state.receipts).toEqual([]);
    expect(state.settlements).toEqual([]);
    expect(state.allocations).toEqual([]);
  });

  it("keeps the same purchase's later installment with a different FITID on the original paid series", async () => {
    const before = await readFinancialState();
    const document = bankOfx(
      LAST4,
      ofxDebit(
        "20260205120000",
        10000,
        "QA LOJA PARC 2/3",
        "same-purchase-fit-2",
      ),
    );
    const result = await commit(document, "later-installment.ofx");
    expect(result).toMatchObject({
      total: 1,
      inserted: 0,
      duplicated: 0,
      settled: 1,
      skipped: 0,
      possibleDuplicates: [],
    });
    // "settled" is the legacy import counter for a reused series, not permission
    // to change payment state or create another purchase.
    expect(await readFinancialState()).toEqual(before);
  });

  it("does not bypass a strong duplicate when reupload explicitly requests import", async () => {
    const before = await readFinancialState();
    const result = await commit(OLD_DOCUMENT, "renamed-old-purchase.ofx", [
      { externalId: oldExternalId, action: "import" },
    ]);
    expect(result).toMatchObject({
      total: 1,
      inserted: 0,
      duplicated: 1,
      settled: 0,
      skipped: 0,
      possibleDuplicates: [],
    });
    expect(result.duplicatedItems).toHaveLength(1);
    expect(result.duplicatedItems[0]).toMatchObject({
      externalId: oldExternalId,
      amountCents: 10000,
      reason: "duplicate",
    });
    expect(await readFinancialState()).toEqual(before);
  });

  it("does not treat another FITID and a one-cent change on the old installment cohort as proof of a new purchase", async () => {
    const before = await readFinancialState();
    // An invoice can repeat the original purchase date for installment 2/3.
    // This is not the distinct later A_VISTA purchase in the regression above.
    const document = bankOfx(
      LAST4,
      ofxDebit(
        "20260105120000",
        10001,
        "QA LOJA PARC 2/3",
        "changed-cent-fit-2",
      ),
    );
    const result = await commit(document, "old-cohort-changed-cent.ofx");
    expect(result).toMatchObject({
      total: 1,
      inserted: 0,
      duplicated: 0,
      settled: 0,
      skipped: 1,
      possibleDuplicates: [],
    });
    expect(await readFinancialState()).toEqual(before);
  });

  it("imports an incompatible installment purchase without adopting an older planned single purchase from the same shop", async () => {
    const unitaryDocument = bankOfx(
      LAST4,
      ofxDebit("20260110120000", 7777, "QA LOJA UNITARIA", "unitary-fit-1"),
    );
    const first = await commit(unitaryDocument, "old-single-purchase.ofx");
    expect(first).toMatchObject({ inserted: 1, skipped: 0, settled: 0 });
    const unitary = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: first.importId },
    });
    expect(unitary).toMatchObject({
      valorTotal: 7777,
      formaPagamento: "A_VISTA",
      quantidadeParcela: null,
      seriesKey: null,
      status: "PLANEJADO",
    });
    const before = await readFinancialState();

    // Same calendar date and a still-planned old purchase: admission must not
    // depend on PAGO or a date-distance shortcut.
    const document = bankOfx(
      LAST4,
      ofxDebit(
        "20260110120000",
        10001,
        "QA LOJA UNITARIA PARC 1/3",
        "independent-installment-fit-2",
      ),
    );
    const proposed = await preview(document, "new-installment-purchase.ofx");
    expect(proposed.possibleDuplicates).toEqual([]);
    expect(proposed.duplicated).toBe(0);
    expect(proposed.preview).toHaveLength(1);
    expect(proposed.preview[0]).toMatchObject({
      amountCents: 10001,
      duplicate: false,
      willImport: true,
    });

    const result = await commit(document, "new-installment-purchase.ofx");
    expect(result).toMatchObject({
      total: 1,
      inserted: 1,
      duplicated: 0,
      settled: 0,
      skipped: 0,
      possibleDuplicates: [],
    });
    const purchase = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: result.importId },
      include: { cashFlow: { orderBy: { parcela: "asc" } } },
    });
    expect(purchase).toMatchObject({
      valor: 30003,
      valorTotal: 30003,
      formaPagamento: "PARCELADO",
      quantidadeParcela: 3,
      status: "PLANEJADO",
      cardLast4: LAST4,
      accountId: null,
      seriesKey: expect.any(String),
    });
    expect(purchase.id).not.toBe(unitary.id);
    expect(
      purchase.cashFlow.map(({ parcela, valor, status }) => ({
        parcela,
        valor,
        status,
      })),
    ).toEqual([
      { parcela: "1/3", valor: 10001, status: "PLANEJADO" },
      { parcela: "2/3", valor: 10001, status: "PLANEJADO" },
      { parcela: "3/3", valor: 10001, status: "PLANEJADO" },
    ]);
    const after = await readFinancialState();
    expect({
      ...after,
      expenses: after.expenses.filter(({ id }) => id !== purchase.id),
    }).toEqual(before);
    expect(after.expenses).toHaveLength(3);
    expect(after.expenses.flatMap(({ cashFlow }) => cashFlow)).toHaveLength(7);
    expect(after.expenses.reduce((sum, row) => sum + row.valorTotal, 0)).toBe(
      67780,
    );
  });

  it("leaves an unrelated unowned card CFE untouched without freezing independent imports in the project", async () => {
    const orphan = await setup.cashFlowEntry.create({
      data: {
        id: `${TENANT}-unowned-card-cfe`,
        tenantId: TENANT,
        projectId: PROJECT,
        expenseId: null,
        receiptId: null,
        tipo: "DESPESA",
        categoria: "OUTROS",
        valor: 45678,
        data: new Date("2026-10-05T00:00:00.000Z"),
        status: "PLANEJADO",
        formaPagamento: "CARTAO_CREDITO",
        parcela: "4/5",
      },
    });
    const before = await readFinancialState();
    const entriesBefore = await setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    });
    const document = bankOfx(
      LAST4,
      ofxDebit("20260928120000", 8800, "QA OUTRA LOJA", "unrelated-fit-3"),
    );
    const proposed = await preview(document, "independent-with-orphan.ofx");
    expect(proposed.possibleDuplicates).toEqual([]);
    expect(proposed.duplicated).toBe(0);
    expect(proposed.preview).toHaveLength(1);
    expect(proposed.preview[0]).toMatchObject({
      amountCents: 8800,
      duplicate: false,
      willImport: true,
    });

    const result = await commit(document, "independent-with-orphan.ofx");
    expect(result).toMatchObject({
      total: 1,
      inserted: 1,
      skipped: 0,
      duplicated: 0,
      settled: 0,
      possibleDuplicates: [],
    });
    const purchase = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, importId: result.importId },
      include: { cashFlow: true },
    });
    expect(purchase).toMatchObject({
      valorTotal: 8800,
      formaPagamento: "A_VISTA",
      quantidadeParcela: null,
      seriesKey: null,
      status: "PLANEJADO",
    });
    expect(purchase.cashFlow).toHaveLength(1);
    expect(purchase.cashFlow[0]).toMatchObject({
      valor: 8800,
      expenseId: purchase.id,
      formaPagamento: "CARTAO_CREDITO",
      parcela: null,
      status: "PLANEJADO",
    });
    expect(
      await setup.cashFlowEntry.findUniqueOrThrow({ where: { id: orphan.id } }),
    ).toEqual(orphan);
    const entriesAfter = await setup.cashFlowEntry.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    });
    expect(entriesAfter).toHaveLength(5);
    expect(
      entriesAfter.filter(({ expenseId }) => expenseId !== purchase.id),
    ).toEqual(entriesBefore);
    const after = await readFinancialState();
    expect({
      ...after,
      expenses: after.expenses.filter(({ id }) => id !== purchase.id),
    }).toEqual(before);
  });
});
