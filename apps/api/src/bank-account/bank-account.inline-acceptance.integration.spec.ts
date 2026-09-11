// Load the disposable-worktree DB guard BEFORE importing any Prisma client.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { HttpException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { ACL_NOT_FOUND_MESSAGE } from "../common/access-rules";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import type { RateioRequester } from "../expense/rateio.types";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { PrismaService } from "../prisma/prisma.service";
import { BankAccountController } from "./bank-account.controller";
import {
  BankAccountService,
  type BankImportDecision,
} from "./bank-account.service";

/**
 * #689 / A690 — independent TDD acceptance, not a mock of the import algorithm.
 * Act uses the real controller/services + PrismaService middleware. Bare Prisma
 * is only for deterministic setup, inspection, subsequent edits and cleanup.
 * No production DB, HTTP provider, invented service method, or schema fallback.
 */
const ID = {
  tenant: "acceptance689-tenant",
  user: "acceptance689-user",
  source: "acceptance689-pessoal",
  target: "acceptance689-empty-reforma",
  hidden: "acceptance689-hidden",
  account: "acceptance689-bank",
  room: "acceptance689-room",
  existing: "acceptance689-existing",
  card: "acceptance689-card",
  purchase: "acceptance689-purchase",
};
const CLOCK = new Date("2026-09-11T15:00:00.000Z");
const DATE = new Date("2026-09-10T00:00:00.000Z");
const AMOUNT = 12345;
const requester: RateioRequester & { id: string } = {
  id: ID.user,
  role: "USER",
  allowedProjects: [ID.source, ID.target],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: [
    "bankAccounts",
    "expenses",
    "receipts",
    "creditCards",
    "monthlyOverview",
  ],
};
const targetDraft = {
  targetProjectId: ID.target,
  tipoDespesa: "MATERIAL_CONSTRUCAO",
  titulo: "Material da cozinha",
  fornecedor: "Loja QA",
};

function statement(invoice = false) {
  const row = (fitId: string, memo: string, amount: string) =>
    `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260910</DTPOSTED>` +
    `<TRNAMT>${amount}</TRNAMT><FITID>${fitId}</FITID><MEMO>${memo}</MEMO></STMTTRN>`;
  return Buffer.from(
    "OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>" +
      "<BANKACCTFROM><ACCTID>0689</ACCTID></BANKACCTFROM><BANKTRANLIST>" +
      // Invoice FIRST: an undo must not reverse this before checking inline drift.
      (invoice ? row("QA689-INVOICE", "PAGTO CART CRED 6890", "-50.00") : "") +
      row("QA689-DEBIT", "MATERIAL QA COZINHA", "-123.45") +
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
  );
}

async function rejectWith(
  run: () => Promise<unknown>,
  status: number,
  code?: string,
) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const error = caught as HttpException;
  expect(error.getStatus()).toBe(status);
  if (code) expect(JSON.stringify(error.getResponse())).toContain(code);
  return error.getResponse();
}

