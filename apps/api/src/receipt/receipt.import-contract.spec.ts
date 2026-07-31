import { BadRequestException } from "@nestjs/common";
import { validate } from "class-validator";
import { parseBankStatementBuffers } from "../bank-account/parsers";
import { parseStatementBuffers } from "../credit-card/parsers";
import { ReceiptController } from "./receipt.controller";
import { ImportReceiptQueryDto } from "./dto/import-receipt.dto";
import { ReceiptService } from "./receipt.service";

jest.mock("../bank-account/parsers", () => {
  class PdfPasswordRequiredError extends Error {}
  class PdfWrongPasswordError extends Error {}
  class ImageOcrError extends Error {}
  return {
    parseBankStatementBuffers: jest.fn(),
    PdfPasswordRequiredError,
    PdfWrongPasswordError,
    ImageOcrError,
  };
});
jest.mock("../credit-card/parsers", () => ({
  parseStatementBuffers: jest.fn(),
}));
jest.mock("../bank-account/bank-account.service", () => ({
  classifyCreditType: jest.fn(() => "OUTROS"),
}));

const bankParser = parseBankStatementBuffers as jest.Mock;
const cardParser = parseStatementBuffers as jest.Mock;
const date = new Date("2026-07-15T12:00:00.000Z");
const row = (
  externalId: string,
  amountCents: number,
  merchant = externalId,
) => ({ externalId, amountCents, merchant, date });
const parsed = (transactions: ReturnType<typeof row>[], source = "OFX") => ({
  source,
  periodLabel: "2026-07",
  totalAmountCents: transactions.reduce(
    (sum, item) => sum + item.amountCents,
    0,
  ),
  transactions,
  futureInstallments: [],
});

function harness() {
  const state = {
    expenses: [] as any[],
    receipts: [] as any[],
    cashFlows: [] as any[],
  };
  let sequence = 0;
  const visible = (rows: any[]) =>
    rows.filter((item) => item.deletedAt == null);
  const findMany = (rows: any[], { where }: any) => {
    const ids = where.externalId.in;
    return visible(rows)
      .filter((item) => ids.includes(item.externalId))
      .map(({ externalId }) => ({ externalId }));
  };
  const expenseCreate = jest.fn(async ({ data }: any) => {
    const created = {
      accountId: null,
      bankLast4: null,
      cardLast4: null,
      importId: null,
      linkedExpenseId: null,
      origin: "none",
      deletedAt: null,
      id: `expense-${++sequence}`,
      ...data,
    };
    state.expenses.push(created);
    return created;
  });
  const receiptCreate = jest.fn(async ({ data }: any) => {
    const created = {
      accountId: null,
      bankLast4: null,
      importId: null,
      linkedReceiptId: null,
      origin: "none",
      deletedAt: null,
      id: `receipt-${++sequence}`,
      ...data,
    };
    state.receipts.push(created);
    return created;
  });
  const cashFlowCreate = jest.fn(async ({ data }: any) => {
    const parent = data.expenseId
      ? state.expenses.find((item) => item.id === data.expenseId)
      : state.receipts.find((item) => item.id === data.receiptId);
    if (parent?.externalId === "fails-cashflow")
      throw new Error("cash flow failed");
    const created = { id: `cash-${++sequence}`, ...data };
    state.cashFlows.push(created);
    return created;
  });
  const tx: any = {
    expense: {
      create: expenseCreate,
      findMany: jest.fn((args) => findMany(state.expenses, args)),
      findFirst: jest.fn(
        ({ where }) =>
          visible(state.expenses).find(
            (item) => item.externalId === where.externalId,
          ) ?? null,
      ),
    },
    receipt: {
      create: receiptCreate,
      findMany: jest.fn((args) => findMany(state.receipts, args)),
      findFirst: jest.fn(
        ({ where }) =>
          visible(state.receipts).find(
            (item) => item.externalId === where.externalId,
          ) ?? null,
      ),
    },
    cashFlowEntry: { create: cashFlowCreate },
  };
  const prisma: any = {
    ...tx,
    project: {
      findFirst: jest.fn(async ({ where }) => ({
        id: where.id,
        tenantId: where.tenantId,
        type: "PESSOAL",
      })),
    },
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const rows = strings.join(" ").includes("receipts")
        ? state.receipts
        : state.expenses;
      return rows.map(({ externalId }) => ({
        external_id: externalId,
        externalId,
      }));
    }),
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => {
      const lengths = [
        state.expenses.length,
        state.receipts.length,
        state.cashFlows.length,
      ];
      try {
        return await callback(tx);
      } catch (error) {
        state.expenses.splice(lengths[0]);
        state.receipts.splice(lengths[1]);
        state.cashFlows.splice(lengths[2]);
        throw error;
      }
    }),
  };
  const classifier = { manualExpenseType: jest.fn().mockResolvedValue(null) };
  return {
    prisma,
    state,
    service: new ReceiptService(prisma, classifier as any),
  };
}

