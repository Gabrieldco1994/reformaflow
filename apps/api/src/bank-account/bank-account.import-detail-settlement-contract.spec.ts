// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BankAccountService } from "./bank-account.service";
import { rankCardCandidates } from "./card-invoice-match";
import {
  ADMIN_REQUESTER,
  pessoalRequester,
  makeBankAccountService,
  resetTenant,
  seedPessoal,
  seedCardWithClosingDue,
  seedBankAccount,
  seedSinglePurchase,
  commitStatement,
} from "./__tests__/invoice-undo.fixtures";

/**
 * #569 PR2 §5.4 — `getImportDetail.settlement[]`: requester obrigatório,
 * identidade por `cardId` (nunca `last4`), `OUTSIDE_SETTLEMENT_WINDOW`
 * distinto de `NO_SETTLEMENT`, ACL de ocultação total.
 */
describe("BankAccountService#getImportDetail — settlement contract (#569 PR2, §5.4)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569pr2-detail-tenant";
  const PESSOAL = "bank-569pr2-detail-pessoal";
  const CARD_LAST4 = "6601";
  const CARD_LAST4_OTHER = "6601"; // mesmo last4, cartão distinto (identidade por cardId)
  const BANK_LAST4 = "6701";

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

  it("getImportDetail exige requester; sem requester → erro de guarda, nunca 200 silencioso", async () => {
    await expect(
      (service as unknown as { getImportDetail: (...args: unknown[]) => Promise<unknown> }).getImportDetail(
        TENANT,
        PESSOAL,
        accountId,
        "any-import-id",
        undefined,
      ),
    ).rejects.toBeTruthy();
  });

  it("cartão identificado, nenhuma parcela liquidada → settlement[].state === NO_SETTLEMENT, cardId preenchido, canUndo:true", async () => {
    const card = await seedCardWithClosingDue(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: CARD_LAST4,
      closingDay: 25,
      dueDay: 5,
    });
    // Nenhuma compra em aberto casável — o pagamento não liquida nada.
    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: CARD_LAST4,
      debitCents: 999_00,
      date: "20260628",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, result.importId, ADMIN_REQUESTER);
    expect(detail.canUndo).toBe(true);
    const entry = (detail as any).settlement.find((s: any) => s.cardId === card.id);
    expect(entry).toBeTruthy();
    expect(entry.state).toBe("NO_SETTLEMENT");
  });

  it("pagamento sem cartão identificado (M8, PROCESSED_NONE, cardId NULL) → não bloqueia canUndo do lote", async () => {
    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      debitCents: 555_00,
      memo: "PAGTO CART CRED SEM IDENTIFICACAO",
      date: "20260628",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, result.importId, ADMIN_REQUESTER);
    expect(detail.canUndo).toBe(true);
    const anyLegacyNoTrail = (detail as any).settlement.some((s: any) => s.state === "LEGACY_NO_TRAIL");
    expect(anyLegacyNoTrail).toBe(false);
  });

  it("requester sem ACL num projeto participante → a entrada de settlement correspondente NÃO aparece no array", async () => {
    const card = await seedCardWithClosingDue(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: "6801",
      closingDay: 25,
      dueDay: 5,
    });
    const purchase = await seedSinglePurchase(setupPrisma, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: "6801",
      valorCents: 200_00,
      data: new Date("2026-06-10T12:00:00.000Z"),
      status: "PLANEJADO",
    });
    const result = await commitStatement(service, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK_LAST4,
      cardLast4: "6801",
      debitCents: 200_00,
      date: "20260628",
      fitId: "FIT-ACL",
      period: "2026-06",
      requester: ADMIN_REQUESTER,
    });

    const noAccessRequester = pessoalRequester("outro-projeto-inexistente");
    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, result.importId, noAccessRequester);
    expect((detail as any).settlement).toEqual([]);
  });

  it("preview: candidato de rankCardCandidates com dueMonth fora de {payMonth,payMonth+1} → windowState OUTSIDE_SETTLEMENT_WINDOW; dentro → WITHIN_SETTLEMENT_WINDOW", () => {
    const utc = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
    const within = rankCardCandidates(
      [{ last4: "1111", nickname: "n", closingDay: null, dueDay: 5, entries: [{ data: utc("2026-08-10"), valor: 100_00 }] }],
      100_00,
      utc("2026-07-15"),
    );
    expect(within[0].windowState).toBe("WITHIN_SETTLEMENT_WINDOW");

    const outside = rankCardCandidates(
      [{ last4: "2222", nickname: "n", closingDay: null, dueDay: 5, entries: [{ data: utc("2026-05-10"), valor: 100_00 }] }],
      100_00,
      utc("2026-06-30"),
    );
    expect(outside[0].windowState).toBe("OUTSIDE_SETTLEMENT_WINDOW");
  });

  it("corte por createdAt removido: despesa adotada na dedup (createdAt anterior ao import) aparece no impact igual a uma criada pelo import", async () => {
    const imp = await setupPrisma.bankStatementImport.create({
      data: { tenantId: TENANT, accountId, periodLabel: "2026-06", source: "OFX" },
    });
    await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: "Adotada na dedup",
        valor: 10_00,
        quantidade: 1,
        valorTotal: 10_00,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        importId: imp.id,
        createdAt: new Date(imp.createdAt.getTime() - 999_999),
      },
    });

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, imp.id, ADMIN_REQUESTER);
    expect(detail.impact.expenses).toBe(1);
  });
});
