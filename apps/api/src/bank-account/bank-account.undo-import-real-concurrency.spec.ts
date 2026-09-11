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
 * Achado #6 (security-tenant-lens SEC-4) — os testes de concorrência
 * existentes (`undo-import.test.ts`, `bank-account.undo-import-concurrency.spec.ts`)
 * usam `Promise.allSettled`, que não garante o mesmo grau de disparo
 * verdadeiramente simultâneo que `Promise.all` sobre duas chamadas SEM
 * `await` entre elas. Este teste dispara `Promise.all` de fato simultâneo
 * para o MESMO `importId` e confirma: exatamente UMA reversão real ocorre
 * (soma de `revertedInvoiceParcelas` bate uma vez só), nenhuma duplicação no
 * ledger, e nenhum erro NÃO TRATADO escapa do teste (a segunda chamada pode
 * legitimamente rejeitar com 409/`alreadyUndone`, mas o teste sempre captura
 * o resultado das duas promises).
 *
 * Reforça a correção de `bank-account.service.ts` — o soft-delete final do
 * registro de importação virou `updateMany({where:{id, deletedAt:null}})`
 * com checagem de linhas afetadas, em vez de um `update` incondicional que
 * confiava na serialização implícita do SQLite.
 */
describe("BankAccountService#undoImport — Promise.all verdadeiramente simultâneo no MESMO importId (#6)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569-real-concurrency-tenant";
  const PESSOAL = "bank-569-real-concurrency-pessoal";
  const CARD_LAST4 = "8801";
  const BANK_LAST4 = "8802";

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

  it("Promise.all([undoImport(), undoImport()]) simultâneo: exatamente 1 reversão real, sem duplicação de ledger, sem erro não tratado", async () => {
    const { importId, entryId } = await seedSettledBatch("real-conc1");

    // `Promise.all` de fato, mas cada braço captura seu próprio erro — o
    // teste NUNCA deixa uma rejeição escapar sem tratamento (uma das duas
    // chamadas pode legitimamente perder a corrida com 409/ConflictException
    // ou responder alreadyUndone:true).
    const [a, b] = await Promise.all([
      service
        .undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)
        .then((value) => ({ ok: true as const, value }))
        .catch((error) => ({ ok: false as const, error })),
      service
        .undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER)
        .then((value) => ({ ok: true as const, value }))
        .catch((error) => ({ ok: false as const, error })),
    ]);

    const outcomes = [a, b];
    const successfulReverts = outcomes.filter(
      (o) => o.ok && (o.value.revertedInvoiceParcelas ?? 0) > 0,
    );
    // Exatamente 1 reversão REAL — nunca 0 (perdida) nem 2 (duplicada).
    expect(successfulReverts.length).toBe(1);

    // A soma total de parcelas revertidas nunca duplica.
    const totalRevertedParcelas = outcomes.reduce(
      (sum, o) => sum + (o.ok ? o.value.revertedInvoiceParcelas ?? 0 : 0),
      0,
    );
    expect(totalRevertedParcelas).toBe(1);

    // O outro braço: ou alreadyUndone:true, ou rejeitou com erro tratado
    // (409/ConflictException) — nunca uma segunda reversão silenciosa.
    const other = outcomes.find((o) => o !== successfulReverts[0]);
    if (other?.ok) {
      expect(other.value.alreadyUndone).toBe(true);
      expect(other.value.revertedInvoiceParcelas ?? 0).toBe(0);
    } else if (other && !other.ok) {
      expect(other.error).toBeInstanceOf(Error);
    }

    // Estado final: parcela reaberta exatamente uma vez, ledger sem sobra ativa.
    const entryAfter = await setupPrisma.cashFlowEntry.findUnique({ where: { id: entryId } });
    expect(entryAfter?.status).toBe("PLANEJADO");
    const activeLedgerRows = await setupPrisma.importedInvoiceLiquidation.count({
      where: { cashFlowEntryId: entryId, deletedAt: null },
    });
    expect(activeLedgerRows).toBe(0);

    const importRow = await setupPrisma.bankStatementImport.findUnique({ where: { id: importId } });
    expect(importRow?.deletedAt).not.toBeNull();
  });
});