const commit = (
  service: ReceiptService,
  documentType: "bank" | "card",
  decisions?: unknown[],
) =>
  (service.commitImport as any)(
    "tenant-1",
    "project-1",
    [Buffer.from("same-file")],
    documentType,
    "AUTO",
    "2026-07",
    "secret",
    decisions,
    "user-1",
  );

describe("accountless import approved contract", () => {
  beforeEach(() => jest.clearAllMocks());

  it("validates required selectors and document-specific source vocabularies", async () => {
    const errors = (value: Record<string, unknown>) =>
      validate(Object.assign(new ImportReceiptQueryDto(), value));

    for (const source of ["AUTO", "OFX", "CSV_GENERIC", "PDF"]) {
      await expect(
        errors({ origin: "none", documentType: "bank", source }),
      ).resolves.toHaveLength(0);
    }
    for (const source of [
      "AUTO",
      "OFX",
      "CSV_NUBANK",
      "CSV_ITAU",
      "CSV_GENERIC",
      "PDF",
    ]) {
      await expect(
        errors({ origin: "none", documentType: "card", source }),
      ).resolves.toHaveLength(0);
    }
    await expect(errors({ documentType: "bank" })).resolves.not.toHaveLength(0);
    await expect(errors({ origin: "none" })).resolves.not.toHaveLength(0);
    await expect(
      errors({ origin: "account", documentType: "bank" }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({ origin: "none", documentType: "bank", source: "CSV_NUBANK" }),
    ).resolves.not.toHaveLength(0);
    await expect(
      errors({ origin: "none", documentType: "card", source: "XLSX" }),
    ).resolves.not.toHaveLength(0);
  });

  it("defaults to preview, slices to five files, and reports missing files", async () => {
    const service = {
      previewImport: jest.fn().mockResolvedValue({ mode: "preview" }),
      commitImport: jest.fn(),
    };
    const controller = new ReceiptController(service as any);
    const files = Array.from({ length: 6 }, (_, index) => ({
      buffer: Buffer.from(String(index)),
      originalname: `${index}.ofx`,
    })) as any;

    await expect(
      controller.importReceipts(
        "tenant-1",
        { id: "user-1" },
        "project-1",
        files,
        {
          origin: "none",
          documentType: "bank",
          source: "OFX",
          password: "secret",
        } as any,
      ),
    ).resolves.toEqual({ mode: "preview" });
    expect(service.previewImport).toHaveBeenCalledWith(
      "tenant-1",
      "project-1",
      files.slice(0, 5).map((file: any) => file.buffer),
      "bank",
      "OFX",
      "secret",
    );
    expect(service.commitImport).not.toHaveBeenCalled();

    await expect(
      controller.importReceipts(
        "tenant-1",
        { id: "user-1" },
        "project-1",
        undefined,
        { origin: "none", documentType: "bank" } as any,
      ),
    ).resolves.toEqual({ error: "arquivo ausente" });
    expect(service.previewImport).toHaveBeenCalledTimes(1);
  });

  it("parses decisions and forwards period/password/user; malformed JSON writes nothing", async () => {
    const service = {
      previewImport: jest.fn(),
      commitImport: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const controller = new ReceiptController(service as any);
    const files = [
      { buffer: Buffer.from("statement"), originalname: "card.csv" },
    ];
    const decisions = [
      { externalId: "A", action: "skip" },
      { externalId: "B", action: "create", overrides: { titulo: "Padaria" } },
    ];

    await (controller.importReceipts as any)(
      "tenant-1",
      { id: "user-1" },
      "project-1",
      files,
      {
        origin: "none",
        documentType: "card",
        mode: "commit",
        source: "CSV_NUBANK",
        periodLabel: "2026-07",
        password: "secret",
      },
      { decisions: JSON.stringify(decisions) },
    );
    expect(service.commitImport).toHaveBeenCalledWith(
      "tenant-1",
      "project-1",
      [Buffer.from("statement")],
      "card",
      "CSV_NUBANK",
      "2026-07",
      "secret",
      decisions,
      "user-1",
    );

    service.commitImport.mockClear();
    await expect(
      (controller.importReceipts as any)(
        "tenant-1",
        { id: "user-1" },
        "project-1",
        files,
        { origin: "none", documentType: "bank", mode: "commit" },
        { decisions: "{broken" },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.commitImport).not.toHaveBeenCalled();
  });

  it("previews typed outcomes read-only and uses a stable project/document seed", async () => {
    const { service, prisma, state } = harness();
    state.receipts.push({
      id: "receipt-0",
      externalId: "credit",
      deletedAt: null,
    });
    bankParser.mockResolvedValue(
      parsed([
        row("debit", 12_345, "Mercado"),
        row("credit", -50_000, "Salário"),
      ]),
    );
    const result = await service.previewImport(
      "tenant-1",
      "project-1",
      [Buffer.from("bank")],
      "bank",
      "OFX",
    );

    expect(result).toMatchObject({
      source: "OFX",
      periodLabel: "2026-07",
      total: 2,
      duplicated: 1,
      preview: [
        {
          externalId: "debit",
          date: "2026-07-15",
          merchant: "Mercado",
          amountCents: 12_345,
          type: "expense",
          status: "PAGO",
          duplicate: false,
          willImport: true,
        },
        {
          externalId: "credit",
          date: "2026-07-15",
          merchant: "Salário",
          amountCents: -50_000,
          type: "receipt",
          status: "EM_CAIXA",
          duplicate: true,
          willImport: false,
        },
      ],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.expense.create).not.toHaveBeenCalled();
    expect(prisma.receipt.create).not.toHaveBeenCalled();

    bankParser.mockResolvedValue(parsed([]));
    cardParser.mockResolvedValue(parsed([]));
    await service.previewImport(
      "tenant-1",
      "project-1",
      [Buffer.from("x")],
      "bank",
    );
    await service.previewImport(
      "tenant-1",
      "project-2",
      [Buffer.from("x")],
      "bank",
    );
    await service.previewImport(
      "tenant-1",
      "project-1",
      [Buffer.from("x")],
      "card",
    );
    const bankSeeds = bankParser.mock.calls.slice(-2).map((call) => call[1]);
    expect(bankSeeds[0]).not.toBe(bankSeeds[1]);
    expect(cardParser.mock.calls.at(-1)[1]).not.toBe(bankSeeds[0]);
  });

  it("commits bank debit/credit as atomic unlinked wallet rows and applies create/skip overrides", async () => {
    const { service, prisma, state } = harness();
    bankParser.mockResolvedValue(
      parsed([
        row("debit", 1_500, "Mercado"),
        row("credit", -75_000, "Salário"),
        row("skip-me", 900, "Ignorada"),
      ]),
    );
    const result = await commit(service, "bank", [
      {
        externalId: "debit",
        action: "create",
        overrides: {
          titulo: "Padaria",
          valorCents: 2_100,
          category: "ALIMENTACAO",
        },
      },
      { externalId: "skip-me", action: "skip" },
    ]);

    expect(result).toMatchObject({
      count: 2,
      expensesInserted: 1,
      receiptsInserted: 1,
      duplicated: 0,
      skipped: 1,
      failed: 0,
    });
    expect(state.expenses).toEqual([
      expect.objectContaining({
        createdByUserId: "user-1",
        externalId: "debit",
        titulo: "Padaria",
        tipoDespesa: "ALIMENTACAO",
        valor: 2_100,
        valorTotal: 2_100,
        status: "PAGO",
        origin: "none",
        accountId: null,
        bankLast4: null,
        cardLast4: null,
        importId: null,
        linkedExpenseId: null,
      }),
    ]);
    expect(state.receipts).toEqual([
      expect.objectContaining({
        externalId: "credit",
        descricao: "Salário",
        valor: 75_000,
        status: "EM_CAIXA",
        origin: "none",
        accountId: null,
        bankLast4: null,
        importId: null,
        linkedReceiptId: null,
      }),
    ]);
    expect(state.cashFlows).toEqual([
      expect.objectContaining({
        expenseId: state.expenses[0].id,
        valor: 2_100,
        tipo: "DESPESA",
        status: "PAGO",
      }),
      expect.objectContaining({
        receiptId: state.receipts[0].id,
        valor: 75_000,
        tipo: "RECEBIMENTO",
        status: "EM_CAIXA",
      }),
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("commits card purchase/refund and ignores textual invoice payment and zero", async () => {
    const { service, prisma, state } = harness();
    cardParser.mockResolvedValue(
      parsed([
        row("purchase", 12_345, "Mercado"),
        row("refund", -2_000, "Estorno mercado"),
        row("payment", -10_345, "PAGAMENTO EFETUADO"),
        row("zero", 0, "Linha zero"),
      ]),
    );
    const result = await commit(service, "card");

    expect(result).toMatchObject({
      count: 2,
      expensesInserted: 2,
      receiptsInserted: 0,
      duplicated: 0,
      skipped: 2,
      failed: 0,
    });
    expect(state.expenses).toEqual([
      expect.objectContaining({
        externalId: "purchase",
        valor: 12_345,
        valorTotal: 12_345,
        status: "PLANEJADO",
        dataPagamento: null,
        origin: "none",
        accountId: null,
        bankLast4: null,
        cardLast4: null,
        importId: null,
        linkedExpenseId: null,
      }),
      expect.objectContaining({
        externalId: "refund",
        valor: -2_000,
        valorTotal: -2_000,
        status: "PAGO",
        dataPagamento: date,
        origin: "none",
        accountId: null,
        bankLast4: null,
        cardLast4: null,
        importId: null,
        linkedExpenseId: null,
      }),
    ]);
    expect(
      state.cashFlows.map(({ valor, status, tipo }) => ({
        valor,
        status,
        tipo,
      })),
    ).toEqual([
      { valor: 12_345, status: "PLANEJADO", tipo: "DESPESA" },
      { valor: -2_000, status: "PAGO", tipo: "DESPESA" },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("deduplicates in-batch, on repeat after soft-delete, and across Expense/Receipt", async () => {
    const { service, state } = harness();
    bankParser.mockResolvedValue(
      parsed([row("same-id", 1_000), row("same-id", 1_000)]),
    );
    await expect(commit(service, "bank")).resolves.toMatchObject({
      count: 1,
      duplicated: 1,
    });
    expect(state.expenses).toHaveLength(1);

    state.expenses[0].deletedAt = new Date("2026-07-20T12:00:00.000Z");
    bankParser.mockResolvedValue(parsed([row("same-id", 1_000)]));
    await expect(commit(service, "bank")).resolves.toMatchObject({
      count: 0,
      duplicated: 1,
    });
    expect(state.expenses).toHaveLength(1);

    state.receipts.push({
      id: "soft-receipt",
      externalId: "receipt-id",
      deletedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    bankParser.mockResolvedValue(parsed([row("receipt-id", 2_000)]));
    await expect(commit(service, "bank")).resolves.toMatchObject({
      count: 0,
      duplicated: 1,
    });
    expect(state.expenses).toHaveLength(1);
  });

  it.each([
    { externalId: "A", action: "link" },
    { externalId: "A", action: "create", linkToExpenseId: "expense-elsewhere" },
    { externalId: "A", action: "create", linkToReceiptId: "receipt-elsewhere" },
    { externalId: "A", action: "create", overrides: { cardLast4: "1234" } },
  ])(
    "rejects wallet-incompatible decision %# before writes",
    async (decision) => {
      const { service, prisma } = harness();
      bankParser.mockResolvedValue(parsed([row("A", 1_000)]));

      await expect(commit(service, "bank", [decision])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.expense.create).not.toHaveBeenCalled();
      expect(prisma.receipt.create).not.toHaveBeenCalled();
    },
  );

  it("rolls back a failed parent/cashflow pair, counts it, and continues", async () => {
    const { service, state } = harness();
    bankParser.mockResolvedValue(
      parsed([row("fails-cashflow", 1_000), row("survives", 2_000)]),
    );

    await expect(commit(service, "bank")).resolves.toMatchObject({
      count: 1,
      expensesInserted: 1,
      receiptsInserted: 0,
      duplicated: 0,
      skipped: 0,
      failed: 1,
    });
    expect(state.expenses.map(({ externalId }) => externalId)).toEqual([
      "survives",
    ]);
    expect(state.cashFlows).toHaveLength(1);
    expect(state.cashFlows[0].expenseId).toBe(state.expenses[0].id);
  });
});
