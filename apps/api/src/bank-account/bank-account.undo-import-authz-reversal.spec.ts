// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BankAccountService } from "./bank-account.service";
import type { RateioRequester } from "../expense/rateio.types";
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
 * #569 PR2 §5.5 — ACL de ESCRITA no undo real (distinto do ACL de leitura do
 * PR1): requester sem visibilidade da compra liquidada NUNCA reverte, mesmo
 * com trilha íntegra. Ocultação total: 404 "Fatura não encontrada".
 */
describe("BankAccountService#undoImport — ACL de escrita na reversão (#569 PR2, §5.5)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569pr2-authz-tenant";
  const PESSOAL = "bank-569pr2-authz-pessoal";
  const CARD_LAST4 = "6901";
  const BANK_LAST4 = "6902";

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

  async function seedSettledBatch(): Promise<{ importId: string; entryId: string }> {
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
      valorCents: 180_00,
      data: new Date("2026-06-10T12:00:00.000Z"),
      status: "PLANEJADO",
    });
    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 180_00,
      date: "20260628",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });
    return { importId: result.importId, entryId: purchase.entryId };
  }

  it("compra liquidada pertence a projeto que o requester não pode ver → undoImport 404 'Fatura não encontrada', zero escrita, mesmo com trilha íntegra", async () => {
    const { importId, entryId } = await seedSettledBatch();

    const noAccessRequester: RateioRequester = {
      role: "USER",
      allowedProjects: ["projeto-que-nao-existe"],
      allowedProjectTypes: ["REFORMA"],
      allowedModules: ["expenses"],
    };

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, noAccessRequester),
    ).rejects.toBeInstanceOf(NotFoundException);

    const entryAfter = await setupPrisma.cashFlowEntry.findUnique({ where: { id: entryId } });
    expect(entryAfter?.status).toBe("PAGO");
    const importAfter = await setupPrisma.bankStatementImport.findUnique({ where: { id: importId } });
    expect(importAfter?.deletedAt).toBeNull();
  });

  it("ADMIN vê todos os participantes → undoImport reverte normalmente (baseline positivo do guard ACL)", async () => {
    const { importId, entryId } = await seedSettledBatch();

    const undo = await service.undoImport(TENANT, PESSOAL, accountId, importId, ADMIN_REQUESTER);
    expect(undo.ok).toBe(true);
    expect(undo.revertedInvoiceParcelas).toBe(1);

    const entryAfter = await setupPrisma.cashFlowEntry.findUnique({ where: { id: entryId } });
    expect(entryAfter?.status).toBe("PLANEJADO");
  });
});
