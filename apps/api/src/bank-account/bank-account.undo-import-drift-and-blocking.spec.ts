// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "./bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "../expense/rateio.types";

/**
 * issue #569 — rodada corretiva do ledger (blockers 1/2).
 *
 * 1. Drift do lançamento (regenerado / deletado / voltou a PLANEJADO) bloqueia o
 *    undo: `getImportDetail.canUndo === false`, `undoImport` → 409, zero writes.
 * 2. A liquidação nunca "avança" para outra parcela/fatura — `NONE` só significa
 *    "nenhum alvo resolvido".
 * 3. Um segundo pagamento pela mesma fatura não avança para a próxima parcela.
 * 4. Um ledger íntegro cuja fatura tem outra liquidação ativa (outra importação,
 *    pagamento vivo) não pode ser revertido agora — 409.
 * 5. Depois que o segundo (no-op) é desfeito, o primeiro pode ser desfeito.
 */
describe("BankAccountService — drift e bloqueio do undo por ledger (#569)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569-drift-tenant";
  const PESSOAL = "bank-569-drift-pessoal";
  const LAST4 = "5693";
  const BANK_LAST4 = "9014";
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
  function bankOfx(...t: string[]): Buffer {
    return Buffer.from(
      [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
        `<BANKACCTFROM><ACCTID>${BANK_LAST4}</ACCTID></BANKACCTFROM>`,
        "<BANKTRANLIST>",
        ...t,
        "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
      ].join("\n"),
    );
  }
  function commit(statement: Buffer, period: string) {
    return service.commitImport(
      TENANT, PESSOAL, accountId, statement, "e.ofx", "OFX", period,
      undefined, undefined, null, REQUESTER,
    );
  }

  async function cleanup(): Promise<void> {
    await setupPrisma.importedCardInvoiceSettlementEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.importedCardInvoiceSettlement.deleteMany({ where: { tenantId: TENANT } });
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
    await setupPrisma.tenant.create({ data: { id: TENANT, name: "Bank 569 drift" } });
    await setupPrisma.project.create({ data: { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" } });
    const account = await setupPrisma.bankAccount.create({
      data: { tenantId: TENANT, projectId: PESSOAL, institution: "ITAU", nickname: "Conta 569 drift", last4: BANK_LAST4 },
    });
    accountId = account.id;
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, institution: "ITAU", brand: "Visa",
        nickname: "Cartão 569 drift", last4: LAST4, closingDay: 25, dueDay: 5,
      },
    });
    cardId = card.id;
    service = new BankAccountService(
      prisma, new MerchantClassifierService(prisma), new ConciliacaoService(prisma), new CardInvoiceSettlementService(prisma),
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

  async function createPurchase(id: string, purchaseDate: Date, valor: number): Promise<void> {
    await setupPrisma.expense.create({
      data: {
        id, tenantId: TENANT, projectId: PESSOAL, tipoDespesa: "OUTROS", titulo: `Compra ${id}`,
        valor, quantidade: 1, valorTotal: valor, formaPagamento: "A_VISTA",
        dataPagamento: purchaseDate, status: "PLANEJADO", cardLast4: LAST4,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${id}-entry`, tenantId: TENANT, projectId: PESSOAL, expenseId: id, valor,
        tipo: "DESPESA", data: purchaseDate, categoria: "OUTROS", formaPagamento: "A_VISTA", status: "PLANEJADO",
      },
    });
  }

  /** Importa e liquida a fatura de julho (compra de junho, R$7.000). */
  async function importAndSettleJuly(fit: string, period = "2026-06") {
    await createPurchase(`purchase-${fit}`, new Date("2026-06-10T12:00:00.000Z"), 700_000);
    const r = await commit(bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, fit)), period);
    expect(r.cardPayments).toBe(1);
    return r;
  }

  it("1 — filho regenerado (nova CFE) bloqueia: getImportDetail.canUndo=false, undoImport 409, zero writes", async () => {
    const r = await importAndSettleJuly("DRIFT-REGEN");
    // Simula regeneração: a CFE antiga é soft-deletada (como o app faz) e nasce
    // uma nova com outro id.
    await setupPrisma.cashFlowEntry.update({
      where: { id: `purchase-DRIFT-REGEN-entry` },
      data: { deletedAt: new Date() },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: "purchase-DRIFT-REGEN-entry-v2", tenantId: TENANT, projectId: PESSOAL,
        expenseId: "purchase-DRIFT-REGEN", valor: 700_000, tipo: "DESPESA",
        data: new Date("2026-06-10T12:00:00.000Z"), categoria: "OUTROS", formaPagamento: "A_VISTA", status: "PAGO",
      },
    });

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, r.importId, REQUESTER);
    expect(detail.canUndo).toBe(false);
    expect(detail.blocking.changedInvoiceLiquidations).toBe(1);
    expect(detail.impact.invoiceLiquidations).toBe(0);

    const importBefore = await setupPrisma.bankStatementImport.findUnique({ where: { id: r.importId } });
    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, r.importId, REQUESTER),
    ).rejects.toBeInstanceOf(ConflictException);
    // Zero writes.
    const importAfter = await setupPrisma.bankStatementImport.findUnique({ where: { id: r.importId } });
    expect(importAfter?.deletedAt).toEqual(importBefore?.deletedAt ?? null);
    expect(
      (await setupPrisma.importedCardInvoiceSettlement.findFirst({ where: { bankStatementImportId: r.importId } }))
        ?.revertedAt,
    ).toBeNull();
  });

  it("1b — parcela que voltou a PLANEJADO à mão bloqueia o undo (409)", async () => {
    const r = await importAndSettleJuly("DRIFT-PLANEJADO");
    await setupPrisma.cashFlowEntry.update({
      where: { id: "purchase-DRIFT-PLANEJADO-entry" },
      data: { status: "PLANEJADO" },
    });
    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, r.importId, REQUESTER);
    expect(detail.canUndo).toBe(false);
    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, r.importId, REQUESTER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("2 — DUE_MONTH sem parcela PLANEJADO restante NÃO cai no fallback nem paga outra fatura", async () => {
    // Fatura de julho já quitada (compra de junho PAGO). Um pagamento de 700.000
    // resolve julho por vencimento, mas não há PLANEJADO — ledger DUE_MONTH sem
    // filhos, e a compra de MAIO (outra fatura) fica intacta.
    await createPurchase("p-may", new Date("2026-05-10T12:00:00.000Z"), 500_000);
    await setupPrisma.expense.update({ where: { id: "p-may" }, data: { status: "PAGO" } });
    await setupPrisma.cashFlowEntry.update({ where: { id: "p-may-entry" }, data: { status: "PAGO" } });
    await createPurchase("p-june", new Date("2026-06-10T12:00:00.000Z"), 700_000);
    await setupPrisma.expense.update({ where: { id: "p-june" }, data: { status: "PAGO" } });
    await setupPrisma.cashFlowEntry.update({ where: { id: "p-june-entry" }, data: { status: "PAGO" } });

    const r = await commit(bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, "NO-ADVANCE")), "2026-06");

    const ledger = await setupPrisma.importedCardInvoiceSettlement.findFirst({
      where: { bankStatementImportId: r.importId },
      include: { entries: true },
    });
    expect(ledger?.strategy).toBe("DUE_MONTH");
    expect(ledger?.targetDueMonth).toBe("2026-07");
    expect(ledger?.entries).toHaveLength(0);
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "p-may-entry" } }))?.status).toBe("PAGO");
  });

  it("3+4+5 — dois pagamentos pela mesma fatura: 2º não avança parcela; 1º só desfaz depois do 2º", async () => {
    // Compra parcelada 2x, fatura de julho contém a parcela 1.
    await createPurchase("p-inst", new Date("2026-06-10T12:00:00.000Z"), 700_000);

    const r1 = await commit(bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, "PAY-1")), "2026-06");
    const ledger1 = await setupPrisma.importedCardInvoiceSettlement.findFirst({
      where: { bankStatementImportId: r1.importId }, include: { entries: true },
    });
    expect(ledger1?.entries).toHaveLength(1);

    // 2º pagamento, outra importação, mesmo total/fatura.
    const r2 = await commit(bankOfx(ofxDebit("20260629", 700_000, `PAGTO CART CRED ${LAST4}`, "PAY-2")), "2026-06");
    const ledger2 = await setupPrisma.importedCardInvoiceSettlement.findFirst({
      where: { bankStatementImportId: r2.importId }, include: { entries: true },
    });
    // Não avançou para outra parcela — DUE_MONTH sem filhos.
    expect(ledger2?.entries).toHaveLength(0);
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "p-inst-entry" } }))?.status).toBe("PAGO");

    // 1º undo BLOQUEADO enquanto o 2º pagamento (ledger ativo pela mesma fatura) existe.
    const detail1 = await service.getImportDetail(TENANT, PESSOAL, accountId, r1.importId, REQUESTER);
    expect(detail1.canUndo).toBe(false);
    expect(detail1.blocking.invoiceLiquidationsWithOtherPayments).toBe(1);
    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, r1.importId, REQUESTER),
    ).rejects.toBeInstanceOf(ConflictException);

    // Desfaz o 2º (no-op para a fatura — sem filhos), depois o 1º passa.
    await service.undoImport(TENANT, PESSOAL, accountId, r2.importId, REQUESTER);
    const detail1b = await service.getImportDetail(TENANT, PESSOAL, accountId, r1.importId, REQUESTER);
    expect(detail1b.canUndo).toBe(true);
    await service.undoImport(TENANT, PESSOAL, accountId, r1.importId, REQUESTER);
    expect((await setupPrisma.cashFlowEntry.findUnique({ where: { id: "p-inst-entry" } }))?.status).toBe("PLANEJADO");
  });
});
