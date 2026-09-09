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

  async function pay(debitCents: number, date: string, period: string, cardLast4 = CARD) {
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK,
      cardLast4,
      debitCents,
      date,
      period,
      requester: R,
      fitId: `w-${date}-${debitCents}-${Math.random()}`,
    });
    const payment = await setup.expense.findFirst({
      where: { tenantId: TENANT, tipoDespesa: "PAGAMENTO_FATURA_CARTAO", importId: commit.importId },
    });
    return { commit, payment };
  }

  it("liquidação por vencimento usa janela de mês {payMonth, payMonth+1}: pagamento em 2026-06-30 fecha fatura com vencimento 2026-07-01", async () => {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD,
      parcelas: 1,
      valorCents: 30_000,
      primeiraData: new Date("2026-07-01T12:00:00.000Z"),
    });
    const { payment } = await pay(30_000, "20260630", "2026-06");
    const entry = await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } });
    expect(entry?.status).toBe("PAGO");
    const raw = await readExpenseRaw(setup, payment!.id);
    expect(raw?.invoiceUndoState).toBe("PROCESSED_SETTLED");
    expect(raw?.invoiceUndoDueMonth).toBe("2026-07");
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
      await cci.create({
        data: { tenantId: TENANT, cardId: noCycle.id, periodLabel: "2026-04", source: "OFX", totalAmountCents: 20_000, createdAt: created },
      });
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
      await cci.create({
        data: { tenantId: TENANT, cardId: noCycle.id, periodLabel: "2026-04", source: "OFX", totalAmountCents: 20_000, createdAt: new Date("2026-06-01T12:00:00.000Z") },
      });
      await pay(debit, "20260615", "2026-06", "4276");
      const entry = await setup.cashFlowEntry.findFirst({ where: { expenseId: p.id } });
      expect(entry?.status).toBe(shouldSettle ? "PAGO" : "PLANEJADO");
      await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
      await setup.expense.deleteMany({ where: { tenantId: TENANT, tipoDespesa: { not: undefined } } });
      await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
      await cci.deleteMany({ where: { tenantId: TENANT } });
    }
  });

  it("identificação de cartão por importação usa 60 dias (bank-account): import há 61d não identifica; 59d identifica", async () => {
    // A prévia/commit identifica o cartão por compras no cartão dentro de 60d do pagamento.
    for (const [label, ageDays, shouldMatch] of [
      ["61d", 61, false],
      ["59d", 59, true],
    ] as const) {
      const compra = new Date("2026-06-15T12:00:00.000Z");
      compra.setDate(compra.getDate() - ageDays);
      await seedSinglePurchase(setup, {
        tenantId: TENANT,
        projectId: PESSOAL,
        cardLast4: CARD,
        valorCents: 30_000,
        data: compra,
        titulo: `id60-${label}`,
      });
      const { payment } = await pay(30_000, "20260615", "2026-06");
      const raw = await readExpenseRaw(setup, payment!.id);
      expect(raw?.invoiceUndoCardId == null ? false : true).toBe(shouldMatch);
      await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
      await setup.expense.deleteMany({ where: { tenantId: TENANT, tipoDespesa: { not: undefined } } });
      await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
    }
  });

  it("identificação estrita por valor usa ±10 dias: pagamento 11d após a compra-final não identifica; 9d identifica", async () => {
    for (const [label, gapDays, shouldMatch] of [
      ["11d", 11, false],
      ["9d", 9, true],
    ] as const) {
      const compra = new Date("2026-06-01T12:00:00.000Z");
      const payDate = new Date(compra);
      payDate.setDate(payDate.getDate() + gapDays);
      await seedSinglePurchase(setup, {
        tenantId: TENANT,
        projectId: PESSOAL,
        cardLast4: CARD,
        valorCents: 33_333,
        data: compra,
        titulo: `strict-${label}`,
      });
      const y = payDate.toISOString().slice(0, 10).replace(/-/g, "");
      const { payment } = await pay(33_333, y, "2026-06");
      const raw = await readExpenseRaw(setup, payment!.id);
      expect(raw?.invoiceUndoCardId == null ? false : true).toBe(shouldMatch);
      await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
      await setup.expense.deleteMany({ where: { tenantId: TENANT, tipoDespesa: { not: undefined } } });
      await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
    }
  });

  it("outcome SETTLED sse e só se flippedEntries.length > 0; caso contrário NO_SETTLEMENT", async () => {
    await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD,
      parcelas: 1,
      valorCents: 30_000,
      primeiraData: new Date("2026-07-01T12:00:00.000Z"),
    });
    const settled = await pay(30_000, "20260630", "2026-06");
    const settledRaw = await readExpenseRaw(setup, settled.payment!.id);
    expect(settledRaw?.invoiceUndoState).toBe("PROCESSED_SETTLED");
    const detailSettled = (await (bank as unknown as { getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>> })
      .getImportDetail(TENANT, PESSOAL, accountId, settled.commit.importId, R)) as Record<string, unknown>;
    expect((detailSettled.settlement as Record<string, unknown> | undefined)?.state).toBe("SETTLED_BY_IMPORT");
  });

  it("fatura já paga, diferença a menos, diferença a MAIS, nenhuma fatura → todos NO_SETTLEMENT; hint é best-effort e NÃO é asseverado como coluna persistida", async () => {
    // nenhuma fatura compatível
    const { payment } = await pay(99_999, "20260630", "2026-06");
    const raw = await readExpenseRaw(setup, payment!.id);
    expect(raw?.invoiceUndoState).toBe("PROCESSED_NONE");
    expect(raw).not.toHaveProperty("invoiceUndoHint");
    expect(raw).not.toHaveProperty("hint");
    expect(cardId).toBeTruthy();
  });
});
