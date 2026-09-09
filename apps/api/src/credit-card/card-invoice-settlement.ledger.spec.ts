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
  ADMIN_REQUESTER,
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
  readExpenseRaw,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const TENANT = "iul-ledger-tenant";
const PESSOAL = "iul-ledger-pessoal";
const CARD_LAST4 = "4001";
const BANK_LAST4 = "8001";
const REQUESTER = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.1 — card-invoice-settlement ledger (RED)", () => {
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

  afterEach(async () => {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
    const anyDb = setup as unknown as { importedInvoiceLiquidation?: { deleteMany: (a: unknown) => Promise<unknown> } };
    if (anyDb.importedInvoiceLiquidation) {
      await anyDb.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
    }
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
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.prevStatus).toBe("PLANEJADO");
      expect(r.entryValorCents).toBe(10_000);
      expect(String(r.parcela ?? "")).toMatch(/^\d+\/3$/);
      const entry = await setup.cashFlowEntry.findUnique({ where: { id: r.cashFlowEntryId as string } });
      expect(entry?.status).toBe("PAGO");
    }
    // completude O(1): carimbo no pagamento
    const raw = await readExpenseRaw(setup, payment!.id);
    expect(raw?.invoiceUndoState).toBe("PROCESSED_SETTLED");
    expect(raw?.invoiceUndoParcelaCount).toBe(rows.length);
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

  it("applyPreparedSettlement devolve flippedEntries: exatamente as 2 entries PLANEJADO→PAGO do ciclo (a que já era PAGO não entra), com prevStatus/valorCents/cashFlowEntryId exatos", async () => {
    // Ciclo único que fecha 20/03 e vence 2026-04: 3 compras à vista de R$100,00
    // em 2026-03-10 (mesmo dueMonth). 1 já PAGO + 2 PLANEJADO. Pagamento em
    // 2026-04-01 de R$300,00 = total EXATO da fatura (3 parcelas).
    const dia = new Date("2026-03-10T12:00:00.000Z");
    const jaPago = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD_LAST4, valorCents: 10_000,
      data: dia, status: "PAGO", titulo: "ja-pago",
    });
    const p1 = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD_LAST4, valorCents: 10_000,
      data: dia, status: "PLANEJADO", titulo: "planejado-1",
    });
    const p2 = await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD_LAST4, valorCents: 10_000,
      data: dia, status: "PLANEJADO", titulo: "planejado-2",
    });
    const result = (await settlement.settleInvoice({
      tenantId: TENANT,
      card: { id: card.id, last4: CARD_LAST4, closingDay: 20, dueDay: 1 } as never,
      amountCents: 30_000,
      paymentDate: new Date("2026-04-01T12:00:00.000Z"),
      requester: ADMIN_REQUESTER as never,
    })) as Record<string, unknown>;
    // REGRESSÃO (comportamento vigente): as 2 PLANEJADO viraram PAGO, a 3ª intacta.
    expect(result.settledParcelas).toBe(2);
    expect((await setup.cashFlowEntry.findUnique({ where: { id: jaPago.entryId } }))?.status).toBe("PAGO");
    expect((await setup.cashFlowEntry.findUnique({ where: { id: p1.entryId } }))?.status).toBe("PAGO");
    expect((await setup.cashFlowEntry.findUnique({ where: { id: p2.entryId } }))?.status).toBe("PAGO");
    // RED (§6.1): applyPreparedSettlement ainda NÃO devolve flippedEntries.
    // Deve FALHAR se vier [] / undefined E se algum dia trouxer a entry já-PAGO (3).
    const flipped = result.flippedEntries as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(flipped)).toBe(true);
    expect(flipped!.map((f) => f.cashFlowEntryId).sort()).toEqual([p1.entryId, p2.entryId].sort());
    for (const f of flipped!) {
      expect(f.prevStatus).toBe("PLANEJADO");
      expect(f.valorCents).toBe(10_000);
    }
    expect(EXPECTED_TRAIL_VERSION).toBe(1);
  });
});
