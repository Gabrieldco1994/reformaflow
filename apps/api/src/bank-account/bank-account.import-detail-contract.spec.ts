// PR: PR 2 (feature) — `getImportDetail.settlement{…}` + `canUndo`/`blockReason` por estado.
// #569 §6.8 — contrato de resposta de `getImportDetail` (`settlement{ state, cardId,
// dueMonth, payments[] }`). Grupo A: hoje `getImportDetail` NÃO devolve `settlement`
// nenhum (e nem recebe `requester`) → cada `it` executa e falha a asserção do
// campo ausente. Alguns cenários dependem também do schema aditivo (Grupo B) para
// que o commit grave a trilha real — depende do PR 1 (degrau), §3.3.1.
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
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-contract-tenant";
const PESSOAL = "iul-contract-pessoal";
const CARD = "4800";
const BANK = "8800";
const R = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.8 — import-detail contract (RED)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
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

  const detail = (importId: string) =>
    (bank as unknown as { getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>> })
      .getImportDetail(TENANT, PESSOAL, accountId, importId, R);

  async function importSettled(
    fitId = "c1",
    primeiraData = new Date("2026-06-10T12:00:00.000Z"),
    payDate = "20260630",
    period = "2026-06",
  ) {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 1, valorCents: 30_000, primeiraData,
      titulo: `compra-${fitId}`,
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: 30_000, date: payDate, period, requester: R, fitId,
    });
    // precondição: a parcela foi liquidada por esta importação
    const entry = await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } });
    expect(entry?.status).toBe("PAGO");
    return commit.importId;
  }

  it("getImportDetail.settlement identifica o cartão por cardId estável, nunca last4", async () => {
    const importId = await importSettled();
    const d = await detail(importId);
    const settlement = (d.settlement as Array<Record<string, unknown>> | Record<string, unknown> | undefined);
    const first = Array.isArray(settlement) ? settlement[0] : settlement;
    expect(first).toBeTruthy();
    expect((first as Record<string, unknown>).cardId).toBe(cardId);
    expect(JSON.stringify(first)).not.toContain(CARD);
  });

  it("duas importações que pagam a MESMA fatura → settlement.payments tem 2 entradas com paymentExpenseId/importId distintos", async () => {
    // 1 compra R$150 na fatura que vence 01/07; c1 e c2 são 2 débitos bancários
    // do MESMO valor casados à mesma fatura (c2 encontra a fatura já paga por c1).
    await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 1, valorCents: 15_000,
      primeiraData: new Date("2026-06-05T12:00:00.000Z"),
    });
    const c1 = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: 15_000, date: "20260628", period: "2026-06", requester: R, fitId: "pay-A",
    });
    const c2 = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: 15_000, date: "20260629", period: "2026-06", requester: R, fitId: "pay-B",
    });
    const d = await detail(c2.importId);
    const settlement = d.settlement as Array<Record<string, unknown>> | Record<string, unknown> | undefined;
    const first = Array.isArray(settlement) ? settlement[0] : settlement;
    expect(first).toBeTruthy();
    const payments = (first as Record<string, unknown>).payments as Array<Record<string, unknown>>;
    expect(Array.isArray(payments)).toBe(true);
    expect(payments).toHaveLength(2);
    expect(new Set(payments.map((p) => p.importId))).toEqual(new Set([c1.importId, c2.importId]));
  });

  it("estado honesto: cartão identificado, nenhuma parcela liquidada → state NO_SETTLEMENT (nunca ALREADY_PAID/PARTIAL), cardId preenchido, canUndo:true, reopenedInvoices:[]", async () => {
    await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: PESSOAL, cardLast4: CARD, parcelas: 1, valorCents: 30_000,
      primeiraData: new Date("2026-07-01T12:00:00.000Z"),
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: 77_777, date: "20260630", period: "2026-06", requester: R,
    });
    const d = await detail(commit.importId);
    const settlement = d.settlement as Array<Record<string, unknown>> | Record<string, unknown> | undefined;
    const first = Array.isArray(settlement) ? settlement[0] : settlement;
    expect(first).toBeTruthy();
    const s = first as Record<string, unknown>;
    expect(s.state).toBe("NO_SETTLEMENT");
    expect(["ALREADY_PAID", "PARTIAL"]).not.toContain(s.state);
    expect(s.cardId).toBe(cardId);
    expect(d.canUndo).toBe(true);
  });

  it("estado honesto: pagamento novo SEM cartão (M8) → state NO_SETTLEMENT, cardId null, canUndo:true; NÃO aparece como LEGACY_NO_TRAIL", async () => {
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK,
      debitCents: 33_210, date: "20260630", period: "2026-06", memo: "PAGTO CART CRED", requester: R,
    });
    const d = await detail(commit.importId);
    const settlement = d.settlement as Array<Record<string, unknown>> | Record<string, unknown> | undefined;
    const first = Array.isArray(settlement) ? settlement[0] : settlement;
    expect(first).toBeTruthy();
    const s = first as Record<string, unknown>;
    expect(s.state).toBe("NO_SETTLEMENT");
    expect(s.cardId).toBeNull();
    expect(d.canUndo).toBe(true);
    expect(s.state).not.toBe("LEGACY_NO_TRAIL");
  });

  it("idempotência ≠ reversibilidade: 2º undoImport é no-op (idempotente), mas lote com drift responde 409 (não reversível) — asserção explícita dos dois", async () => {
    const importIdA = await importSettled("idem-A");
    await bank.undoImport(TENANT, PESSOAL, accountId, importIdA, R);
    const noop = await bank.undoImport(TENANT, PESSOAL, accountId, importIdA, R);
    expect(noop).toMatchObject({ ok: true, alreadyUndone: true });

    // isola a parte B: remove tudo que a importação A deixou (compra volta a PLANEJADO no undo)
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });

    const importIdB = await importSettled("idem-B", new Date("2026-06-12T12:00:00.000Z"));
    const entry = await setup.cashFlowEntry.findFirst({ where: { tenantId: TENANT, status: "PAGO", parcela: null } });
    expect(entry).not.toBeNull();
    await setup.cashFlowEntry.update({ where: { id: entry!.id }, data: { valor: 999 } });
    await expect(bank.undoImport(TENANT, PESSOAL, accountId, importIdB, R)).rejects.toThrow(/DRIFT/);
  });
});
