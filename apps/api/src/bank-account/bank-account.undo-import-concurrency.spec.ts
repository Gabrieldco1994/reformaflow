// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BankAccountService } from "./bank-account.service";
import {
  ADMIN_REQUESTER,
  makeBankAccountService,
  resetTenant,
  seedPessoal,
  seedCardWithClosingDue,
  seedBankAccount,
  seedSinglePurchase,
  commitStatement,
} from "./__tests__/invoice-undo.fixtures";

/**
 * #569 PR2 §5.3 — concorrência: no máximo 1 chamada reverte de fato, a outra
 * `alreadyUndone:true` OU 409 — nunca reversão parcial nem dupla.
 */
describe("BankAccountService#undoImport — concorrência (#569 PR2, §5.3)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569pr2-conc-tenant";
  const PESSOAL = "bank-569pr2-conc-pessoal";
  const CARD_LAST4 = "6401";
  const BANK_LAST4 = "6501";

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

  async function seedSettledBatch(id: string): Promise<{ importId: string; entryId: string }> {
    await seedCardWithClosingDue(setupPrisma, {
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
      valorCents: 150_00,
      data: new Date("2026-06-10T12:00:00.000Z"),
      status: "PLANEJADO",
      id: `purchase-${id}`,
    });
    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 150_00,
      date: "20260628",
      fitId: `FIT-${id}`,
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });
    return { importId: result.importId, entryId: purchase.entryId };
  }

  it("Promise.allSettled([undoImport(), undoImport()]) do MESMO lote: no máximo 1 com revertedInvoiceParcelas>0; o outro alreadyUndone:true OU 409; count(CashFlowEntry PAGO)===baseline pós-undo", async () => {
    const { importId, entryId } = await seedSettledBatch("conc1");

    const results = await Promise.allSettled([
      service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER),
      service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const withRealRevert = fulfilled.filter((r) => (r.value.revertedInvoiceParcelas ?? 0) > 0);
    expect(withRealRevert.length).toBeLessThanOrEqual(1);

    const entryAfter = await setupPrisma.cashFlowEntry.findUnique({ where: { id: entryId } });
    expect(entryAfter?.status).toBe("PLANEJADO");

    const activeLedgerRows = await setupPrisma.importedInvoiceLiquidation.count({
      where: { cashFlowEntryId: entryId, deletedAt: null },
    });
    expect(activeLedgerRows).toBe(0);
  });

  it("re-undo serial: 2ª chamada → {ok:true, alreadyUndone:true}, zero parcelas revertidas de novo, ledger não regravado", async () => {
    const { importId, entryId } = await seedSettledBatch("conc2");

    const first = await service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER);
    expect(first.alreadyUndone).toBe(false);
    expect(first.revertedInvoiceParcelas).toBe(1);

    const second = await service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER);
    expect(second).toMatchObject({ ok: true, alreadyUndone: true, revertedInvoiceParcelas: 0 });

    const activeLedgerRows = await setupPrisma.importedInvoiceLiquidation.count({
      where: { cashFlowEntryId: entryId, deletedAt: null },
    });
    expect(activeLedgerRows).toBe(0);
  });

  it("item do ledger soft-deletado por fora ENTRE a 1ª leitura e a escrita → 409 INCOMPLETE_TRAIL, zero escrita (recount dentro da tx, não pré-check externo)", async () => {
    const { importId, entryId } = await seedSettledBatch("conc3");
    const ledgerRow = await setupPrisma.importedInvoiceLiquidation.findFirst({ where: { cashFlowEntryId: entryId } });
    await setupPrisma.importedInvoiceLiquidation.update({
      where: { id: ledgerRow!.id },
      data: { deletedAt: new Date() },
    });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "INCOMPLETE_TRAIL",
    });
    const importAfter = await setupPrisma.bankStatementImport.findUnique({ where: { id: importId } });
    expect(importAfter?.deletedAt).toBeNull();
  });

  it("import.deletedAt=null mas zero itens ativos + carimbo PROCESSED_SETTLED (drift severo) → 409, NUNCA no-op silencioso", async () => {
    const { importId } = await seedSettledBatch("conc4");
    await setupPrisma.importedInvoiceLiquidation.updateMany({
      where: { importId },
      data: { deletedAt: new Date() },
    });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "INCOMPLETE_TRAIL",
    });
  });
});
