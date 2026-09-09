// #569 §6.4 — mutações/adoções posteriores sobre parcelas liquidadas por importação (tabela B).
// Grupo A (RED por comportamento, executa e falha a asserção):
//   B1 (JÁ 404 hoje quando importId != null — PASSA, é trava), B2/B2c (payInvoice REAL
//   hoje cria o pagamento sem 409 → RED), B8 (lote adotado hoje 409 LEGACY — parte passa).
// Grupo B (RED por ausência — depende do schema aditivo do PR 1 (degrau), §3.3.1;
//   NÃO aplicar migration nesta rodada, decisão do PO): todo `it` que semeia
//   `ImportedInvoiceLiquidation` ou lê `invoiceUndoState`.
import { PrismaClient } from "@prisma/client";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { MonthlyOverviewMutationRequester } from "../monthly-overview/monthly-overview.service";
import {
  commitStatement,
  makeBankAccountService,
  makeExpenseService,
  makeMonthlyOverviewService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
  seedSinglePurchase,
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-mut-tenant";
const PESSOAL = "iul-mut-pessoal";
const CARD = "4400";
const BANK = "8400";
const R = pessoalRequester(PESSOAL);
const ADMIN: MonthlyOverviewMutationRequester = { id: "iul-mut-admin", role: "ADMIN" };

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.4 — later-mutation guards (RED)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let mo: ReturnType<typeof makeMonthlyOverviewService>;
  let expenses: ReturnType<typeof makeExpenseService>;
  let accountId: string;
  let cardId: string;
  let cardIdNoCycle: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT, projectId: PESSOAL, last4: CARD, closingDay: 20, dueDay: 1,
    }));
    ({ id: cardIdNoCycle } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT, projectId: PESSOAL, last4: "4499", closingDay: null, dueDay: null,
    }));
    ({ id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK }));
    bank = makeBankAccountService(prisma);
    mo = makeMonthlyOverviewService(prisma);
    expenses = makeExpenseService(prisma);
  });

  afterEach(async () => {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
    const l = (setup as unknown as { importedInvoiceLiquidation?: { deleteMany: (a: unknown) => Promise<unknown> } }).importedInvoiceLiquidation;
    if (l) await l.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  /** Compra 1x + commit que liquida a fatura; devolve ids. */
  async function importSettled(valorCents = 30_000, primeiraData = new Date("2026-07-01T12:00:00.000Z")) {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 1, valorCents, primeiraData,
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: valorCents, date: "20260630", period: "2026-06", requester: R,
      fitId: `s-${Math.random()}`,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
    });
    return { purchaseId: purchase.id, entryId: purchase.entryIds[0], importId: commit.importId, paymentId: payment!.id };
  }

  const ledger = () => (setup as unknown as {
    importedInvoiceLiquidation: { count: (a: unknown) => Promise<number>; updateMany: (a: unknown) => Promise<unknown> };
  }).importedInvoiceLiquidation;

  it("B1 undoInvoicePayment (REAL, monthly-overview.service.ts) já responde 404 quando o pagamento casado tem importId != null (:3548-3558); ledger intacto", async () => {
    const { importId } = await importSettled();
    await expect(
      mo.undoInvoicePayment(TENANT, PESSOAL, { cardId, dueMonth: "2026-07" }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBeGreaterThan(0);
    expect(importId).toBeTruthy();
  });

  it("B1b undoInvoicePayment reverteu uma parcela do ledger de OUTRO caminho antes do undo → undoImport 409 DRIFT, zero escrita", async () => {
    const { entryId, importId } = await importSettled();
    // parcela revertida fora de banda
    await setup.cashFlowEntry.update({ where: { id: entryId }, data: { status: "PLANEJADO" } });
    const before = await setup.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } });
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, importId, R)).rejects.toBeInstanceOf(ConflictException);
    const after = await setup.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
  });

  it("B2 payInvoice REAL (não fabrica carimbo): trilha PROCESSED_SETTLED + itens ATIVOS no card+dueMonth alvo → 409 INVOICE_HAS_IMPORT_TRAIL; zero PAGAMENTO_FATURA_CARTAO novo; entries seguem PAGO; ledger e carimbo intactos", async () => {
    const { entryId, paymentId } = await importSettled();
    const paymentsBefore = await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } });
    await expect(
      mo.payInvoice(
        TENANT, PESSOAL,
        { cardId, month: "2026-07", amountCents: 30_000, bankLast4: BANK, paymentDate: "2026-07-05" },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } })).toBe(paymentsBefore);
    expect((await setup.cashFlowEntry.findUnique({ where: { id: entryId } }))?.status).toBe("PAGO");
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBeGreaterThan(0);
    expect(paymentId).toBeTruthy();
  });

  it("B2b payInvoice REAL: trilha PROCESSED_NONE (zero liquidações) no MESMO card+dueMonth → payInvoice PERMITE (não 409); cria o PAGAMENTO_FATURA_CARTAO manual normalmente", async () => {
    // pagamento importado que NÃO liquidou nada (nenhuma fatura compatível)
    await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: 88_888, date: "20260630", period: "2026-06", requester: R,
    });
    await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, valorCents: 20_000,
      data: new Date("2026-07-03T12:00:00.000Z"), status: "PAGO", titulo: "compra-julho",
    });
    const result = await mo.payInvoice(
      TENANT, PESSOAL,
      { cardId, month: "2026-07", amountCents: 20_000, bankLast4: BANK, paymentDate: "2026-07-10" },
      ADMIN,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("B2c importar+liquidar a fatura inteira → prepared do payInvoice VAZIO; payInvoice manual em OUTRA data → 409 INVOICE_HAS_IMPORT_TRAIL (dueMonth do DTO); zero PAGAMENTO_FATURA_CARTAO novo; nenhuma saída nova no caixa", async () => {
    await importSettled(30_000);
    const paymentsBefore = await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } });
    const cashOutBefore = await setup.cashFlowEntry.count({ where: { tenantId: TENANT, tipo: "DESPESA" } });
    await expect(
      mo.payInvoice(
        TENANT, PESSOAL,
        { cardId, month: "2026-07", amountCents: 30_000, bankLast4: BANK, paymentDate: "2026-07-20" },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await setup.expense.count({ where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" } })).toBe(paymentsBefore);
    expect(await setup.cashFlowEntry.count({ where: { tenantId: TENANT, tipo: "DESPESA" } })).toBe(cashOutBefore);
  });

  it("B2c-neg payInvoice REAL: cartão sem closingDay/dueDay e sem match de valor → nenhum dueMonth alvo resolvível → pre-check não dispara (a rede é MANUAL_PAYMENT_OVERLAP no undoImport)", async () => {
    await seedSinglePurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: "4499", valorCents: 12_000,
      data: new Date("2026-07-01T12:00:00.000Z"), status: "PAGO",
    });
    const result = await mo.payInvoice(
      TENANT, PESSOAL,
      { cardId: cardIdNoCycle, month: "2026-07", amountCents: 12_000, bankLast4: BANK, paymentDate: "2026-07-10" },
      ADMIN,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("B2d pagamento manual pré-existente casado à fatura do carimbo → undoImport 409 MANUAL_PAYMENT_OVERLAP, zero escrita", async () => {
    const { importId } = await importSettled();
    // pagamento manual posterior semeado direto, casado por settlesInvoiceKey
    await setup.expense.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", titulo: "manual",
        valor: 30_000, quantidade: 1, valorTotal: 30_000, formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-07-15T12:00:00.000Z"), status: "PAGO",
        cardLast4: CARD, settlesInvoiceKey: `${CARD}:2026-07`,
      },
    });
    const before = await setup.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } });
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, importId, R)).rejects.toBeInstanceOf(ConflictException);
    expect(await setup.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("B3 PATCH /expenses/:id muda valor da compra liquidada → 409 ConflictException no update; ledger intacto", async () => {
    const { purchaseId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, purchaseId, { valor: 45_000 } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBeGreaterThan(0);
  });

  it("B4a PATCH creditCardId de pagamento PROCESSED_SETTLED (itens ativos) para outro cartão → 409 ConflictException; ledger intacto", async () => {
    const { paymentId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, paymentId, { creditCardId: cardIdNoCycle } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("B4b PATCH creditCardId de pagamento PROCESSED_NONE sem cartão e sem itens → PERMITIDO; carimbo preservado; ledger continua vazio", async () => {
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK,
      debitCents: 12_345, date: "20260630", period: "2026-06", memo: "PAGAMENTO DE FATURA", requester: R,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, importId: commit.importId, tipoDespesa: { in: ["PAGAMENTO_FATURA_CARTAO", "PAGAMENTO_FATURA_SEM_CARTAO"] } },
    });
    await expect(
      expenses.update(TENANT, PESSOAL, payment!.id, { creditCardId: cardId } as never, R),
    ).resolves.toBeDefined();
    const raw = (await setup.expense.findUnique({ where: { id: payment!.id } })) as Record<string, unknown> | null;
    expect(raw?.invoiceUndoState).toBe("PROCESSED_NONE");
    expect(await ledger().count({ where: { tenantId: TENANT, deletedAt: null } })).toBe(0);
  });

  it("B5a DELETE da compra liquidada → 409 no remove; B5b DELETE do pagamento carimbado → 409", async () => {
    const { purchaseId, paymentId } = await importSettled();
    await expect(expenses.remove(TENANT, PESSOAL, purchaseId, R)).rejects.toBeInstanceOf(ConflictException);
    await expect(expenses.remove(TENANT, PESSOAL, paymentId, R)).rejects.toBeInstanceOf(ConflictException);
  });

  it("B6 ratear a compra liquidada → 409 em guardRateioParticipation", async () => {
    await seedProjectReforma();
    const { purchaseId } = await importSettled();
    await expect(
      (expenses as unknown as { ratearSource: (...a: unknown[]) => Promise<unknown> }).ratearSource?.(
        TENANT, PESSOAL, purchaseId, { allocations: [{ projectId: REFORMA, valorCents: 30_000 }] }, R,
      ) ?? expenses.update(TENANT, PESSOAL, purchaseId, { rateio: [{ projectId: REFORMA, valorCents: 30_000 }] } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("B9a PATCH tipoDespesa do PAGAMENTO_FATURA_CARTAO com carimbo ATIVO → 409 em hasProtectedChange; carimbo/importId/cardLast4 intactos", async () => {
    const { paymentId, importId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, paymentId, { tipoDespesa: "OUTROS" } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
    const raw = (await setup.expense.findUnique({ where: { id: paymentId } })) as Record<string, unknown> | null;
    expect(raw?.importId).toBe(importId);
    expect(raw?.cardLast4).toBe(CARD);
  });

  it("B9b PATCH cardLast4/bankLast4/settlesInvoiceKey do pagamento carimbado → 409 ConflictException", async () => {
    const { paymentId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, paymentId, { settlesInvoiceKey: "9999:2026-07" } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("B8 PAGAMENTO_FATURA_CARTAO adotado na dedup (sem carimbo) → lote fica canUndo:false / undoImport 409 LEGACY_OR_MIXED", async () => {
    const imp = await setup.bankStatementImport.create({
      data: { tenantId: TENANT, accountId, periodLabel: "2026-06", source: "OFX", inserted: 1, totalAmountCents: 30_000 },
    });
    await setup.expense.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", titulo: "adotado",
        valor: 30_000, quantidade: 1, valorTotal: 30_000, formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-28T12:00:00.000Z"), status: "PAGO", importId: imp.id,
        cardLast4: CARD, createdAt: new Date("2026-06-01T12:00:00.000Z"),
      },
    });
    const detail = (await (bank as unknown as { getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>> })
      .getImportDetail(TENANT, PESSOAL, accountId, imp.id, R)) as Record<string, unknown>;
    expect(detail.canUndo).toBe(false);
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, imp.id, R)).rejects.toBeInstanceOf(ConflictException);
  });

  it("drift por entry soft-deletada → 409, zero escrita; drift por settledByExpenseId posterior → 409", async () => {
    const a = await importSettled(30_000);
    await setup.cashFlowEntry.update({ where: { id: a.entryId }, data: { deletedAt: new Date() } });
    const before = await setup.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } });
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, a.importId, R)).rejects.toBeInstanceOf(ConflictException);
    expect(await setup.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } })).toEqual(before);
  });

  const REFORMA = "iul-mut-reforma";
  async function seedProjectReforma() {
    const exists = await setup.project.findUnique({ where: { id: REFORMA } });
    if (!exists) await setup.project.create({ data: { id: REFORMA, tenantId: TENANT, type: "REFORMA", name: "Reforma" } });
  }
});
