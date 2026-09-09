// PR: PR 1 (degrau) — rollback do lote quando `recordImportedLiquidations` estoura
//     (itens 1–2 + regression). PR 2 (feature) — `getAccountView` volta ao baseline
//     pós-`undoImport` via ledger (item 3, "pagar-por-import → undoImport …").
// #569 §6.3 — atomicidade do commit/undo com a trilha.
// RED por ausência (Grupo B) nos itens que semeiam/leem `ImportedInvoiceLiquidation`
// — depende do schema aditivo do PR 1 (degrau), §3.3.1. NÃO aplicar migration
// nesta rodada (decisão do PO). O 3º `it` é RED por comportamento (Grupo A):
// hoje `undoImport` faz 409 fail-closed no lote com pagamento de fatura, então
// `getAccountView` nunca volta ao baseline.
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
  seedStatementImport,
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-atom-tenant";
const PESSOAL = "iul-atom-pessoal";
const CARD = "4300";
const BANK = "8300";
const R = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.3 — undo-import atomicity (RED)", () => {
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
    const l = (setup as unknown as { importedInvoiceLiquidation?: { deleteMany: (a: unknown) => Promise<unknown> } }).importedInvoiceLiquidation;
    if (l) await l.deleteMany({ where: { tenantId: TENANT } });
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  async function counts() {
    return {
      expense: await setup.expense.count({ where: { tenantId: TENANT } }),
      cashFlow: await setup.cashFlowEntry.count({ where: { tenantId: TENANT } }),
      import: await setup.bankStatementImport.count({ where: { tenantId: TENANT } }),
      ledger: await (setup as unknown as { importedInvoiceLiquidation: { count: (a: unknown) => Promise<number> } }).importedInvoiceLiquidation.count({
        where: { tenantId: TENANT },
      }),
    };
  }

  it("falha forçada em recordImportedLiquidations aborta o commit inteiro: 0 Expense, 0 CashFlowEntry, 0 BankStatementImport, 0 ImportedInvoiceLiquidation, entries seguem PLANEJADO", async () => {
    const purchase = await seedInstallmentPurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD,
      parcelas: 1,
      valorCents: 30_000,
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });
    // força P2002: já existe uma liquidação ATIVA para a entry que o commit vai tocar
    await seedStatementImport(setup, { tenantId: TENANT, accountId, id: "pre-existing" });
    await (setup as unknown as {
      importedInvoiceLiquidation: { create: (a: unknown) => Promise<unknown> };
    }).importedInvoiceLiquidation.create({
      data: {
        tenantId: TENANT,
        paymentExpenseId: purchase.id,
        importId: "pre-existing",
        purchaseExpenseId: purchase.id,
        cashFlowEntryId: purchase.entryIds[0],
        cardId,
        prevStatus: "PLANEJADO",
        entryValorCents: 30_000,
        dueMonth: "2026-07",
      },
    });
    const before = await counts();
    await expect(
      commitStatement(bank, {
        tenantId: TENANT,
        projectId: PESSOAL,
        accountId,
        bankLast4: BANK,
        cardLast4: CARD,
        debitCents: 30_000,
        date: "20260630",
        period: "2026-06",
        requester: R,
      }),
    ).rejects.toThrow();
    const after = await counts();
    expect(after).toEqual({ ...before });
    const entry = await setup.cashFlowEntry.findUnique({ where: { id: purchase.entryIds[0] } });
    expect(entry?.status).toBe("PLANEJADO");
  });

  // Removidos desta branch (PR 1): os 2 `it` que exercitam `undoImport` revertendo
  // via ledger ("falha forçada no update de uma entry no meio" e "pagar-por-import →
  // undoImport devolve getAccountView ao baseline"). Ambos vivem inteiros em
  // `test/569-pr2-red`. Undo via ledger é PR 2.

  it("regression: lote sem pagamento de fatura continua ConflictException-free e reversível", async () => {
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK,
      debitCents: 4_299,
      date: "20260615",
      period: "2026-06",
      memo: "MERCADO BOM PRECO",
      requester: R,
    });
    const undo = await bank.undoImport(TENANT, PESSOAL, accountId, commit.importId, R);
    expect(undo).toMatchObject({ ok: true });
  });
});
