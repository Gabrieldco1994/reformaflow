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
 * issue #569 — o undo da importação reverte SÓ o que aquele pagamento moveu.
 *
 * Antes: `undoImport` reconstruía o ciclo da fatura pelos dias ATUAIS do cartão
 * e pelo mês do PAGAMENTO (`resolveUndoDueMonth`), então podia despagar a fatura
 * errada — inclusive uma quitada por OUTRO pagamento. E `getImportDetail` contava
 * `invoiceLiquidations` só por "tem cartão com dias configurados", mesmo quando a
 * liquidação real (janela de 2 meses) não achou nada.
 *
 * Agora a importação grava um ledger (`ImportedCardInvoiceSettlement` + filhos)
 * com os ids EXATOS dos `CashFlowEntry` que cada pagamento moveu PLANEJADO → PAGO.
 * O undo reverte só esses; o detail conta só o que o ledger registrou.
 */
describe("BankAccountService — undo de importação dirigido pelo ledger (#569)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569-tenant";
  const PESSOAL = "bank-569-pessoal";
  const LAST4 = "5691";
  const BANK_LAST4 = "9012";
  const REQUESTER: RateioRequester = {
    role: "USER",
    allowedProjects: [PESSOAL],
    allowedProjectTypes: ["PESSOAL"],
    allowedModules: ["expenses", "creditCards"],
  };

  let accountId: string;
  let cardId: string;

  function ofxDebit(date: string, amountCents: number, memo: string, fitId: string): string {
    const amount = (amountCents / 100).toFixed(2);
    return [
      "<STMTTRN>",
      "<TRNTYPE>DEBIT</TRNTYPE>",
      `<DTPOSTED>${date}</DTPOSTED>`,
      `<TRNAMT>-${amount}</TRNAMT>`,
      `<FITID>${fitId}</FITID>`,
      `<MEMO>${memo}</MEMO>`,
      "</STMTTRN>",
    ].join("");
  }

  function bankOfx(...transactions: string[]): Buffer {
    return Buffer.from(
      [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
        `<BANKACCTFROM><ACCTID>${BANK_LAST4}</ACCTID></BANKACCTFROM>`,
        "<BANKTRANLIST>",
        ...transactions,
        "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
      ].join("\n"),
    );
  }

  function commit(statement: Buffer, period: string) {
    return service.commitImport(
      TENANT,
      PESSOAL,
      accountId,
      statement,
      "extrato-569.ofx",
      "OFX",
      period,
      undefined,
      undefined,
      null,
      REQUESTER,
    );
  }

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
    await setupPrisma.tenant.create({ data: { id: TENANT, name: "Bank 569" } });
    await setupPrisma.project.create({
      data: { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
    });
    const account = await setupPrisma.bankAccount.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: "ITAU", nickname: "Conta 569", last4: BANK_LAST4 },
    });
    accountId = account.id;
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão 569",
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

  afterEach(cleanup);

  afterAll(async () => {
    await cleanupAll();
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  async function createPurchase(params: {
    id: string;
    purchaseDate: Date;
    valor: number;
    status: "PLANEJADO" | "PAGO";
  }): Promise<void> {
    await setupPrisma.expense.create({
      data: {
        id: params.id,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: `Compra ${params.id}`,
        valor: params.valor,
        quantidade: 1,
        valorTotal: params.valor,
        formaPagamento: "A_VISTA",
        dataPagamento: params.purchaseDate,
        status: params.status,
        cardLast4: LAST4,
        paidParcelas: null,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${params.id}-entry`,
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: params.id,
        valor: params.valor,
        tipo: "DESPESA",
        data: params.purchaseDate,
        categoria: "OUTROS",
        formaPagamento: "A_VISTA",
        status: params.status,
      },
    });
  }

  it("M1 — reverte só a fatura de julho que ESTE pagamento quitou; a de junho (paga por outro) fica intacta", async () => {
    await createPurchase({
      id: "purchase-may",
      purchaseDate: new Date("2026-05-10T12:00:00.000Z"),
      valor: 500_000,
      status: "PAGO", // fatura de junho — já quitada por OUTRO pagamento
    });
    await createPurchase({
      id: "purchase-june",
      purchaseDate: new Date("2026-06-10T12:00:00.000Z"),
      valor: 700_000,
      status: "PLANEJADO", // fatura de julho — a ser quitada pelo pagamento importado
    });

    const result = await commit(
      bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, "M1-PAY")),
      "2026-06",
    );
    expect(result.cardPayments).toBe(1);

    // A liquidação real (janela {jun, jul}) escolheu julho e marcou a compra de junho.
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-june-entry" } }))?.status).toBe("PAGO");
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-may-entry" } }))?.status).toBe("PAGO");

    const ledger = await setupPrisma.importedCardInvoiceSettlement.findFirst({
      where: { tenantId: TENANT, bankStatementImportId: result.importId },
      include: { entries: true },
    });
    expect(ledger?.strategy).toBe("DUE_MONTH");
    expect(ledger?.targetDueMonth).toBe("2026-07");
    expect(ledger?.entries.map((e) => e.cashFlowEntryId)).toEqual(["purchase-june-entry"]);

    await service.undoImport(TENANT, PESSOAL, accountId, result.importId, REQUESTER);

    expect({
      june: (await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-june-entry" } }))?.status,
      may: (await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-may-entry" } }))?.status,
      juneExpense: (await setupPrisma.expense.findUnique({ where: { id: "purchase-june" } }))?.status,
    }).toEqual({ june: "PLANEJADO", may: "PAGO", juneExpense: "PLANEJADO" });

    // Ledger fechado, filhos liberados, pagamento e import removidos.
    const closed = await setupPrisma.importedCardInvoiceSettlement.findFirst({
      where: { id: ledger!.id },
      include: { entries: true },
    });
    expect(closed?.revertedAt).not.toBeNull();
    expect(closed?.entries.every((e) => e.releasedAt !== null)).toBe(true);
  });

  it("M1b — segundo undo é idempotente: não mexe de novo na fatura", async () => {
    await createPurchase({
      id: "purchase-june-idem",
      purchaseDate: new Date("2026-06-10T12:00:00.000Z"),
      valor: 700_000,
      status: "PLANEJADO",
    });
    const result = await commit(
      bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, "M1B-PAY")),
      "2026-06",
    );
    await service.undoImport(TENANT, PESSOAL, accountId, result.importId, REQUESTER);
    // Reabrimos a compra à mão — um segundo undo NÃO pode ressuscitar/re-tocar.
    await setupPrisma.cashFlowEntry.update({ where: { id: "purchase-june-idem-entry" }, data: { status: "PAGO" } });

    const second = await service.undoImport(TENANT, PESSOAL, accountId, result.importId, REQUESTER);
    expect(second.alreadyUndone).toBe(true);
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-june-idem-entry" } }))?.status).toBe("PAGO");
  });

  it("M2 — nada casou na janela real: ledger NONE, getImportDetail conta 0 liquidações e 0 não-revertíveis", async () => {
    await createPurchase({
      id: "purchase-april",
      purchaseDate: new Date("2026-04-10T12:00:00.000Z"),
      valor: 300_000,
      status: "PLANEJADO", // fatura de maio — fora da janela {jul, ago}
    });

    const result = await commit(
      bankOfx(ofxDebit("20260728", 300_000, `PAGTO CART CRED ${LAST4}`, "M2-PAY")),
      "2026-07",
    );
    // #569 (blocker 5): nada foi liquidado ⇒ resultado honesto.
    expect(result.cardPayments).toBe(0);
    expect(result.unlinkedCardPayments).toBe(1);

    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-april-entry" } }))?.status).toBe("PLANEJADO");

    const ledger = await setupPrisma.importedCardInvoiceSettlement.findFirst({
      where: { tenantId: TENANT, bankStatementImportId: result.importId },
      include: { entries: true },
    });
    expect(ledger?.strategy).toBe("NONE");
    expect(ledger?.entries).toHaveLength(0);

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, result.importId, REQUESTER);
    expect(detail.impact.invoiceLiquidations).toBe(0);
    expect(detail.irreversible.notRevertibleInvoiceLiquidations).toBe(0);
  });

  it("M3 — cartão soft-deletado depois do import não muda o conjunto revertido pelo undo", async () => {
    await createPurchase({
      id: "purchase-june-del",
      purchaseDate: new Date("2026-06-10T12:00:00.000Z"),
      valor: 700_000,
      status: "PLANEJADO",
    });
    const result = await commit(
      bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, "M3-PAY")),
      "2026-06",
    );
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-june-del-entry" } }))?.status).toBe("PAGO");

    await setupPrisma.creditCard.update({ where: { id: cardId }, data: { deletedAt: new Date() } });
    try {
      await service.undoImport(TENANT, PESSOAL, accountId, result.importId, REQUESTER);
      expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "purchase-june-del-entry" } }))?.status).toBe("PLANEJADO");
    } finally {
      await setupPrisma.creditCard.update({ where: { id: cardId }, data: { deletedAt: null } });
    }
  });
});
