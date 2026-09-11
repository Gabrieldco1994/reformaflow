// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

/**
 * #569 PR2 — cobertura de mutação ADICIONAL, item §2.c/§4.2 do contrato
 * (`docs/569-pr2-contract-and-red-spec.md`), reproduzindo o M2 literal da
 * issue: pagamento atrasado que a PRÉVIA identifica (deltaCents:0) mas que o
 * COMMIT (janela de 2 meses) não liquida. Antes desta decisão o resultado
 * exposto colapsava em `NO_SETTLEMENT` genérico — indistinguível de "nenhuma
 * fatura compatível" — escondendo do usuário que havia um candidato fora do
 * prazo automático. O contrato exige o quinto estado dedicado
 * `OUTSIDE_SETTLEMENT_WINDOW`, nunca um falso `SETTLED_BY_IMPORT`.
 *
 * Seed direto do estado pós-commit (compra NÃO liquidada + payment sem
 * carimbo de sucesso) — isola o teste na leitura de `getImportDetail`, sem
 * depender das heurísticas exatas de `rankCardCandidates`/`commitImport`.
 */
import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "./bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "../expense/rateio.types";

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "bank-569-pr2-window-state-tenant";
const PESSOAL = "bank-569-pr2-window-state-pessoal";
const BANK_LAST4 = "4321";

const REQUESTER: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["expenses", "creditCards", "bankAccounts"],
};

describe("BankAccountService.getImportDetail — OUTSIDE_SETTLEMENT_WINDOW (#569 PR2, M2 literal)", () => {
  let service: BankAccountService;
  let accountId: string;

  async function cleanup(): Promise<void> {
    await setupPrisma.importedInvoiceLiquidation.deleteMany({
      where: { tenantId: TENANT },
    });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({
      where: { tenantId: TENANT },
    });
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  }

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await setupPrisma.tenant.create({
      data: { id: TENANT, name: "Window state" },
    });
    await setupPrisma.project.create({
      data: { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
    });
    const account = await setupPrisma.bankAccount.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        nickname: "Conta",
        last4: BANK_LAST4,
      },
    });
    accountId = account.id;
    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it(// Fatura de maio, cartão fecha 25/vence 5. Pagamento em 30/06/2026 (payMonth
  // 2026-06, janela do commit {2026-06,2026-07}): maio fica de fora — o
  // commit não liquida nada (NO_SETTLEMENT de fato), mas a prévia já tinha
  // identificado o candidato de maio com deltaCents:0. O contrato exige
  // que `getImportDetail` NÃO devolva `NO_SETTLEMENT` genérico aqui — tem
  // que devolver o estado dedicado, para a UI oferecer confirmação manual
  // em vez de fingir "nenhuma fatura compatível".
  "pagamento atrasado (~2 meses) casa fatura de maio na prévia mas commit não liquida: settlement[].state === OUTSIDE_SETTLEMENT_WINDOW, nunca NO_SETTLEMENT nem SETTLED_BY_IMPORT", async () => {
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão M2",
        last4: "1234",
        closingDay: 25,
        dueDay: 5,
      },
    });
    const VALUE = 700_000;
    // Compra de abril que fecha a fatura de maio, NUNCA liquidada.
    const purchase = await setupPrisma.expense.create({
      data: {
        id: "id-m2-purchase-may",
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: "Compra fatura maio",
        valor: VALUE,
        quantidade: 1,
        valorTotal: VALUE,
        formaPagamento: "A_VISTA",
        dataCompra: new Date("2026-04-10T12:00:00.000Z"),
        dataPagamento: new Date("2026-04-10T12:00:00.000Z"),
        status: "PLANEJADO",
        cardLast4: "1234",
        paidParcelas: null,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: "id-m2-entry-may",
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: purchase.id,
        valor: VALUE,
        tipo: "DESPESA",
        data: new Date("2026-04-10T12:00:00.000Z"),
        categoria: "OUTROS",
        formaPagamento: "CARTAO_CREDITO",
        status: "PLANEJADO",
      },
    });

    const importRecord = await setupPrisma.bankStatementImport.create({
      data: {
        tenantId: TENANT,
        accountId,
        periodLabel: "2026-06",
        source: "OFX",
        inserted: 0,
        totalAmountCents: VALUE,
      },
    });
    // O commit rodou e NÃO achou fatura dentro da janela de 2 meses
    // (payMonth=2026-06 ⇒ {2026-06,2026-07}) — carimbo PROCESSED_NONE,
    // cardId ainda assim identificado (não é o caso M8 de cartão nulo).
    await setupPrisma.expense.create({
      data: {
        id: "id-m2-payment",
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "Pagamento fatura (M2)",
        valor: VALUE,
        quantidade: 1,
        valorTotal: VALUE,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-30T12:00:00.000Z"),
        status: "PAGO",
        cardLast4: "1234",
        bankLast4: BANK_LAST4,
        accountId,
        importId: importRecord.id,
        origin: "import",
        invoiceUndoState: "PROCESSED_NONE",
        invoiceUndoParcelaCount: 0,
        invoiceUndoDueMonth: null,
        invoiceUndoCardId: card.id,
        invoiceUndoTrailVersion: 1,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: "id-m2-payment-entry",
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: "id-m2-payment",
        valor: VALUE,
        tipo: "DESPESA",
        data: new Date("2026-06-30T12:00:00.000Z"),
        categoria: "Pagamento de fatura",
        formaPagamento: "A_VISTA",
        status: "PAGO",
      },
    });

    const detail = (await service.getImportDetail(
      TENANT,
      PESSOAL,
      accountId,
      importRecord.id,
      REQUESTER as never,
    )) as unknown as {
      settlement: Array<{
        cardId: string | null;
        dueMonth: string | null;
        state: string;
      }>;
    };

    const entry = detail.settlement.find((s) => s.cardId === card.id);
    expect(entry).toBeDefined();
    expect(entry?.state).toBe("OUTSIDE_SETTLEMENT_WINDOW");
    expect(entry?.state).not.toBe("NO_SETTLEMENT");
    expect(entry?.state).not.toBe("SETTLED_BY_IMPORT");
    expect(entry?.dueMonth).toBe("2026-05");
  });
});
