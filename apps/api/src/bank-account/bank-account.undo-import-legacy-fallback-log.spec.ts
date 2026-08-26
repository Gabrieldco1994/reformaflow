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
 * Issue #569 (fase 2) — decisão de produto 2.
 *
 * Faturas de PAGAMENTO_FATURA_CARTAO gravadas ANTES deste campo existir não
 * têm `settledInvoiceKey`. `undoImport` continua revertendo essas faturas
 * LEGADAS pelo fallback antigo (mês do pagamento) — mas esse caminho tem que
 * LOGAR `warn` toda vez que for usado (condição não-negociável do PO), para
 * poder ser rastreado se o volume crescer ou o bug reaparecer.
 *
 * Este spec cobre APENAS o log — o comportamento funcional do fallback já é
 * espelho do que existia antes do #569 e não é o alvo de M1/M2.
 */
describe("BankAccountService — log do fallback legado em undoImport (issue #569, fase 2)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;
  let cardSettlement: CardInvoiceSettlementService;

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
  let warnSpy: jest.SpyInstance;

  async function cleanup(): Promise<void> {
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
    await setupPrisma.creditCard.create({
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
    cardSettlement = new CardInvoiceSettlementService(prisma);
    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      cardSettlement,
    );
  });

  beforeEach(() => {
    warnSpy = jest.spyOn((service as unknown as { logger: { warn: (msg: string) => void } }).logger, "warn");
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

  it("undoImport, ao encontrar PAGAMENTO_FATURA_CARTAO sem settledInvoiceKey, cai no fallback legado e LOGA warn com o id do pagamento, o cardLast4 e a fatura derivada", async () => {
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

    // Pagamento LEGADO: sem `settledInvoiceKey` — simula despesa gravada
    // antes deste campo existir (o import atual sempre preenche a chave
    // quando a liquidação por vencimento resolve uma fatura).
    const paymentDate = new Date("2026-06-28T12:00:00.000Z");
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
        dataPagamento: paymentDate,
        status: "PAGO",
        cardLast4: LAST4,
        bankLast4: "9013",
        accountId,
        importId,
        origin: "import",
        settledInvoiceKey: null,
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
        data: paymentDate,
        categoria: "Pagamento de fatura",
        formaPagamento: "A_VISTA",
        status: "PAGO",
      },
    });

    await service.undoImport(TENANT, PESSOAL, accountId, importId, REQUESTER);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0];
    expect(message).toEqual(expect.stringContaining("payment-legacy"));
    expect(message).toEqual(expect.stringContaining(LAST4));
    // O fallback deriva a fatura pelo mês do PAGAMENTO (28/06 -> 2026-06).
    expect(message).toEqual(expect.stringContaining("2026-06"));
  });
});
