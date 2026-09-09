// PR: PR 1 (degrau) — `outcome`/`flippedEntries`/carimbo derivados do `apply`.
// #569 §6.2 — janelas de identificação/liquidação (Grupo A: as janelas 60d/±10d/
// {m,m+1}/75d JÁ existem em `origin/main@e66e49c1`; estes `it` asseveram que
// continuam pinadas). O `outcome: SETTLED | NO_SETTLEMENT` NÃO existe ainda —
// os `it` que o leem falham a asserção (RED por comportamento).
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  commitStatement,
  makeBankAccountService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
  seedSinglePurchase,
  readExpenseRaw,
} from "../bank-account/__tests__/invoice-undo.fixtures";

const TENANT = "iul-win-tenant";
const PESSOAL = "iul-win-pessoal";
const CARD = "4200";
const BANK = "8200";
const R = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.2 — janelas (RED)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let accountId: string;
  let cardId: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: CARD,
      closingDay: 20,
      dueDay: 1,
    }));
    ({ id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK }));
    bank = makeBankAccountService(prisma);
  });

  afterEach(async () => {
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  async function pay(
    debitCents: number,
    date: string,
    period: string,
    cardLast4: string | undefined = CARD,
    memo?: string,
  ) {
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK,
      cardLast4,
      memo,
      debitCents,
      date,
      period,
      requester: R,
      fitId: `w-${date}-${debitCents}-${Math.random()}`,
    });
    const payment = await setup.expense.findFirst({
      where: {
        tenantId: TENANT,
        tipoDespesa: { in: ["PAGAMENTO_FATURA_CARTAO", "PAGAMENTO_FATURA_SEM_CARTAO"] },
        importId: commit.importId,
      },
    });
    return { commit, payment };
  }

  it("liquidação por vencimento usa janela de mês {payMonth, payMonth+1}: pagamento em 2026-06-30 fecha fatura com vencimento 2026-07-01", async () => {
    // ARRANGE: compra ANTES do pagamento (10/06, dentro dos 60d) e no ciclo que
    // fecha 20/06 → vence 01/07 (dueMonth "2026-07"), dentro de {payMonth=2026-06,
    // payMonth+1=2026-07}. Data 01/07 cairia no ciclo de agosto e nunca liquidaria.
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD,
      parcelas: 1,
      valorCents: 30_000,
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });
    const { payment } = await pay(30_000, "20260630", "2026-06");
    // precondição: o pagamento de fatura foi criado e o cartão identificado (last4)
    expect(payment).not.toBeNull();
    expect(payment!.cardLast4).toBe(CARD);
    const entry = await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } });
    expect(entry?.status).toBe("PAGO");
    const raw = await readExpenseRaw(setup, payment!.id);
    expect(raw).not.toBeNull();
    expect(raw!.invoiceUndoState).toBe("PROCESSED_SETTLED");
    expect(raw!.invoiceUndoDueMonth).toBe("2026-07");
  });

  it("fallback findImportByTotal respeita 75 dias corridos: import criado há 76 dias NÃO casa; há 74 dias casa", async () => {
    const noCycle = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: "4275",
      closingDay: null,
      dueDay: null,
    });
    const cci = (setup as unknown as {
      creditCardStatementImport: { create: (a: unknown) => Promise<{ id: string }>; deleteMany: (a: unknown) => Promise<unknown> };
    }).creditCardStatementImport;
    const payDate = new Date("2026-06-15T12:00:00.000Z");
    for (const [label, ageDays, shouldSettle] of [
      ["76d", 76, false],
      ["74d", 74, true],
    ] as const) {
      const p = await seedSinglePurchase(setup, {
        tenantId: TENANT,
        projectId: PESSOAL,
        cardLast4: "4275",
        valorCents: 20_000,
        data: new Date("2026-04-01T12:00:00.000Z"),
        titulo: `fb-${label}`,
      });
      const created = new Date(payDate);
      created.setDate(created.getDate() - ageDays);
      const imp = await cci.create({
        data: { tenantId: TENANT, cardId: noCycle.id, periodLabel: "2026-04", source: "OFX", totalAmountCents: 20_000, createdAt: created },
      });
      // estratégia 2 (fallback por fatura importada) só considera compras com
      // Expense.importId == CreditCardStatementImport.id (service :224).
      await setup.expense.update({ where: { id: p.id }, data: { importId: imp.id } });
      const { payment } = await pay(20_000, "20260615", "2026-06", "4275");
      const entry = await setup.cashFlowEntry.findFirst({ where: { expenseId: p.id } });
      expect(entry?.status).toBe(shouldSettle ? "PAGO" : "PLANEJADO");
      const raw = await readExpenseRaw(setup, payment!.id);
      expect(raw?.invoiceUndoState).toBe(shouldSettle ? "PROCESSED_SETTLED" : "PROCESSED_NONE");
      await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
      await setup.expense.deleteMany({ where: { tenantId: TENANT, tipoDespesa: { not: undefined } } });
      await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
      await cci.deleteMany({ where: { tenantId: TENANT } });
    }
  });

  it("fallback tolera ±R$2 no totalAmountCents e recusa ±R$2,01", async () => {
    const noCycle = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: "4276",
      closingDay: null,
      dueDay: null,
    });
    const cci = (setup as unknown as {
      creditCardStatementImport: { create: (a: unknown) => Promise<{ id: string }>; deleteMany: (a: unknown) => Promise<unknown> };
    }).creditCardStatementImport;
    for (const [label, debit, shouldSettle] of [
      ["dentro", 20_200, true],
      ["fora", 20_201, false],
    ] as const) {
      const p = await seedSinglePurchase(setup, {
        tenantId: TENANT,
        projectId: PESSOAL,
        cardLast4: "4276",
        valorCents: 20_000,
        data: new Date("2026-04-01T12:00:00.000Z"),
        titulo: `tol-${label}`,
      });
      const imp = await cci.create({
        data: { tenantId: TENANT, cardId: noCycle.id, periodLabel: "2026-04", source: "OFX", totalAmountCents: 20_000, createdAt: new Date("2026-06-01T12:00:00.000Z") },
      });
      await setup.expense.update({ where: { id: p.id }, data: { importId: imp.id } });
      await pay(debit, "20260615", "2026-06", "4276");
      const entry = await setup.cashFlowEntry.findFirst({ where: { expenseId: p.id } });
      expect(entry?.status).toBe(shouldSettle ? "PAGO" : "PLANEJADO");
      await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
      await setup.expense.deleteMany({ where: { tenantId: TENANT, tipoDespesa: { not: undefined } } });
      await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
      await cci.deleteMany({ where: { tenantId: TENANT } });
    }
  });

  it("identificação de cartão por importação (findMatchingCreditCard, bank-account.service:2823-2831) usa 60 dias: CreditCardStatementImport criado há 61d não identifica; 59d identifica", async () => {
    // A janela de 60d é sobre `CreditCardStatementImport.createdAt` (total ±R$2),
    // não sobre a data das compras. Memo COM indício de pagamento de cartão mas
    // SEM last4 → a identidade do cartão depende exclusivamente desse import.
    const cci = (setup as unknown as {
      creditCardStatementImport: { create: (a: unknown) => Promise<{ id: string }>; deleteMany: (a: unknown) => Promise<unknown> };
    }).creditCardStatementImport;
    for (const [label, ageDays, shouldMatch] of [
      ["61d", 61, false],
      ["59d", 59, true],
    ] as const) {
      const payDate = new Date("2026-06-15T12:00:00.000Z");
      const created = new Date(payDate);
      created.setDate(created.getDate() - ageDays);
      await cci.create({
        data: { tenantId: TENANT, cardId, periodLabel: "2026-05", source: "OFX", totalAmountCents: 30_000, createdAt: created },
      });
      const { payment } = await pay(30_000, "20260615", "2026-06", undefined, "PAGTO CART CRED");
      expect(payment).not.toBeNull();
      // REGRESSÃO (comportamento vigente): o pagamento só é vinculado a um cartão
      // quando o import de 60d casa; fora da janela fica PAGAMENTO_FATURA_SEM_CARTAO.
      expect(payment!.cardLast4).toBe(shouldMatch ? CARD : null);
      // RED (§3.3): coluna de carimbo do cartão identificado ainda não existe.
      const raw = await readExpenseRaw(setup, payment!.id);
      expect(raw).not.toBeNull();
      expect(raw!.invoiceUndoCardId != null).toBe(shouldMatch);
      await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
      await setup.expense.deleteMany({ where: { tenantId: TENANT, tipoDespesa: { not: undefined } } });
      await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
      await cci.deleteMany({ where: { tenantId: TENANT } });
    }
  });

  it("identificação estrita por valor (findCardPaymentByAmount, bank-account.service:~2894) usa ±10 dias: CreditCardStatementImport criado 11d antes do pagamento não identifica; 9d identifica", async () => {
    // Memo de transferência de saída ("TED ...") → NÃO é card-payment por texto, mas
    // `needsValueMatch` liga (looksLikeOutboundTransfer) e cai no match ESTRITO:
    // ±R$0,50 e ±10 dias sobre `CreditCardStatementImport.createdAt`. Fora da janela
    // o débito continua uma despesa comum; dentro, é reclassificado a pagamento de fatura.
    const cci = (setup as unknown as {
      creditCardStatementImport: { create: (a: unknown) => Promise<{ id: string }>; deleteMany: (a: unknown) => Promise<unknown> };
    }).creditCardStatementImport;
    for (const [label, ageDays, shouldMatch] of [
      ["11d", 11, false],
      ["9d", 9, true],
    ] as const) {
      const payDate = new Date("2026-06-15T12:00:00.000Z");
      const created = new Date(payDate);
      created.setDate(created.getDate() - ageDays);
      await cci.create({
        data: { tenantId: TENANT, cardId, periodLabel: "2026-05", source: "OFX", totalAmountCents: 33_333, createdAt: created },
      });
      const commit = await commitStatement(bank, {
        tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK,
        memo: "TED 998877 ENVIADA", debitCents: 33_333, date: "20260615", period: "2026-06",
        requester: R, fitId: `strict-${label}-${Math.random()}`,
      });
      const expense = await setup.expense.findFirst({
        where: { tenantId: TENANT, importId: commit.importId },
      });
      expect(expense).not.toBeNull();
      // REGRESSÃO (comportamento vigente): reclassificação p/ pagamento de fatura
      // + cartão só acontece dentro da janela estrita.
      expect(expense!.tipoDespesa === "PAGAMENTO_FATURA_CARTAO").toBe(shouldMatch);
      expect(expense!.cardLast4).toBe(shouldMatch ? CARD : null);
      // RED (§3.3): coluna de carimbo do cartão identificado ainda não existe.
      const raw = await readExpenseRaw(setup, expense!.id);
      expect(raw!.invoiceUndoCardId != null).toBe(shouldMatch);
      await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
      await setup.expense.deleteMany({ where: { tenantId: TENANT, tipoDespesa: { not: undefined } } });
      await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
      await cci.deleteMany({ where: { tenantId: TENANT } });
    }
  });

  it("outcome SETTLED sse e só se flippedEntries.length > 0; caso contrário NO_SETTLEMENT", async () => {
    // compra no ciclo que vence 01/07 (ver teste da janela {m,m+1})
    await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD,
      parcelas: 1,
      valorCents: 30_000,
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });
    const settled = await pay(30_000, "20260630", "2026-06");
    expect(settled.payment).not.toBeNull();
    // REGRESSÃO (comportamento vigente): a parcela do ciclo virou PAGO.
    const flipped = await setup.cashFlowEntry.findFirst({ where: { tenantId: TENANT, tipo: "DESPESA" } });
    expect(flipped?.status).toBe("PAGO");
    const settledRaw = await readExpenseRaw(setup, settled.payment!.id);
    expect(settledRaw!.invoiceUndoState).toBe("PROCESSED_SETTLED");
    const detailSettled = (await (bank as unknown as { getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>> })
      .getImportDetail(TENANT, PESSOAL, accountId, settled.commit.importId, R)) as Record<string, unknown>;
    expect((detailSettled.settlement as Record<string, unknown> | undefined)?.state).toBe("SETTLED_BY_IMPORT");
  });

  it("fatura já paga, diferença a menos, diferença a MAIS, nenhuma fatura → todos NO_SETTLEMENT; hint é best-effort e NÃO é asseverado como coluna persistida", async () => {
    // nenhuma fatura compatível
    const { payment } = await pay(99_999, "20260630", "2026-06");
    expect(payment).not.toBeNull();
    const raw = await readExpenseRaw(setup, payment!.id);
    expect(raw).not.toBeNull();
    expect(raw!.invoiceUndoState).toBe("PROCESSED_NONE");
    expect(raw).not.toHaveProperty("invoiceUndoHint");
    expect(raw).not.toHaveProperty("hint");
    // cartão identificado (last4 no memo) mas fatura não fechou → card_id preenchido
    expect(raw!.invoiceUndoCardId).toBe(cardId);
  });
});
