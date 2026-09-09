// #569 §6.5 — ACL por participante cross-project + `requester` em `getImportDetail`.
// Grupo A (RED por comportamento): hoje `getImportDetail(tenantId, projectId, accountId, importId)`
// NÃO recebe `requester` (controller `bank-account.controller.ts:71` sem `@CurrentUser`)
// e `undoImport` só chama `findAccount` (acesso de CONTA), sem ACL das COMPRAS
// cross-project. Alguns `it` também dependem do schema aditivo (Grupo B) para semear
// a trilha — depende do PR 1 (degrau), §3.3.1; NÃO aplicar migration nesta rodada.
import { PrismaClient } from "@prisma/client";
import { NotFoundException } from "@nestjs/common";
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
  seedProject,
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-authz-tenant";
const PESSOAL = "iul-authz-pessoal";
const REFORMA = "iul-authz-reforma";
const CARD = "4500";
const BANK = "8500";
const PESSOAL_ONLY = pessoalRequester(PESSOAL);
const ADMIN = { role: "ADMIN" as const };

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.5 — undo-import authz (RED)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let accountId: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    await seedProject(setup, { tenantId: TENANT, projectId: REFORMA, type: "REFORMA", name: "Reforma" });
    // cartão compartilhado: pertence a PESSOAL, mas há compra de REFORMA no mesmo last4
    await seedCardWithClosingDue(setup, { tenantId: TENANT, projectId: PESSOAL, last4: CARD, closingDay: 20, dueDay: 1 });
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

  async function importWithReformaPurchase() {
    await seedInstallmentPurchase(setup, {
      tenantId: TENANT, projectId: REFORMA, cardLast4: CARD, parcelas: 1, valorCents: 30_000,
      primeiraData: new Date("2026-07-01T12:00:00.000Z"),
    });
    const commit = await commitStatement(bank, {
      tenantId: TENANT, projectId: PESSOAL, accountId, bankLast4: BANK, cardLast4: CARD,
      debitCents: 30_000, date: "20260630", period: "2026-06", requester: PESSOAL_ONLY,
    });
    return commit.importId;
  }

  const detailCall = (requester: unknown) =>
    (bank as unknown as { getImportDetail: (...a: unknown[]) => Promise<Record<string, unknown>> })
      .getImportDetail(TENANT, PESSOAL, accountId, importIdRef, requester);

  let importIdRef: string;

  it("getImportDetail agora exige requester (controller passa @CurrentUser); requester sem acesso à conta → 404", async () => {
    importIdRef = await importWithReformaPurchase();
    const stranger = pessoalRequester("outro-pessoal");
    await expect(detailCall(stranger)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('undoImport: compra liquidada pertence a projeto REFORMA que o requester NÃO pode ver → 404 "Fatura não encontrada", zero escrita', async () => {
    const importId = await importWithReformaPurchase();
    const before = await setup.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } });
    await expect(
      bank.undoImport(TENANT, PESSOAL, accountId, importId, PESSOAL_ONLY),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await setup.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("getImportDetail: mesma revalidação — canUndo:false + blockReason quando requester não vê um participante", async () => {
    importIdRef = await importWithReformaPurchase();
    const detail = await detailCall(PESSOAL_ONLY);
    expect(detail.canUndo).toBe(false);
    expect(detail.blockReason ?? (detail as Record<string, unknown>).blockingReason).toBeDefined();
  });

  it("ADMIN vê todos os participantes → canUndo:true", async () => {
    importIdRef = await importWithReformaPurchase();
    const detail = await detailCall(ADMIN);
    expect(detail.canUndo).toBe(true);
  });
});