describe("#689 A690 — real import / account reader / detail / whole undo", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const settlement = new CardInvoiceSettlementService(prisma);
  const classifier = new MerchantClassifierService(prisma);
  const service = new BankAccountService(
    prisma,
    classifier,
    new ConciliacaoService(prisma),
    settlement,
  );
  const controller = new BankAccountController(service);
  const overview = new MonthlyOverviewService(prisma, settlement);
  const writes: string[] = [];
  const userReadsInTx: boolean[] = [];
  let targetWriteFailure: Error | null = null;

  // Passive observation: unlike an injected exception, this proves a rejected
  // mixed batch never ATTEMPTED a financial write (rollback alone is weaker).
  prisma.$use(async (params, next) => {
    if (/^(create|update|delete|upsert)/.test(params.action)) {
      writes.push(`${params.model}.${params.action}`);
    }
    if (params.model === "User" && /^find/.test(params.action)) {
      userReadsInTx.push(params.runInTransaction);
    }
    return next(params);
  });
  prisma.$use(async (params, next) => {
    if (
      targetWriteFailure &&
      params.model === "Expense" &&
      params.action === "create" &&
      params.args.data.projectId === ID.target
    )
      throw targetWriteFailure;
    return next(params);
  });

  async function cleanup() {
    const where = { tenantId: ID.tenant };
    await setup.importedInvoiceLiquidation.deleteMany({ where });
    await setup.rateioAllocation.deleteMany({ where });
    await setup.crossProjectSettlement.deleteMany({ where });
    await setup.cashFlowEntry.deleteMany({ where });
    await setup.expense.deleteMany({ where });
    await setup.receipt.deleteMany({ where });
    await setup.invoiceAdjustment.deleteMany({ where });
    await setup.bankStatementImport.deleteMany({ where });
    await setup.creditCardStatementImport.deleteMany({ where });
    await setup.creditCard.deleteMany({ where });
    await setup.bankAccount.deleteMany({ where });
    await setup.recurringBill.deleteMany({ where });
    await setup.merchantCategory.deleteMany({ where });
    await setup.room.deleteMany({
      where: { project: { tenantId: ID.tenant } },
    });
    await setup.project.deleteMany({ where });
    await setup.user.deleteMany({ where });
    await setup.tenant.deleteMany({ where: { id: ID.tenant } });
  }

  async function snapshot() {
    const args = {
      where: { tenantId: ID.tenant },
      orderBy: { id: "asc" as const },
    };
    return {
      expenses: await setup.expense.findMany(args),
      receipts: await setup.receipt.findMany(args),
      cash: await setup.cashFlowEntry.findMany(args),
      allocations: await setup.rateioAllocation.findMany(args),
      settlements: await setup.crossProjectSettlement.findMany(args),
      ledger: await setup.importedInvoiceLiquidation.findMany(args),
      imports: await setup.bankStatementImport.findMany(args),
      adjustments: await setup.invoiceAdjustment.findMany(args),
      recurring: await setup.recurringBill.findMany(args),
      rules: await setup.merchantCategory.findMany(args),
      accounts: await setup.bankAccount.findMany(args),
      cards: await setup.creditCard.findMany(args),
    };
  }

  function preview(buffer = statement()) {
    return service.previewImport(
      ID.tenant,
      ID.source,
      ID.account,
      buffer,
      "qa689.ofx",
      "OFX",
      undefined,
      requester,
    );
  }

  function commit(
    decisions: Array<BankImportDecision & { newTarget?: typeof targetDraft }>,
    buffer = statement(),
  ) {
    return service.commitImport(
      ID.tenant,
      ID.source,
      ID.account,
      buffer,
      "qa689.ofx",
      "OFX",
      undefined,
      undefined,
      decisions,
      ID.user,
      requester,
    );
  }

  function multipart(decisions: unknown) {
    const buffer = statement();
    const file = {
      fieldname: "files",
      originalname: "qa689.ofx",
      encoding: "7bit",
      mimetype: "application/x-ofx",
      size: buffer.length,
      buffer,
      destination: "",
      filename: "",
      path: "",
      stream: undefined as never,
    };
    return controller.importStatement(
      ID.tenant,
      requester,
      ID.source,
      ID.account,
      [file],
      { mode: "commit", source: "OFX" },
      { decisions: JSON.stringify(decisions) },
    );
  }

  function detail(importId: string, actor = requester) {
    return service.getImportDetail(
      ID.tenant,
      ID.source,
      ID.account,
      importId,
      actor,
    );
  }

  function undo(importId: string, actor = requester) {
    return service.undoImport(
      ID.tenant,
      ID.source,
      ID.account,
      importId,
      actor,
    );
  }

  async function draft(buffer = statement()) {
    const result = await preview(buffer);
    const row = result.preview.find(
      (item) => item.merchant === "MATERIAL QA COZINHA",
    );
    expect(row).toBeDefined();
    return {
      externalId: row!.externalId,
      action: "create" as const,
      newTarget: { ...targetDraft },
    };
  }

  async function committedPair(buffer = statement()) {
    const result = await commit([await draft(buffer)], buffer);
    const expenses = await setup.expense.findMany({
      where: {
        tenantId: ID.tenant,
        deletedAt: null,
        tipoDespesa: { not: "PAGAMENTO_FATURA_CARTAO" },
      },
    });
    const source = expenses.find(
      (expense) => expense.importId === result.importId,
    );
    const target = expenses.find((expense) => expense.projectId === ID.target);
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    return { result, source: source!, target: target! };
  }

  async function seedInvoice() {
    await setup.creditCard.create({
      data: {
        id: ID.card,
        tenantId: ID.tenant,
        projectId: ID.source,
        institution: "NUBANK",
        nickname: "Cartão QA",
        last4: "6890",
        closingDay: 5,
        dueDay: 10,
      },
    });
    await setup.expense.create({
      data: {
        id: ID.purchase,
        tenantId: ID.tenant,
        projectId: ID.source,
        titulo: "Compra anterior no cartão",
        tipoDespesa: "OUTROS",
        valor: 5000,
        quantidade: 1,
        valorTotal: 5000,
        formaPagamento: "CARTAO_CREDITO",
        cardLast4: "6890",
        dataPagamento: DATE,
        dataCompra: new Date("2026-08-20T00:00:00.000Z"),
        status: "PLANEJADO",
      },
    });
    await setup.cashFlowEntry.create({
      data: {
        tenantId: ID.tenant,
        projectId: ID.source,
        expenseId: ID.purchase,
        valor: 5000,
        tipo: "DESPESA",
        categoria: "OUTROS",
        formaPagamento: "CARTAO_CREDITO",
        status: "PLANEJADO",
        data: DATE,
        parcela: "1/1",
      },
    });
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "setInterval",
        "setTimeout",
      ],
    });
    jest.setSystemTime(CLOCK);
    // Only the external classifier is disabled; all financial algorithms run.
    Reflect.set(classifier, "apiKey", "");
    await setup.$connect();
    await prisma.onModuleInit();
  });

  beforeEach(async () => {
    targetWriteFailure = null;
    await cleanup();
    await setup.tenant.create({
      data: { id: ID.tenant, name: "Acceptance 689" },
    });
    await setup.project.createMany({
      data: [
        {
          id: ID.source,
          tenantId: ID.tenant,
          name: "Pessoal QA",
          type: "PESSOAL",
        },
        {
          id: ID.target,
          tenantId: ID.tenant,
          name: "Reforma vazia QA",
          type: "REFORMA",
        },
        {
          id: ID.hidden,
          tenantId: ID.tenant,
          name: "Hidden sentinel 689",
          type: "REFORMA",
        },
      ],
    });
    await setup.user.create({
      data: {
        id: ID.user,
        tenantId: ID.tenant,
        username: "acceptance689",
        name: "QA 689",
        role: "USER",
        allowedProjects: JSON.stringify(requester.allowedProjects),
        allowedProjectTypes: JSON.stringify(requester.allowedProjectTypes),
        allowedModules: JSON.stringify(requester.allowedModules),
      },
    });
    await setup.bankAccount.create({
      data: {
        id: ID.account,
        tenantId: ID.tenant,
        projectId: ID.source,
        institution: "NUBANK",
        nickname: "Conta QA",
        last4: "0689",
        openingBalanceCents: 50000,
        openingBalanceDate: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setup.room.create({
      data: { id: ID.room, projectId: ID.target, name: "Cozinha" },
    });
    writes.length = 0;
    userReadsInTx.length = 0;
  });

  afterAll(async () => {
    await cleanup();
    await setup.$disconnect();
    await prisma.onModuleDestroy();
    jest.useRealTimers();
  });

  it("discovers an empty authorized destination; preparing/discarding a draft changes no data", async () => {
    const before = await snapshot();
    const result = await preview();
    expect(result).toMatchObject({
      inlineTargetProjects: [
        { id: ID.target, name: "Reforma vazia QA", type: "REFORMA" },
      ],
      totalAmountCents: AMOUNT,
      totalDebits: 1,
      totalCredits: 0,
      preview: [
        {
          amountCents: AMOUNT,
          inlineTargetEligible: true,
          crossProjectMatches: [],
        },
      ],
    });
    await draft(); // Draft discarded by the caller: no commit/create endpoint.
    expect(await snapshot()).toEqual(before);
    expect(writes).toEqual([]);
  });

  it("12345: one source, one target, one allocation, ONE cash impact; intact undo is idempotent", async () => {
    const before = await overview.getAccountView(
      ID.tenant,
      ID.source,
      "2026-09",
      requester,
    );
    const { result, source, target } = await committedPair();
    const inlineExpenses = [
      {
        sourceExpenseId: source.id,
        targetExpenseId: target.id,
        targetProjectId: ID.target,
        amountCents: AMOUNT,
      },
    ];
    expect(result).toMatchObject({
      inserted: 1,
      total: 1,
      totalAmountCents: AMOUNT,
      receiptsInserted: 0,
      cardPayments: 0,
      skipped: 0,
      duplicated: 0,
      inlineExpenses,
    });
    expect(result).not.toHaveProperty("inlineExpenseCreations");
    expect(
      await setup.expense.count({
        where: { tenantId: ID.tenant, deletedAt: null },
      }),
    ).toBe(2);
    expect(source).toMatchObject({
      projectId: ID.source,
      status: "PAGO",
      valor: AMOUNT,
      quantidade: 1,
      valorTotal: AMOUNT,
      bankLast4: "0689",
      importId: result.importId,
    });
    expect(target).toMatchObject({
      projectId: ID.target,
      tipoDespesa: targetDraft.tipoDespesa,
      titulo: targetDraft.titulo,
      fornecedor: targetDraft.fornecedor,
      status: "PAGO",
      valor: AMOUNT,
      quantidade: 1,
      valorTotal: AMOUNT,
      dataPagamento: source.dataPagamento,
      bankLast4: null,
      accountId: null,
      cardLast4: null,
      importId: null,
      externalId: null,
      origin: "none",
    });
    expect(
      await setup.rateioAllocation.findMany({ where: { tenantId: ID.tenant } }),
    ).toEqual([
      expect.objectContaining({
        sourceExpenseId: source.id,
        targetExpenseId: target.id,
        allocation: AMOUNT,
      }),
    ]);
    const after = await overview.getAccountView(
      ID.tenant,
      ID.source,
      "2026-09",
      requester,
    );
    expect(after.caixaHoje - before.caixaHoje).toBe(-AMOUNT);
    expect(after.saiuMes - before.saiuMes).toBe(AMOUNT);
    expect(after.saidaTotal - before.saidaTotal).toBe(AMOUNT);
    expect(after.carteiraHoje).toBe(before.carteiraHoje);
    expect(
      after.saidas.filter((row) => row.isIncludedInSaidaTotal !== false),
    ).toHaveLength(1);
    expect(await detail(result.importId)).toMatchObject({
      canUndo: true,
      blockReason: null,
      inlineExpenses,
    });
    expect(await detail(result.importId)).not.toHaveProperty(
      "inlineExpenseCreations",
    );
    const flows = await setup.cashFlowEntry.findMany({
      where: { tenantId: ID.tenant, deletedAt: null },
    });
    expect(flows.map((flow) => flow.expenseId).sort()).toEqual(
      [source.id, target.id].sort(),
    );
    expect(flows.map((flow) => flow.valor)).toEqual([AMOUNT, AMOUNT]);
    expect(await undo(result.importId)).toMatchObject({
      ok: true,
      alreadyUndone: false,
    });
    for (const id of [source.id, target.id]) {
      expect(await prisma.expense.findFirst({ where: { id } })).toBeNull();
      expect(await setup.expense.findUnique({ where: { id } })).toMatchObject({
        deletedAt: CLOCK,
      });
    }
    for (const flow of flows) {
      expect(
        await setup.cashFlowEntry.findUnique({ where: { id: flow.id } }),
      ).toMatchObject({ deletedAt: CLOCK });
    }
    expect(
      await setup.rateioAllocation.count({ where: { tenantId: ID.tenant } }),
    ).toBe(0);
    const undone = await snapshot();
    writes.length = 0;
    expect(await undo(result.importId)).toMatchObject({
      ok: true,
      alreadyUndone: true,
      removedExpenses: 0,
      removedReceipts: 0,
      revertedSettlements: 0,
      revertedInvoiceParcelas: 0,
      reopenedInvoices: 0,
    });
    expect(await snapshot()).toEqual(undone);
    expect(writes).toEqual([]);
    const restored = await overview.getAccountView(
      ID.tenant,
      ID.source,
      "2026-09",
      requester,
    );
    expect(restored).toMatchObject({
      caixaHoje: before.caixaHoje,
      saiuMes: before.saiuMes,
      saidaTotal: before.saidaTotal,
      carteiraHoje: before.carteiraHoje,
    });
    expect(userReadsInTx).toContain(true);
  });

  it("legacy association undo never deletes a pre-existing target", async () => {
    await setup.expense.create({
      data: {
        id: ID.existing,
        tenantId: ID.tenant,
        projectId: ID.target,
        titulo: "Despesa preexistente",
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: AMOUNT,
        quantidade: 1,
        valorTotal: AMOUNT,
        formaPagamento: "A_VISTA",
        dataPagamento: DATE,
        status: "PLANEJADO",
      },
    });
    const decision = await draft();
    const result = await commit([
      {
        externalId: decision.externalId,
        action: "link",
        linkToExpenseId: ID.existing,
      },
    ]);
    expect(result.linked).toBe(1);
    expect(
      await setup.expense.findUnique({ where: { id: ID.existing } }),
    ).toMatchObject({ status: "PAGO" });
    await undo(result.importId);
    expect(
      await prisma.expense.findFirst({ where: { id: ID.existing } }),
    ).toMatchObject({
      status: "PLANEJADO",
      deletedAt: null,
      valor: AMOUNT,
      quantidade: 1,
      valorTotal: AMOUNT,
      titulo: "Despesa preexistente",
      projectId: ID.target,
    });
  });

  it.each<[string, Prisma.ExpenseUpdateInput]>([
    ["title", { titulo: "Edited after import" }],
    ["value", { valor: AMOUNT + 1, valorTotal: AMOUNT + 1 }],
    ["product link", { link: "https://example.test/changed-product" }],
    [
      "cross-project link",
      { linkedExpenseId: "acceptance689-subsequent-link" },
    ],
    ["room", { room: { connect: { id: ID.room } } }],
  ])(
    "later target %s edit blocks WHOLE undo with zero attempts",
    async (_name, data) => {
      const { result, target } = await committedPair();
      await setup.expense.update({ where: { id: target.id }, data });
      const before = await snapshot();
      writes.length = 0;
      expect(await detail(result.importId)).toMatchObject({
        canUndo: false,
        blockReason: "INLINE_IMPORT_DRIFT",
      });
      await rejectWith(() => undo(result.importId), 409, "INLINE_IMPORT_DRIFT");
      expect(writes).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("allocation drift cannot become permission to delete an owned destination", async () => {
    const { result, source } = await committedPair();
    await setup.rateioAllocation.updateMany({
      where: { sourceExpenseId: source.id },
      data: { allocation: AMOUNT - 1 },
    });
    const before = await snapshot();
    writes.length = 0;
    expect(await detail(result.importId)).toMatchObject({
      canUndo: false,
      blockReason: "INLINE_IMPORT_DRIFT",
    });
    await rejectWith(() => undo(result.importId), 409, "INLINE_IMPORT_DRIFT");
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("later cash-flow dependency changes block undo without restoring or deleting anything", async () => {
    const { result, target } = await committedPair();
    const changed = await setup.cashFlowEntry.updateMany({
      where: { tenantId: ID.tenant, expenseId: target.id, deletedAt: null },
      data: { status: "PLANEJADO" },
    });
    expect(changed.count).toBe(1);
    const before = await snapshot();
    writes.length = 0;
    expect(await detail(result.importId)).toMatchObject({
      canUndo: false,
      blockReason: "INLINE_IMPORT_DRIFT",
    });
    await rejectWith(() => undo(result.importId), 409, "INLINE_IMPORT_DRIFT");
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["{", "{}", '{"version":999}', '{"version":1}'])(
    "corrupt/incomplete provenance %s is never treated as legacy null",
    async (inlineExpenseCreations) => {
      const { result } = await committedPair();
      // Structural typing keeps this RED executable before the new schema is
      // generated; no raw SQL or fallback substitutes for the approved field.
      const data = { periodLabel: "2026-09", inlineExpenseCreations };
      await setup.bankStatementImport.update({
        where: { id: result.importId },
        data,
      });
      const before = await snapshot();
      writes.length = 0;
      expect(await detail(result.importId)).toMatchObject({ canUndo: false });
      await rejectWith(() => undo(result.importId), 409);
      expect(writes).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("hidden participant yields the canonical generic 404 before any detail/undo aggregates", async () => {
    const { result, target } = await committedPair();
    // ACL must win even when there is also drift.
    await setup.expense.update({
      where: { id: target.id },
      data: { titulo: "Hidden edit sentinel" },
    });
    await setup.user.update({
      where: { id: ID.user },
      data: { allowedProjects: JSON.stringify([ID.source]) },
    });
    const restricted = { ...requester, allowedProjects: [ID.source] };
    const before = await snapshot();
    writes.length = 0;
    const expected = {
      statusCode: 404,
      error: "Not Found",
      message: ACL_NOT_FOUND_MESSAGE,
    };
    expect(
      await rejectWith(() => detail(result.importId, restricted), 404),
    ).toEqual(expected);
    expect(
      await rejectWith(() => undo(result.importId, restricted), 404),
    ).toEqual(expected);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("current DB grants, not stale requester grants, authorize inline commit INSIDE the TX", async () => {
    const decision = await draft();
    await setup.user.update({
      where: { id: ID.user },
      data: { allowedProjects: JSON.stringify([ID.source]) },
    });
    const before = await snapshot();
    writes.length = 0;
    userReadsInTx.length = 0;
    expect(await rejectWith(() => commit([decision]), 404)).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: ACL_NOT_FOUND_MESSAGE,
    });
    expect(userReadsInTx).toContain(true);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("stale requester grants cannot authorize undo after the current user loses the target", async () => {
    const { result } = await committedPair();
    await setup.user.update({
      where: { id: ID.user },
      data: { allowedProjects: JSON.stringify([ID.source]) },
    });
    const before = await snapshot();
    writes.length = 0;
    userReadsInTx.length = 0;
    expect(await rejectWith(() => undo(result.importId), 404)).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: ACL_NOT_FOUND_MESSAGE,
    });
    expect(userReadsInTx).toContain(true);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { generatedByImport: true },
    { targetExpenseId: ID.existing },
    { inlineExpenseCreations: { version: 1 } },
  ])(
    "multipart rejects forged decision fields %j instead of silently creating ordinary expenses",
    async (forgery) => {
      const decision = await draft();
      const before = await snapshot();
      writes.length = 0;
      await rejectWith(
        () => multipart([{ ...decision, ...forgery }]),
        400,
        "INLINE_TARGET_INVALID",
      );
      expect(writes).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([null, {}, "not-an-array"])(
    "multipart non-array %j cannot silently become a default import",
    async (value) => {
      const before = await snapshot();
      await rejectWith(() => multipart(value), 400);
      expect(writes).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    { targetExpenseId: ID.existing },
    { valor: 1 },
    { quantidade: 2 },
    { accountId: ID.account },
    { generatedByImport: true },
  ])(
    "newTarget rejects client-owned financial/provenance fields %j",
    async (forgery) => {
      const decision = await draft();
      const before = await snapshot();
      writes.length = 0;
      await rejectWith(
        () =>
          multipart([
            {
              ...decision,
              newTarget: { ...decision.newTarget, ...forgery },
            },
          ]),
        400,
        "INLINE_TARGET_INVALID",
      );
      expect(writes).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("newTarget plus an existing link is invalid, not a silently chosen alternative", async () => {
    const decision = await draft();
    const before = await snapshot();
    writes.length = 0;
    await rejectWith(
      () =>
        multipart([
          {
            ...decision,
            action: "link",
            linkToExpenseId: ID.existing,
          },
        ]),
      400,
      "INLINE_TARGET_INVALID",
    );
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["MOVIMENTACAO_INTERNA", "INVESTIMENTOS", "PAGAMENTO_FATURA_CARTAO"])(
    "effective category %s invalidates a previously eligible inline draft",
    async (category) => {
      const decision = await draft();
      const before = await snapshot();
      writes.length = 0;
      await rejectWith(
        () =>
          commit([
            {
              ...decision,
              overrides: { category, transferToAccountId: null },
            },
          ]),
        400,
        "INLINE_TARGET_INVALID",
      );
      expect(writes).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("a hidden target is indistinguishable from a missing target, with no writes", async () => {
    const decision = await draft();
    const before = await snapshot();
    writes.length = 0;
    const expected = {
      statusCode: 404,
      error: "Not Found",
      message: ACL_NOT_FOUND_MESSAGE,
    };
    for (const targetProjectId of [ID.hidden, "acceptance689-missing"]) {
      const body = await rejectWith(
        () =>
          commit([
            {
              ...decision,
              newTarget: { ...decision.newTarget, targetProjectId },
            },
          ]),
        404,
      );
      expect(body).toEqual(expected);
    }
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("forced Tier B is import-only: never a newTarget escape hatch", async () => {
    const decision = await draft();
    await commit([{ externalId: decision.externalId, action: "create" }]);
    const differentFile = Buffer.from(
      statement().toString().replace("QA689-DEBIT", "QA689-OTHER-FITID"),
    );
    const second = await preview(differentFile);
    expect(second.preview[0]).toMatchObject({
      duplicate: false,
      willImport: false,
    });
    expect(second.preview[0].possibleDuplicate).toMatchObject({
      reason: "same_natural_key_different_source",
    });
    const before = await snapshot();
    writes.length = 0;
    await rejectWith(
      () =>
        commit(
          [
            {
              externalId: second.preview[0].externalId,
              action: "import",
              newTarget: targetDraft,
            },
          ],
          differentFile,
        ),
      400,
      "INLINE_TARGET_INVALID",
    );
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
    const forced = await commit(
      [{ externalId: second.preview[0].externalId, action: "import" }],
      differentFile,
    );
    expect(forced.inserted).toBe(1);
    expect(
      await setup.expense.count({
        where: { tenantId: ID.tenant, projectId: ID.target },
      }),
    ).toBe(0);
  });

  it("server derives the full effective amount after a valid source override, never 100× or half", async () => {
    const decision = await draft();
    await commit([{ ...decision, overrides: { valorCents: 23456 } }]);
    const expenses = await setup.expense.findMany({
      where: { tenantId: ID.tenant },
    });
    expect(expenses).toHaveLength(2);
    expect(
      expenses.map(({ valor, quantidade, valorTotal }) => ({
        valor,
        quantidade,
        valorTotal,
      })),
    ).toEqual([
      { valor: 23456, quantidade: 1, valorTotal: 23456 },
      { valor: 23456, quantidade: 1, valorTotal: 23456 },
    ]);
    expect(
      await setup.rateioAllocation.findMany({ where: { tenantId: ID.tenant } }),
    ).toEqual([expect.objectContaining({ allocation: 23456 })]);
  });

  it("unexpected inline core failure propagates and rolls back every row instead of partial success", async () => {
    const decision = await draft();
    const before = await snapshot();
    const failure = new Error("QA689 core write fault");
    targetWriteFailure = failure;
    try {
      await expect(commit([decision])).rejects.toBe(failure);
    } finally {
      targetWriteFailure = null;
    }
    expect(writes).toContain("Expense.create");
    expect(await snapshot()).toEqual(before);
  });

  it("mixed invoice + invalid inline target attempts ZERO core writes, including invoice settlement", async () => {
    await seedInvoice();
    const buffer = statement(true);
    const decision = await draft(buffer);
    decision.newTarget.tipoDespesa = "NOT_A_CATEGORY";
    const before = await snapshot();
    writes.length = 0;
    await rejectWith(
      () => commit([decision], buffer),
      400,
      "INLINE_TARGET_INVALID",
    );
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("mixed SETTLED invoice + edited inline target preflights all participants before ANY undo write", async () => {
    await seedInvoice();
    const buffer = statement(true);
    const result = await commit([await draft(buffer)], buffer);
    // Non-vacuous PR688 lock: this fixture must really have settled the invoice.
    expect(result.cardPayments).toBe(1);
    expect(
      await setup.importedInvoiceLiquidation.count({
        where: {
          tenantId: ID.tenant,
          importId: result.importId,
          deletedAt: null,
        },
      }),
    ).toBe(1);
    const target = await setup.expense.findFirst({
      where: { tenantId: ID.tenant, projectId: ID.target },
    });
    expect(target).not.toBeNull();
    await setup.expense.update({
      where: { id: target!.id },
      data: { titulo: "Keep my subsequent work" },
    });
    const before = await snapshot();
    writes.length = 0;
    expect(await detail(result.importId)).toMatchObject({
      canUndo: false,
      blockReason: "INLINE_IMPORT_DRIFT",
    });
    await rejectWith(() => undo(result.importId), 409, "INLINE_IMPORT_DRIFT");
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("skip and strong duplicate never create destinations; an ordinary import remains import-only", async () => {
    const decision = await draft();
    const skipped = await commit([{ ...decision, action: "skip" }]);
    expect(skipped).toMatchObject({ inserted: 0, skipped: 1 });
    expect(await setup.expense.count({ where: { tenantId: ID.tenant } })).toBe(
      0,
    );
    const ordinary = await commit([
      { externalId: decision.externalId, action: "create" },
    ]);
    expect(ordinary).toMatchObject({ inserted: 1, totalAmountCents: AMOUNT });
    const duplicated = await commit([decision]);
    expect(duplicated).toMatchObject({ inserted: 0, duplicated: 1 });
    expect(await setup.expense.count({ where: { tenantId: ID.tenant } })).toBe(
      1,
    );
    expect(
      await setup.expense.count({
        where: { tenantId: ID.tenant, projectId: ID.target },
      }),
    ).toBe(0);
    expect(
      await setup.rateioAllocation.count({ where: { tenantId: ID.tenant } }),
    ).toBe(0);
  });
});
