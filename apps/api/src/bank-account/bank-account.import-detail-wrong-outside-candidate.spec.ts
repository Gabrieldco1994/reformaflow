// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

/**
 * Achado #2 (journey-qa) — `getImportDetail` (bank-account.service.ts:~1493)
 * escolhia o PRIMEIRO candidato `OUTSIDE_SETTLEMENT_WINDOW` da lista ranqueada
 * de `rankCardCandidates`, sem checar se existia um candidato WITHIN melhor
 * (mais próximo do valor pago). `rankCardCandidates` já devolve a lista
 * ORDENADA por menor |delta| primeiro — o mesmo critério que a prévia real
 * usaria — então o candidato correto é sempre `candidates[0]`.
 *
 * Repro: duas faturas do MESMO cartão — uma DENTRO da janela de liquidação
 * (`{payMonth, payMonth+1}`) que fecha o valor pago EXATAMENTE (melhor
 * candidato), e outra FORA da janela com valor bem diferente (pior candidato,
 * mas que aparecia antes na varredura ingênua). O pagamento foi carimbado
 * `PROCESSED_NONE` (nenhuma liquidação real ocorreu). O resultado NUNCA pode
 * apontar a fatura de fora (que não corresponde de verdade a este pagamento):
 * ou aponta a fatura WITHIN (se ela fosse a `OUTSIDE` reportada, mas aqui ela é
 * WITHIN) — como o melhor candidato é WITHIN, o estado correto é
 * `NO_SETTLEMENT` (nenhuma fatura fora da janela corresponde de verdade a este
 * pagamento) — nunca `OUTSIDE_SETTLEMENT_WINDOW` apontando a fatura errada de
 * maio.
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

const TENANT = "bank-569-wrong-outside-tenant";
const PESSOAL = "bank-569-wrong-outside-pessoal";
const BANK_LAST4 = "6543";
const CARD_LAST4 = "9988";

const REQUESTER: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["expenses", "creditCards", "bankAccounts"],
};

describe("BankAccountService.getImportDetail — não escolhe candidato OUTSIDE arbitrário quando existe candidato melhor (#2)", () => {
  let service: BankAccountService;
  let accountId: string;

  async function cleanup(): Promise<void> {
    await setupPrisma.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  }

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await setupPrisma.tenant.create({ data: { id: TENANT, name: "Wrong outside candidate" } });
    await setupPrisma.project.create({
      data: { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
    });
    const account = await setupPrisma.bankAccount.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: "ITAU", nickname: "Conta", last4: BANK_LAST4 },
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

  it("com fatura WITHIN de valor exato e fatura OUTSIDE de valor bem diferente, nunca aponta a fatura de fora", async () => {
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão wrong-outside",
        last4: CARD_LAST4,
        closingDay: 25,
        dueDay: 5,
      },
    });
    const PAYMENT_VALUE = 700_000;

    // Fatura de JUNHO (dentro da janela {2026-06,2026-07} do pagamento em
    // 30/06) — fecha o valor pago EXATAMENTE (melhor candidato, delta 0).
    const withinPurchase = await setupPrisma.expense.create({
      data: {
        id: "id-wrong-outside-within",
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: "Compra fatura junho",
        valor: PAYMENT_VALUE,
        quantidade: 1,
        valorTotal: PAYMENT_VALUE,
        formaPagamento: "A_VISTA",
        dataCompra: new Date("2026-05-10T12:00:00.000Z"),
        dataPagamento: new Date("2026-05-10T12:00:00.000Z"),
        status: "PLANEJADO",
        cardLast4: CARD_LAST4,
        paidParcelas: null,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: "id-wrong-outside-within-entry",
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: withinPurchase.id,
        valor: PAYMENT_VALUE,
        tipo: "DESPESA",
        data: new Date("2026-05-10T12:00:00.000Z"),
        categoria: "OUTROS",
        formaPagamento: "CARTAO_CREDITO",
        status: "PLANEJADO",
      },
    });

    // Fatura de MAIO (FORA da janela do commit) — valor bem diferente do
    // pagamento (referência errada, pior candidato por delta).
    const outsidePurchase = await setupPrisma.expense.create({
      data: {
        id: "id-wrong-outside-outside",
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: "Compra fatura maio (não relacionada)",
        valor: 100_000,
        quantidade: 1,
        valorTotal: 100_000,
        formaPagamento: "A_VISTA",
        dataCompra: new Date("2026-04-10T12:00:00.000Z"),
        dataPagamento: new Date("2026-04-10T12:00:00.000Z"),
        status: "PLANEJADO",
        cardLast4: CARD_LAST4,
        paidParcelas: null,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: "id-wrong-outside-outside-entry",
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: outsidePurchase.id,
        valor: 100_000,
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
        totalAmountCents: PAYMENT_VALUE,
      },
    });
    // Carimbado PROCESSED_NONE (seed direto — isola o teste na leitura de
    // `getImportDetail`, igual ao teste M2 irmão desta suíte).
    await setupPrisma.expense.create({
      data: {
        id: "id-wrong-outside-payment",
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "Pagamento fatura",
        valor: PAYMENT_VALUE,
        quantidade: 1,
        valorTotal: PAYMENT_VALUE,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-30T12:00:00.000Z"),
        status: "PAGO",
        cardLast4: CARD_LAST4,
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
        id: "id-wrong-outside-payment-entry",
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: "id-wrong-outside-payment",
        valor: PAYMENT_VALUE,
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
      settlement: Array<{ cardId: string | null; dueMonth: string | null; state: string }>;
    };

    const entry = detail.settlement.find((s) => s.cardId === card.id);
    expect(entry).toBeDefined();
    // Nunca a fatura de maio (não correspondente / referência errada).
    expect(entry?.dueMonth).not.toBe("2026-05");
    expect(entry?.state).not.toBe("OUTSIDE_SETTLEMENT_WINDOW");
    expect(entry?.state).toBe("NO_SETTLEMENT");
  });
});
