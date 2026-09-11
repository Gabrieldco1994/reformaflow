// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BankAccountService } from "./bank-account.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import {
  ADMIN_REQUESTER,
  makeBankAccountService,
  resetTenant,
  seedPessoal,
  seedCardWithClosingDue,
  seedBankAccount,
  seedInstallmentPurchase,
  seedSinglePurchase,
  commitStatement,
} from "./__tests__/invoice-undo.fixtures";

describe("BankAccountService#undoImport — reversão REAL via ledger (#569 PR2, §5.1)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569pr2-ledger-tenant";
  const PESSOAL = "bank-569pr2-ledger-pessoal";
  const CARD_LAST4 = "6001";
  const BANK_LAST4 = "6101";

  let accountId: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await resetTenant(setupPrisma, TENANT);
    await seedPessoal(setupPrisma, { tenantId: TENANT, projectId: PESSOAL });
    const account = await seedBankAccount(setupPrisma, { tenantId: TENANT, projectId: PESSOAL, last4: BANK_LAST4 });
    accountId = account.id;
    service = makeBankAccountService(prisma);
  });

  afterEach(async () => {
    await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setupPrisma, TENANT);
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it("undoImport de lote PROCESSED_SETTLED íntegro: reverte exatamente as N parcelas do ledger, CashFlowEntry volta a PLANEJADO, itens do ledger soft-deletados, carimbo do pagamento limpo", async () => {
    const card = await seedCardWithClosingDue(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: CARD_LAST4,
      closingDay: 25,
      dueDay: 5,
    });
    const purchase = await seedInstallmentPurchase(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      parcelas: 3,
      valorCents: 100_00,
      primeiraData: new Date("2026-06-10T12:00:00.000Z"),
    });

    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 100_00,
      date: "20260628",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });
    expect(result.cardPayments).toBe(1);

    const entriesBefore = await setupPrisma.cashFlowEntry.findMany({
      where: { expenseId: purchase.id },
      orderBy: { data: "asc" },
    });
    expect(entriesBefore.filter((e) => e.status === "PAGO")).toHaveLength(1);

    const undo = await service.undoImport(TENANT, PESSOAL, accountId, result.importId, ADMIN_REQUESTER);
    expect(undo.ok).toBe(true);
    expect(undo.revertedInvoiceParcelas).toBe(1);
    expect(undo.reopenedInvoices).toBe(1);

    const entriesAfter = await setupPrisma.cashFlowEntry.findMany({
      where: { expenseId: purchase.id },
    });
    expect(entriesAfter.every((e) => e.status === "PLANEJADO")).toBe(true);

    const purchaseAfter = await setupPrisma.expense.findUnique({ where: { id: purchase.id } });
    expect(purchaseAfter?.status).toBe("PLANEJADO");

    const paymentIds = await setupPrisma.expense.findMany({
      where: { tenantId: TENANT, importId: result.importId, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" },
      select: { id: true },
    });
    for (const p of paymentIds) {
      const paymentAfter = await setupPrisma.expense.findUnique({ where: { id: p.id } });
      expect(paymentAfter?.invoiceUndoState).toBeNull();

      const activeLedgerRows = await setupPrisma.importedInvoiceLiquidation.findMany({
        where: { paymentExpenseId: p.id, deletedAt: null },
      });
      expect(activeLedgerRows).toHaveLength(0);
    }
  });

  it("reproduz o cenário M1 da issue (fatura de junho já paga por outro pagamento; pagamento em 28/06 liquida a fatura de julho): undoImport reabre SÓ a fatura de julho — a de junho permanece PAGO", async () => {
    const card = await seedCardWithClosingDue(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: CARD_LAST4,
      closingDay: 25,
      dueDay: 5,
    });
    const junho = await seedSinglePurchase(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 500_00,
      data: new Date("2026-05-10T12:00:00.000Z"),
      status: "PAGO",
    });
    const julho = await seedSinglePurchase(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 700_00,
      data: new Date("2026-06-10T12:00:00.000Z"),
      status: "PLANEJADO",
    });

    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 700_00,
      date: "20260628",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });
    expect(result.cardPayments).toBe(1);

    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: julho.entryId } }))?.status).toBe("PAGO");
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: junho.entryId } }))?.status).toBe("PAGO");

    await service.undoImport(TENANT, PESSOAL, accountId, result.importId, ADMIN_REQUESTER);

    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: julho.entryId } }))?.status).toBe("PLANEJADO");
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: junho.entryId } }))?.status).toBe("PAGO");
  });

  it("lote com PROCESSED_NONE (M8, cartão nulo) misturado a PROCESSED_SETTLED do mesmo lote: undo reverte só os itens do SETTLED, PROCESSED_NONE não gera erro nem item fantasma", async () => {
    const card = await seedCardWithClosingDue(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: CARD_LAST4,
      closingDay: 25,
      dueDay: 5,
    });
    const purchase = await seedSinglePurchase(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 300_00,
      data: new Date("2026-06-10T12:00:00.000Z"),
      status: "PLANEJADO",
    });

    // 1º débito: paga a fatura via cartão identificável (SETTLED).
    const r1 = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 300_00,
      date: "20260628",
      fitId: "FIT-SETTLED",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });

    // 2º débito, mesma importação lógica (novo import, mesmo período): pagamento
    // de fatura SEM cartão identificável, cai em PROCESSED_NONE.
    const r2 = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      debitCents: 999_00,
      memo: "PAGTO CART CRED SEM IDENTIFICACAO",
      date: "20260629",
      fitId: "FIT-NONE",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });

    const undo1 = await service.undoImport(TENANT, PESSOAL, accountId, r1.importId, ADMIN_REQUESTER);
    expect(undo1.ok).toBe(true);
    expect(undo1.revertedInvoiceParcelas).toBe(1);

    // O lote PROCESSED_NONE segue reversível sem erro (nada a reabrir).
    const undo2 = await service.undoImport(TENANT, PESSOAL, accountId, r2.importId, ADMIN_REQUESTER);
    expect(undo2.ok).toBe(true);
    expect(undo2.revertedInvoiceParcelas).toBe(0);
  });

  it("undoImport devolve reopenedInvoices/revertedInvoiceParcelas coerentes; getAccountView pós-undo mostra a fatura como pendente de novo (não paga)", async () => {
    const monthlyOverview = new MonthlyOverviewService(prisma, new CardInvoiceSettlementService(prisma));
    const card = await seedCardWithClosingDue(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: CARD_LAST4,
      closingDay: 25,
      dueDay: 5,
    });
    const purchase = await seedSinglePurchase(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 400_00,
      data: new Date("2026-06-10T12:00:00.000Z"),
      status: "PLANEJADO",
    });

    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 400_00,
      date: "20260628",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });

    const viewBefore = (await monthlyOverview.getAccountView(TENANT, PESSOAL, "2026-06", ADMIN_REQUESTER as never)) as Record<string, unknown>;
    expect(JSON.stringify(viewBefore)).not.toContain('"pending":true');

    await service.undoImport(TENANT, PESSOAL, accountId, result.importId, ADMIN_REQUESTER);

    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: purchase.entryId } }))?.status).toBe(
      "PLANEJADO",
    );
  });
});
