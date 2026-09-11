// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BankAccountService } from "./bank-account.service";
import {
  ADMIN_REQUESTER,
  makeBankAccountService,
  resetTenant,
  seedPessoal,
  seedProject,
  seedCardWithClosingDue,
  seedBankAccount,
  seedSinglePurchase,
  commitStatement,
} from "./__tests__/invoice-undo.fixtures";

/**
 * #569 PR2 §5.2 — DRIFT: undo NUNCA reverte parcialmente um item cujo estado
 * do ledger não bate com o que o commit gravou. Toda-ou-nada: ZERO escrita
 * quando qualquer drift é detectado, ANTES do 1º write.
 */
describe("BankAccountService#undoImport — DRIFT (#569 PR2, §5.2)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569pr2-drift-tenant";
  const PESSOAL = "bank-569pr2-drift-pessoal";
  const CARD_LAST4 = "6201";
  const BANK_LAST4 = "6301";

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

  async function seedSettledBatch(): Promise<{ importId: string; purchaseId: string; entryId: string }> {
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
      valorCents: 250_00,
      data: new Date("2026-06-10T12:00:00.000Z"),
      status: "PLANEJADO",
    });
    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 250_00,
      date: "20260628",
      fitId: `FIT-${purchase.id}`,
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });
    return { importId: result.importId, purchaseId: purchase.id, entryId: purchase.entryId };
  }

  async function assertZeroWrite(importId: string): Promise<void> {
    const importBefore = await setupPrisma.bankStatementImport.findUnique({ where: { id: importId } });
    expect(importBefore?.deletedAt).toBeNull();
  }

  it("parcela do ledger com CashFlowEntry status !== PAGO (revertida por fora) → 409 DRIFT:ENTRY_NOT_PAID, zero escrita", async () => {
    const { importId, entryId } = await seedSettledBatch();
    await setupPrisma.cashFlowEntry.update({ where: { id: entryId }, data: { status: "PLANEJADO" } });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "DRIFT:ENTRY_NOT_PAID",
    });
    await assertZeroWrite(importId);
  });

  it("parcela do ledger cuja CashFlowEntry foi soft-deletada (compra excluída) → 409 DRIFT:ENTRY_DELETED, zero escrita", async () => {
    const { importId, entryId } = await seedSettledBatch();
    await setupPrisma.cashFlowEntry.update({ where: { id: entryId }, data: { deletedAt: new Date() } });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "DRIFT:ENTRY_DELETED",
    });
    await assertZeroWrite(importId);
  });

  it("valor da entry mudou desde o flip (PATCH da compra) → 409 DRIFT:AMOUNT_CHANGED, zero escrita", async () => {
    const { importId, entryId } = await seedSettledBatch();
    await setupPrisma.cashFlowEntry.update({ where: { id: entryId }, data: { valor: 999_00 } });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "DRIFT:AMOUNT_CHANGED",
    });
    await assertZeroWrite(importId);
  });

  it("parcela mudou (reparcelamento/rateio) desde o flip → 409 DRIFT:PARCELA_CHANGED, zero escrita", async () => {
    const { importId, entryId } = await seedSettledBatch();
    await setupPrisma.cashFlowEntry.update({ where: { id: entryId }, data: { parcela: "9/9" } });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "DRIFT:PARCELA_CHANGED",
    });
    await assertZeroWrite(importId);
  });

  it("compra ganhou settledByExpenseId por adoção manual planejada→paga após o flip → 409 DRIFT:MANUAL_ADOPTION, zero escrita", async () => {
    const { importId, purchaseId } = await seedSettledBatch();
    const other = await seedSinglePurchase(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD_LAST4,
      valorCents: 1,
      data: new Date("2026-06-11T12:00:00.000Z"),
      status: "PAGO",
      id: "manual-adoption-payer",
    });
    await setupPrisma.expense.update({ where: { id: purchaseId }, data: { settledByExpenseId: other.id } });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "DRIFT:MANUAL_ADOPTION",
    });
    await assertZeroWrite(importId);
  });

  it("compra tem RateioAllocation cujo schedule diverge do snapshot do item → 409 DRIFT:RATEIO_MISMATCH, zero escrita", async () => {
    const { importId, purchaseId } = await seedSettledBatch();
    await seedProject(setupPrisma, { tenantId: TENANT, projectId: `${PESSOAL}-reforma`, type: "REFORMA", name: "Reforma" });
    const target = await seedSinglePurchase(setupPrisma, {
      tenantId: TENANT,
      projectId: `${PESSOAL}-reforma`,
      cardLast4: "",
      valorCents: 250_00,
      data: new Date("2026-06-10T12:00:00.000Z"),
      status: "PLANEJADO",
      id: "rateio-target",
    });
    await setupPrisma.rateioAllocation.create({
      data: {
        tenantId: TENANT,
        sourceExpenseId: purchaseId,
        targetExpenseId: target.id,
        allocation: 250_00,
        plannedStatus: "PLANEJADO",
      },
    });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "DRIFT:RATEIO_MISMATCH",
    });
    await assertZeroWrite(importId);
  });

  it("itens ativos != invoiceUndoParcelaCount (item removido por fora) → 409 INCOMPLETE_TRAIL, zero escrita", async () => {
    const { importId, entryId } = await seedSettledBatch();
    const ledgerRow = await setupPrisma.importedInvoiceLiquidation.findFirst({ where: { cashFlowEntryId: entryId } });
    expect(ledgerRow).toBeTruthy();
    await setupPrisma.importedInvoiceLiquidation.update({
      where: { id: ledgerRow!.id },
      data: { deletedAt: new Date() },
    });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "INCOMPLETE_TRAIL",
    });
    await assertZeroWrite(importId);
  });

  it("pagamento manual (importId NULL) casado à MESMA fatura do carimbo, via settlesInvoiceKey → 409 MANUAL_PAYMENT_OVERLAP, zero escrita", async () => {
    const { importId } = await seedSettledBatch();
    const payment = await setupPrisma.expense.findFirst({
      where: { tenantId: TENANT, importId, tipoDespesa: "PAGAMENTO_FATURA_CARTAO" },
    });
    expect(payment?.invoiceUndoCardId).toBeTruthy();
    expect(payment?.invoiceUndoDueMonth).toBeTruthy();

    await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "Pagamento manual da mesma fatura",
        valor: 250_00,
        quantidade: 1,
        valorTotal: 250_00,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-29T12:00:00.000Z"),
        status: "PAGO",
        importId: null,
        settlesInvoiceKey: `m1:${payment!.invoiceUndoCardId}:${CARD_LAST4}:${payment!.invoiceUndoDueMonth}`,
      },
    });

    await expect(service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)).rejects.toMatchObject({
      message: "MANUAL_PAYMENT_OVERLAP",
    });
    await assertZeroWrite(importId);
  });
});
