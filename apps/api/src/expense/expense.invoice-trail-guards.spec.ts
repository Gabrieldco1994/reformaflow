// PR: PR 1 (degrau) — completa as guardas de `ExpenseService.update` sobre a
// trilha de liquidação por importação (#569 §4 B3/B9 + §2b/#1).
// RED por comportamento: hoje `changedFinancials` passado a
// `guardImportedInvoiceTrail` NÃO inclui `changedStatus`/`changedFormaPagamento`,
// então PATCH { status } da compra liquidada e PATCH { formaPagamento } do
// pagamento carimbado resolvem sem 409; e `regenerateCashFlow` roda incondicional
// num PATCH puramente descritivo, trocando os ids das `CashFlowEntry` e orfanando
// `imported_invoice_liquidations.cash_flow_entry_id`.
import { PrismaClient } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  commitStatement,
  makeBankAccountService,
  makeExpenseService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const TENANT = "iul-trail-guard-tenant";
const PESSOAL = "iul-trail-guard-pessoal";
const CARD = "4600";
const BANK = "8600";
const R = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §4 — ExpenseService.update guarda a trilha (status/formaPagamento/descritivo)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let expenses: ReturnType<typeof makeExpenseService>;
  let accountId: string;
  let cardId: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT, projectId: PESSOAL, last4: CARD, closingDay: 20, dueDay: 1,
    }));
    ({ id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK }));
    bank = makeBankAccountService(prisma);
    expenses = makeExpenseService(prisma);
  });

  afterEach(async () => {
    await setup.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  /**
   * Compra 1x no ciclo que fecha 20/06 e vence 2026-07 + pagamento importado em
   * julho com o total exato → a parcela vira PAGO e grava a trilha
   * `PROCESSED_SETTLED` (1 item ativo). Precondição financeira asseverada.
   */
  async function importSettled(parcelas = 1, valorCents = 30_000) {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas, valorCents,
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: valorCents, date: "20260705", period: "2026-07", requester: R,
      fitId: `s-${Math.random()}`,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
    });
    const entry0 = await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } });
    expect(entry0?.status).toBe("PAGO");
    expect(await setup.importedInvoiceLiquidation.count({ where: { tenantId: TENANT, deletedAt: null } })).toBeGreaterThan(0);
    return { purchaseId: purchase.id, entryIds: purchase.entryIds, paymentId: payment!.id, importId: commit.importId };
  }

  const activeLedger = () =>
    setup.importedInvoiceLiquidation.count({ where: { tenantId: TENANT, deletedAt: null } });

  it("2a — PATCH { status } da COMPRA liquidada → 409 ConflictException, zero escrita no ledger", async () => {
    const { purchaseId } = await importSettled();
    const ledgerBefore = await activeLedger();
    await expect(
      expenses.update(TENANT, PESSOAL, purchaseId, { status: "PLANEJADO" } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await activeLedger()).toBe(ledgerBefore);
  });

  it("2a — PATCH { formaPagamento } do PAGAMENTO carimbado (PROCESSED_SETTLED) → 409 ConflictException", async () => {
    const { paymentId } = await importSettled();
    const ledgerBefore = await activeLedger();
    await expect(
      expenses.update(TENANT, PESSOAL, paymentId, { formaPagamento: "PARCELADO" } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await activeLedger()).toBe(ledgerBefore);
  });

  it("2a — PATCH { status } do PAGAMENTO carimbado → 409 ConflictException", async () => {
    const { paymentId } = await importSettled();
    await expect(
      expenses.update(TENANT, PESSOAL, paymentId, { status: "PLANEJADO" } as never, R),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("2b — PATCH puramente descritivo ({ titulo }) numa compra parcelada liquidada NÃO regenera CashFlowEntry: mesmos ids/valores/status; linhas do ledger intactas", async () => {
    const { purchaseId, entryIds } = await importSettled(2, 30_000);
    const entriesBefore = await setup.cashFlowEntry.findMany({
      where: { expenseId: purchaseId }, orderBy: { data: "asc" },
    });
    const ledgerBefore = await setup.importedInvoiceLiquidation.findMany({
      where: { tenantId: TENANT }, orderBy: { id: "asc" },
    });
    expect(entriesBefore.every((e) => !e.deletedAt)).toBe(true);

    await expenses.update(TENANT, PESSOAL, purchaseId, { titulo: "renomeada" } as never, R);

    const entriesAfter = await setup.cashFlowEntry.findMany({
      where: { expenseId: purchaseId }, orderBy: { data: "asc" },
    });
    // ids preservados (regenerate teria trocado todos)
    expect(entriesAfter.map((e) => e.id).sort()).toEqual([...entryIds].sort());
    expect(entriesAfter.every((e) => !e.deletedAt)).toBe(true);
    expect(entriesAfter.map((e) => [e.valor, e.status, e.parcela])).toEqual(
      entriesBefore.map((e) => [e.valor, e.status, e.parcela]),
    );
    // a linha do ledger continua apontando para a mesma (viva) CashFlowEntry
    const ledgerAfter = await setup.importedInvoiceLiquidation.findMany({
      where: { tenantId: TENANT }, orderBy: { id: "asc" },
    });
    expect(ledgerAfter).toEqual(ledgerBefore);
    const claimedEntry = await setup.cashFlowEntry.findUnique({
      where: { id: ledgerAfter[0].cashFlowEntryId },
    });
    expect(claimedEntry?.deletedAt).toBeNull();
    expect(claimedEntry?.status).toBe("PAGO");
  });

  it("2b — PATCH que muda a config de parcelamento ({ quantidadeParcela }) numa compra SEM trilha ainda regenera o caixa (não quebrou o caminho comum)", async () => {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 2, valorCents: 10_000,
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });
    const idsBefore = purchase.entryIds;
    await expenses.update(TENANT, PESSOAL, purchase.id, { quantidadeParcela: 3 } as never, R);
    const after = await setup.cashFlowEntry.findMany({
      where: { expenseId: purchase.id, deletedAt: null }, orderBy: { data: "asc" },
    });
    expect(after).toHaveLength(3);
    expect(after.some((e) => idsBefore.includes(e.id))).toBe(false);
  });
});
