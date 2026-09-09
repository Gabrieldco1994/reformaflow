// RED por ausência: depende do schema aditivo do PR 1 (degrau) — §3.3.1. NÃO aplicar migration nesta rodada (decisão do PO).
//
// PR: PR 1 (degrau) — trilha real + `flippedEntries` + `recordImportedLiquidations`
//     + carimbo. `applyRevertImportedLiquidations`/`prepareRevert…` são introduzidos
//     no PR 1 (sem caller); o caller `undoImport` via ledger é PR 2.
// #569 §6.1 — trilha de liquidação por importação (`ImportedInvoiceLiquidation` +
// `recordImportedLiquidations` / `applyRevertImportedLiquidations` + `flippedEntries`
// no retorno de `applyPreparedSettlement`). Nenhuma dessas peças existe em
// `origin/main@e66e49c1`; cada `it` executa o corpo real e estoura em runtime
// (`TypeError` de método/modelo ausente) OU falha a asserção do campo novo.
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  EXPECTED_TRAIL_VERSION,
  bankOfx,
  commitStatement,
  makeBankAccountService,
  makeSettlementService,
  ofxDebit,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
  seedSinglePurchase,
  seedStatementImport,
  readExpenseRaw,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const TENANT = "iul-ledger-tenant";
const PESSOAL = "iul-ledger-pessoal";
const CARD_LAST4 = "4001";
const BANK_LAST4 = "8001";
const REQUESTER = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.1 — card-invoice-settlement ledger (PR 1)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let settlement: ReturnType<typeof makeSettlementService>;
  let accountId: string;
  let card: { id: string; last4: string };

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    card = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: CARD_LAST4,
      closingDay: 20,
      dueDay: 1,
    });
    ({ id: accountId } = await seedBankAccount(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: BANK_LAST4,
    }));
    bank = makeBankAccountService(prisma);
    settlement = makeSettlementService(prisma);
  });

  beforeEach(async () => {
    // FK import_id → bank_statement_imports: garante os ids sintéticos usados abaixo
    for (const id of ["imp-x", "imp-y", "imp-1", "imp-2"]) {
      await seedStatementImport(setup, { tenantId: TENANT, accountId, id });
    }
  });

  afterEach(async () => {
    const anyDb = setup as unknown as { importedInvoiceLiquidation?: { deleteMany: (a: unknown) => Promise<unknown> } };
    if (anyDb.importedInvoiceLiquidation) {
      await anyDb.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
    }
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  const ledger = () =>
    (prisma as unknown as {
      importedInvoiceLiquidation: {
        findMany: (a: unknown) => Promise<Array<Record<string, unknown>>>;
      };
    }).importedInvoiceLiquidation;

  it('recordImportedLiquidations grava 1 linha por CashFlowEntry virada PLANEJADO→PAGO, com prev_status="PLANEJADO", entry_valor_cents e parcela do momento', async () => {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      parcelas: 3,
      valorCents: 10_000,
      primeiraData: new Date("2026-01-05T12:00:00.000Z"),
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 10_000,
      date: "20260201",
      period: "2026-02",
      requester: REQUESTER,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
    });
    expect(payment).not.toBeNull();

    const rows = await ledger().findMany({ where: { paymentExpenseId: payment!.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      paymentExpenseId: payment!.id,
      importId: commit.importId,
      purchaseExpenseId: purchase.id,
      cashFlowEntryId: purchase.entryIds[0],
      cardId: card.id,
      prevStatus: "PLANEJADO",
      entryValorCents: 10_000,
      parcela: "1/3",
      dueMonth: "2026-02",
      deletedAt: null,
    });
    const entry = await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } });
    expect(entry?.status).toBe("PAGO");
    // completude O(1): carimbo no pagamento
    const raw = await readExpenseRaw(setup, payment!.id);
    expect(raw?.invoiceUndoState).toBe("PROCESSED_SETTLED");
    expect(raw?.invoiceUndoParcelaCount).toBe(1);
    expect(raw?.invoiceUndoDueMonth).toBe("2026-02");
    expect(raw?.invoiceUndoCardId).toBe(card.id);
    expect(raw?.invoiceUndoTrailVersion).toBe(EXPECTED_TRAIL_VERSION);
  });

  it("estratégia 1 (vencimento): grava só as parcelas do dueMonth alvo; parcelas de outro ciclo do mesmo cartão ficam fora do ledger e PLANEJADO", async () => {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      parcelas: 3,
      valorCents: 10_000,
      primeiraData: new Date("2026-01-05T12:00:00.000Z"),
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 10_000,
      date: "20260201",
      period: "2026-02",
      requester: REQUESTER,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
    });
    const rows = await ledger().findMany({ where: { paymentExpenseId: payment!.id } });
    const claimedEntryIds = new Set(rows.map((r) => r.cashFlowEntryId));
    const otherEntries = purchase.entryIds.filter((id) => !claimedEntryIds.has(id));
    expect(otherEntries.length).toBeGreaterThan(0);
    for (const id of otherEntries) {
      const e = await setup.cashFlowEntry.findUnique({ where: { id } });
      expect(e?.status).toBe("PLANEJADO");
    }
  });

  it("estratégia 2 (fallback fatura importada): grava exatamente a parcela em aberto mais antiga de cada compra do import casado", async () => {
    const noCycleCard = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: "4099",
      closingDay: null,
      dueDay: null,
    });
    const p1 = await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: "4099",
      parcelas: 2,
      valorCents: 5_000,
      primeiraData: new Date("2026-03-05T12:00:00.000Z"),
    });
    const cardImport = await (setup as unknown as {
      creditCardStatementImport: { create: (a: unknown) => Promise<{ id: string }> };
    }).creditCardStatementImport.create({
      data: {
        tenantId: TENANT,
        cardId: noCycleCard.id,
        periodLabel: "2026-03",
        source: "OFX",
        totalAmountCents: 5_000,
      },
    });
    // estratégia 2 (fallback) só considera compras com Expense.importId == import.id.
    await setup.expense.update({ where: { id: p1.id }, data: { importId: cardImport.id } });
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: "4099",
      debitCents: 5_000,
      date: "20260320",
      period: "2026-03",
      requester: REQUESTER,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
    });
    const rows = await ledger().findMany({ where: { paymentExpenseId: payment!.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].parcela).toBe("1/2");
    expect(rows[0].purchaseExpenseId).toBe(p1.id);
    expect(cardImport.id).toBeTruthy();
  });

  it("diferença acima da tolerância na estratégia 1 (para MENOS e para MAIS) → outcome NO_SETTLEMENT, 0 linhas, carimbo PROCESSED_NONE, invoice_undo_card_id = id do cartão", async () => {
    for (const [label, debit] of [
      ["menos", 9_000],
      ["mais", 11_000],
    ] as const) {
      await seedInstallmentPurchase(setup, {
        tenantId: TENANT,
        projectId: PESSOAL,
        cardLast4: CARD_LAST4,
        parcelas: 1,
        valorCents: 10_000,
        primeiraData: new Date("2026-01-05T12:00:00.000Z"),
        titulo: `dif-${label}`,
      });
      const commit = await commitStatement(bank, {
        tenantId: TENANT,
        projectId: PESSOAL,
        accountId,
        bankLast4: BANK_LAST4,
        cardLast4: CARD_LAST4,
        debitCents: debit,
        date: "20260201",
        period: "2026-02",
        requester: REQUESTER,
        fitId: `dif-${label}`,
      });
      const payment = await setup.expense.findFirst({
        where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
      });
      const rows = await ledger().findMany({ where: { paymentExpenseId: payment!.id } });
      expect(rows).toHaveLength(0);
      const raw = await readExpenseRaw(setup, payment!.id);
      expect(raw?.invoiceUndoState).toBe("PROCESSED_NONE");
      expect(raw?.invoiceUndoCardId).toBe(card.id);
      await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
      await setup.expense.deleteMany({ where: { tenantId: TENANT } });
      await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
    }
  });

  it("fatura já toda paga → outcome NO_SETTLEMENT, 0 linhas, carimbo PROCESSED_NONE; nenhum rótulo persistido de motivo", async () => {
    await seedSinglePurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 10_000,
      data: new Date("2026-01-05T12:00:00.000Z"),
      status: "PAGO",
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 10_000,
      date: "20260201",
      period: "2026-02",
      requester: REQUESTER,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
    });
    const rows = await ledger().findMany({ where: { paymentExpenseId: payment!.id } });
    expect(rows).toHaveLength(0);
    const raw = await readExpenseRaw(setup, payment!.id);
    expect(raw?.invoiceUndoState).toBe("PROCESSED_NONE");
    expect(raw).not.toHaveProperty("invoiceUndoHint");
  });

  it("commit com matchedCard === null (M8): pagamento recebe carimbo PROCESSED_NONE, invoice_undo_card_id NULL, invoice_undo_parcela_count 0, 0 itens; getImportDetail NÃO o lê como legado (canUndo do lote não bloqueado por ele)", async () => {
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      debitCents: 12_345,
      date: "20260201",
      period: "2026-02",
      // memo classificado como pagamento de fatura mas SEM last4 (M8, #573)
      memo: "PAGTO CART CRED",
      requester: REQUESTER,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: { in: ["PAGAMENTO_FATURA_CARTAO", "PAGAMENTO_FATURA_SEM_CARTAO"] }, importId: commit.importId },
    });
    // precondição: o pagamento M8 (sem last4) FOI criado
    expect(payment).not.toBeNull();
    expect(payment!.cardLast4).toBeNull();
    const raw = await readExpenseRaw(setup, payment!.id);
    expect(raw).not.toBeNull();
    expect(raw!.invoiceUndoState).toBe("PROCESSED_NONE");
    expect(raw!.invoiceUndoCardId).toBeNull();
    expect(raw!.invoiceUndoParcelaCount).toBe(0);
    expect(await setup.importedInvoiceLiquidation.findMany({
      where: { paymentExpenseId: payment!.id },
    })).toEqual([]);
    const detail = (await (bank as unknown as {
      getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>>;
    }).getImportDetail(TENANT, PESSOAL, accountId, commit.importId, REQUESTER)) as Record<string, unknown>;
    expect(detail.canUndo).toBe(true);
  });

  it("índice único parcial: segundo recordImportedLiquidations na MESMA entry ativa → P2002", async () => {
    const { entryId, id: purchaseId } = await seedSinglePurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 7_000,
      data: new Date("2026-01-05T12:00:00.000Z"),
    });
    const payment = await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "pay",
        valor: 7_000,
        quantidade: 1,
        valorTotal: 7_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-02-01T12:00:00.000Z"),
        status: "PAGO",
        cardLast4: CARD_LAST4,
      },
    });
    const flipped = [
      {
        cashFlowEntryId: entryId,
        purchaseExpenseId: purchaseId,
        prevStatus: "PLANEJADO",
        valorCents: 7_000,
        parcela: null,
        dueMonth: "2026-02",
      },
    ];
    const svc = settlement as unknown as {
      recordImportedLiquidations: (client: unknown, args: unknown) => Promise<unknown>;
    };
    await prisma.$transaction(async (tx) => {
      await svc.recordImportedLiquidations(tx, {
        tenantId: TENANT,
        paymentExpenseId: payment.id,
        importId: "imp-x",
        cardId: card.id,
        flippedEntries: flipped,
      });
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await svc.recordImportedLiquidations(tx, {
          tenantId: TENANT,
          paymentExpenseId: payment.id,
          importId: "imp-y",
          cardId: card.id,
          flippedEntries: flipped,
        });
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("após soft-delete das linhas, a MESMA entry pode ser reivindicada de novo", async () => {
    const { entryId, id: purchaseId } = await seedSinglePurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 7_000,
      data: new Date("2026-01-05T12:00:00.000Z"),
    });
    const payment = await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "pay",
        valor: 7_000,
        quantidade: 1,
        valorTotal: 7_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-02-01T12:00:00.000Z"),
        status: "PAGO",
        cardLast4: CARD_LAST4,
      },
    });
    const flipped = [
      { cashFlowEntryId: entryId, purchaseExpenseId: purchaseId, prevStatus: "PLANEJADO", valorCents: 7_000, parcela: null, dueMonth: "2026-02" },
    ];
    const svc = settlement as unknown as {
      recordImportedLiquidations: (client: unknown, args: unknown) => Promise<unknown>;
    };
    await prisma.$transaction((tx) =>
      svc.recordImportedLiquidations(tx, { tenantId: TENANT, paymentExpenseId: payment.id, importId: "imp-1", cardId: card.id, flippedEntries: flipped }),
    );
    await (setup as unknown as { importedInvoiceLiquidation: { updateMany: (a: unknown) => Promise<unknown> } }).importedInvoiceLiquidation.updateMany({
      where: { cashFlowEntryId: entryId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await expect(
      prisma.$transaction((tx) =>
        svc.recordImportedLiquidations(tx, { tenantId: TENANT, paymentExpenseId: payment.id, importId: "imp-2", cardId: card.id, flippedEntries: flipped }),
      ),
    ).resolves.not.toThrow();
  });

  it("applyRevertImportedLiquidations restaura status→prev_status e recomputa paidParcelas/status da compra — parcelada (parcial) e à vista (total)", async () => {
    const parc = await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      parcelas: 3,
      valorCents: 10_000,
      primeiraData: new Date("2026-01-05T12:00:00.000Z"),
    });
    // vira a 1ª parcela PAGO fora da trilha para simular estado pós-commit
    await setup.cashFlowEntry.update({ where: { id: parc.entryIds[0] }, data: { status: "PAGO" } });
    const payment = await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "pay",
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-02-01T12:00:00.000Z"),
        status: "PAGO",
        cardLast4: CARD_LAST4,
      },
    });
    const svc = settlement as unknown as {
      recordImportedLiquidations: (client: unknown, args: unknown) => Promise<unknown>;
      applyRevertImportedLiquidations: (client: unknown, args: unknown) => Promise<unknown>;
    };
    await prisma.$transaction((tx) =>
      svc.recordImportedLiquidations(tx, {
        tenantId: TENANT,
        paymentExpenseId: payment.id,
        importId: "imp-1",
        cardId: card.id,
        flippedEntries: [
          { cashFlowEntryId: parc.entryIds[0], purchaseExpenseId: parc.id, prevStatus: "PLANEJADO", valorCents: 10_000, parcela: "1/3", dueMonth: "2026-02" },
        ],
      }),
    );
    await prisma.$transaction((tx) =>
      svc.applyRevertImportedLiquidations(tx, { tenantId: TENANT, paymentExpenseId: payment.id }),
    );
    const entry = await setup.cashFlowEntry.findUnique({ where: { id: parc.entryIds[0] } });
    expect(entry?.status).toBe("PLANEJADO");
    const purchase = await setup.expense.findUnique({ where: { id: parc.id } });
    expect(purchase?.status).toBe("PLANEJADO");
  });

  it("recordImportedLiquidations grava tenant_id; prepareRevert filtra por tenant_id — chamada sem tenantId não apaga linhas de outro tenant", async () => {
    const { entryId, id: purchaseId } = await seedSinglePurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 7_000,
      data: new Date("2026-01-05T12:00:00.000Z"),
    });
    const payment = await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "pay",
        valor: 7_000,
        quantidade: 1,
        valorTotal: 7_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-02-01T12:00:00.000Z"),
        status: "PAGO",
        cardLast4: CARD_LAST4,
      },
    });
    const svc = settlement as unknown as {
      recordImportedLiquidations: (client: unknown, args: unknown) => Promise<unknown>;
      prepareRevertImportedLiquidations: (client: unknown, args: unknown) => Promise<unknown[]>;
    };
    await prisma.$transaction((tx) =>
      svc.recordImportedLiquidations(tx, {
        tenantId: TENANT,
        paymentExpenseId: payment.id,
        importId: "imp-1",
        cardId: card.id,
        flippedEntries: [
          { cashFlowEntryId: entryId, purchaseExpenseId: purchaseId, prevStatus: "PLANEJADO", valorCents: 7_000, parcela: null, dueMonth: "2026-02" },
        ],
      }),
    );
    const rows = await ledger().findMany({ where: { paymentExpenseId: payment.id } });
    expect(rows[0].tenantId).toBe(TENANT);
    const revertOtherTenant = await prisma.$transaction((tx) =>
      svc.prepareRevertImportedLiquidations(tx, { tenantId: "outro-tenant", importId: "imp-1" }),
    );
    expect(revertOtherTenant).toHaveLength(0);
  });

  it("import real persiste exatamente 2 flips de valores distintos no mesmo ciclo; a entry já PAGO não entra no ledger nem no carimbo", async () => {
    // Ciclo único que fecha 20/03 e vence 2026-04: uma entry já PAGO (R$70),
    // duas PLANEJADO (R$110/R$130) e pagamento exato de R$310.
    const dia = new Date("2026-03-10T12:00:00.000Z");
    const jaPago = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD_LAST4, valorCents: 7_000,
      data: dia, status: "PAGO", titulo: "ja-pago", id: "ledger-ja-pago",
    });
    const p1 = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD_LAST4, valorCents: 11_000,
      data: dia, status: "PLANEJADO", titulo: "planejado-1", id: "ledger-planejado-1",
    });
    const p2 = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD_LAST4, valorCents: 13_000,
      data: dia, status: "PLANEJADO", titulo: "planejado-2", id: "ledger-planejado-2",
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 31_000,
      date: "20260401",
      period: "2026-04",
      fitId: "persist-two-distinct-flips",
      requester: REQUESTER,
    });
    const payment = await setup.expense.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        importId: commit.importId,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
      },
    });
    const persisted = await setup.importedInvoiceLiquidation.findMany({
      where: { paymentExpenseId: payment.id, deletedAt: null },
      orderBy: { cashFlowEntryId: "asc" },
    });
    const expectedRows = [
      { cashFlowEntryId: p1.entryId, purchaseExpenseId: p1.id, entryValorCents: 11_000 },
      { cashFlowEntryId: p2.entryId, purchaseExpenseId: p2.id, entryValorCents: 13_000 },
    ].sort((a, b) => a.cashFlowEntryId.localeCompare(b.cashFlowEntryId));
    expect(persisted.map((row) => ({
      cashFlowEntryId: row.cashFlowEntryId,
      purchaseExpenseId: row.purchaseExpenseId,
      entryValorCents: row.entryValorCents,
      prevStatus: row.prevStatus,
      dueMonth: row.dueMonth,
      paymentExpenseId: row.paymentExpenseId,
      importId: row.importId,
      cardId: row.cardId,
      parcela: row.parcela,
      deletedAt: row.deletedAt,
    }))).toEqual(expectedRows.map((row) => ({
      ...row,
      prevStatus: "PLANEJADO",
      dueMonth: "2026-04",
      paymentExpenseId: payment.id,
      importId: commit.importId,
      cardId: card.id,
      parcela: null,
      deletedAt: null,
    })));
    expect(persisted.map((row) => row.cashFlowEntryId)).not.toContain(jaPago.entryId);
    expect(await setup.cashFlowEntry.findMany({
      where: { id: { in: [jaPago.entryId, p1.entryId, p2.entryId] } },
      select: { id: true, status: true, valor: true },
      orderBy: { id: "asc" },
    })).toEqual([
      { id: jaPago.entryId, status: "PAGO", valor: 7_000 },
      { id: p1.entryId, status: "PAGO", valor: 11_000 },
      { id: p2.entryId, status: "PAGO", valor: 13_000 },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(payment).toMatchObject({
      invoiceUndoState: "PROCESSED_SETTLED",
      invoiceUndoParcelaCount: 2,
      invoiceUndoDueMonth: "2026-04",
      invoiceUndoCardId: card.id,
      invoiceUndoTrailVersion: EXPECTED_TRAIL_VERSION,
    });
  });
});
