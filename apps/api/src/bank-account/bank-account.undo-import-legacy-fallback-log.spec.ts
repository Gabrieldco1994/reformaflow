// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "./bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "../expense/rateio.types";

/**
 * issue #569 (fase 2) — decisão de produto para PAGAMENTO legado.
 *
 * Pagamentos de fatura criados por importações ANTERIORES ao ledger
 * (`ImportedCardInvoiceSettlement`) não têm registro do que moveram. Decisão do
 * PO: no undo NÃO recalcular/adivinhar `dueMonth`, NÃO tocar compras/parcelas
 * do cartão — só remover o pagamento com o lote, reportar
 * `notRevertibleInvoiceLiquidations` e LOGAR `warn` com `paymentExpenseId` e
 * `importId` (sem valores nem dados sensíveis).
 *
 * Cobre também o índice único parcial que impede duas reivindicações ativas
 * para a mesma parcela.
 */
describe("BankAccountService — pagamento legado e ledger (issue #569, fase 2)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;
  let warnSpy: jest.SpyInstance;

  const TENANT = "bank-569-legacy-tenant";
  const PESSOAL = "bank-569-legacy-pessoal";
  const LAST4 = "5692";
  const REQUESTER: RateioRequester = {
    role: "USER",
    allowedProjects: [PESSOAL],
    allowedProjectTypes: ["PESSOAL"],
    allowedModules: ["expenses", "creditCards"],
  };

  let accountId: string;
  let cardId: string;

  async function cleanup(): Promise<void> {
    await setupPrisma.importedCardInvoiceSettlementEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.importedCardInvoiceSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  }

  async function cleanupAll(): Promise<void> {
    await cleanup();
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  }

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await setupPrisma.tenant.create({ data: { id: TENANT, name: "Bank 569 legacy" } });
    await setupPrisma.project.create({
      data: { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
    });
    const account = await setupPrisma.bankAccount.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: "ITAU", nickname: "Conta 569 legacy", last4: "9013" },
    });
    accountId = account.id;
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão 569 legacy",
        last4: LAST4,
        closingDay: 25,
        dueDay: 5,
      },
    });
    cardId = card.id;
    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  beforeEach(() => {
    warnSpy = jest.spyOn(
      (service as unknown as { logger: { warn: (msg: string) => void } }).logger,
      "warn",
    );
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await cleanup();
  });

  afterAll(async () => {
    await cleanupAll();
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it("undoImport de pagamento SEM ledger: não toca a compra do cartão, reporta notRevertible e loga warn com paymentExpenseId + importId", async () => {
    // Compra PLANEJADO cuja parcela ficou PAGO por um pagamento legado.
    await setupPrisma.expense.create({
      data: {
        id: "purchase-legacy",
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: "Compra legado",
        valor: 100_000,
        quantidade: 1,
        valorTotal: 100_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-10T12:00:00.000Z"),
        status: "PLANEJADO",
        cardLast4: LAST4,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: "purchase-legacy-entry",
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: "purchase-legacy",
        valor: 100_000,
        tipo: "DESPESA",
        data: new Date("2026-06-10T12:00:00.000Z"),
        categoria: "OUTROS",
        formaPagamento: "A_VISTA",
        status: "PAGO",
      },
    });

    const importId = "import-569-legacy";
    await setupPrisma.bankStatementImport.create({
      data: {
        id: importId,
        tenantId: TENANT,
        accountId,
        periodLabel: "2026-06",
        source: "OFX",
        inserted: 1,
        totalAmountCents: 100_000,
      },
    });
    // Pagamento legado: importId preenchido, SEM linha no ledger.
    await setupPrisma.expense.create({
      data: {
        id: "payment-legacy",
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "Pagamento fatura",
        valor: 100_000,
        quantidade: 1,
        valorTotal: 100_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-28T12:00:00.000Z"),
        status: "PAGO",
        cardLast4: LAST4,
        bankLast4: "9013",
        accountId,
        importId,
        origin: "import",
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: "payment-legacy-entry",
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: "payment-legacy",
        valor: 100_000,
        tipo: "DESPESA",
        data: new Date("2026-06-28T12:00:00.000Z"),
        categoria: "Pagamento de fatura",
        formaPagamento: "A_VISTA",
        status: "PAGO",
      },
    });

    const result = await service.undoImport(TENANT, PESSOAL, accountId, importId, REQUESTER);

    expect(result.notRevertedInvoiceLiquidations).toBe(1);
    expect(result.revertedInvoiceParcelas).toBe(0);
    // A parcela da compra do cartão NÃO foi tocada (decisão do PO).
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-legacy-entry" } }))?.status).toBe("PAGO");
    expect((await setupPrisma.expense.findUnique({ where: { id: "purchase-legacy" } }))?.deletedAt).toBeNull();

    const legacyWarns = warnSpy.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes("sem ledger"));
    expect(legacyWarns).toHaveLength(1);
    expect(legacyWarns[0]).toContain("payment-legacy");
    expect(legacyWarns[0]).toContain(importId);
    // Sem valores nem dados sensíveis.
    expect(legacyWarns[0]).not.toContain("100000");
  });

  it("getImportDetail: pagamento sem ledger conta como notRevertibleInvoiceLiquidations, não como liquidação", async () => {
    const importId = "import-569-legacy-detail";
    await setupPrisma.bankStatementImport.create({
      data: { id: importId, tenantId: TENANT, accountId, periodLabel: "2026-06", source: "OFX", inserted: 1, totalAmountCents: 100_000 },
    });
    await setupPrisma.expense.create({
      data: {
        id: "payment-legacy-detail",
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "Pagamento fatura",
        valor: 100_000,
        quantidade: 1,
        valorTotal: 100_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-28T12:00:00.000Z"),
        status: "PAGO",
        cardLast4: LAST4,
        accountId,
        importId,
        origin: "import",
      },
    });

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, importId);
    expect(detail.impact.invoiceLiquidations).toBe(0);
    expect(detail.irreversible.notRevertibleInvoiceLiquidations).toBe(1);
  });

  it("índice único parcial: duas reivindicações ATIVAS para a mesma parcela são impossíveis", async () => {
    const entry = await setupPrisma.cashFlowEntry.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        valor: 1,
        tipo: "DESPESA",
        data: new Date("2026-06-10T12:00:00.000Z"),
        categoria: "OUTROS",
        status: "PAGO",
      },
    });
    async function makeSettlement(id: string) {
      const payment = await setupPrisma.expense.create({
        data: {
          id,
          tenantId: TENANT,
          projectId: PESSOAL,
          tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
          titulo: "p",
          valor: 1,
          quantidade: 1,
          valorTotal: 1,
          formaPagamento: "A_VISTA",
          status: "PAGO",
        },
      });
      const bankImport = await setupPrisma.bankStatementImport.create({
        data: { tenantId: TENANT, accountId, periodLabel: "2026-06", source: "OFX" },
      });
      return setupPrisma.importedCardInvoiceSettlement.create({
        data: {
          tenantId: TENANT,
          bankStatementImportId: bankImport.id,
          paymentExpenseId: payment.id,
          cardId,
          cardProjectId: PESSOAL,
          strategy: "DUE_MONTH",
        },
      });
    }
    const a = await makeSettlement("dup-a");
    const b = await makeSettlement("dup-b");
    await setupPrisma.importedCardInvoiceSettlementEntry.create({
      data: { tenantId: TENANT, settlementId: a.id, cashFlowEntryId: entry.id },
    });
    await expect(
      setupPrisma.importedCardInvoiceSettlementEntry.create({
        data: { tenantId: TENANT, settlementId: b.id, cashFlowEntryId: entry.id },
      }),
    ).rejects.toThrow();

    // Mas depois de liberar a primeira, a segunda pode reivindicar.
    await setupPrisma.importedCardInvoiceSettlementEntry.updateMany({
      where: { settlementId: a.id },
      data: { releasedAt: new Date() },
    });
    await expect(
      setupPrisma.importedCardInvoiceSettlementEntry.create({
        data: { tenantId: TENANT, settlementId: b.id, cashFlowEntryId: entry.id },
      }),
    ).resolves.toBeTruthy();
  });
});
