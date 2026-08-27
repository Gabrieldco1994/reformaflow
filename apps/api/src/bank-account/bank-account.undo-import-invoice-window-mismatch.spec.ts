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
 * issue #569 (hotfix fail-closed) — qualquer importação de extrato que crie um
 * `PAGAMENTO_FATURA_CARTAO` fica NÃO revertível como lote:
 *  - `getImportDetail` devolve `canUndo: false`;
 *  - `undoImport` lança 409 ANTES de qualquer escrita — nenhuma fatura é
 *    reaberta, nada é reconstruído por data;
 *  - importações sem pagamento de fatura continuam reversíveis.
 *
 * A reversão exata dessas liquidações continua aberta no issue #569.
 */
describe("BankAccountService — undo fail-closed com pagamento de fatura (#569)", () => {
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

  async function statusOf(entryId: string): Promise<string | undefined> {
    return (await setupPrisma.cashFlowEntry.findUnique({ where: { id: entryId } }))?.status;
  }

  it("#1 — lote com pagamento de fatura: getImportDetail devolve canUndo:false", async () => {
    await createPurchase({
      id: "p1-june",
      purchaseDate: new Date("2026-06-10T12:00:00.000Z"),
      valor: 700_000,
      status: "PLANEJADO",
    });
    const result = await commit(
      bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, "T1-PAY")),
      "2026-06",
    );
    expect(result.cardPayments).toBe(1);

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, result.importId);
    expect(detail.canUndo).toBe(false);
    expect(detail.blocking.cardInvoicePayments).toBe(1);
    expect(detail.impact.invoiceLiquidations).toBe(1);
  });

  it("#2 — DELETE desse lote: 409 e snapshot integralmente idêntico", async () => {
    await createPurchase({
      id: "p2-june",
      purchaseDate: new Date("2026-06-10T12:00:00.000Z"),
      valor: 700_000,
      status: "PLANEJADO",
    });
    const result = await commit(
      bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, "T2-PAY")),
      "2026-06",
    );
    expect(await statusOf("p2-june-entry")).toBe("PAGO");

    const before = {
      imports: await setupPrisma.bankStatementImport.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } }),
      expenses: await setupPrisma.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } }),
      entries: await setupPrisma.cashFlowEntry.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } }),
    };

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, result.importId, REQUESTER),
    ).rejects.toBeInstanceOf(ConflictException);

    const after = {
      imports: await setupPrisma.bankStatementImport.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } }),
      expenses: await setupPrisma.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } }),
      entries: await setupPrisma.cashFlowEntry.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } }),
    };
    expect(after).toEqual(before);
  });

  it("#3 — cenário junho/julho: undo não reabre nenhuma das duas faturas", async () => {
    await createPurchase({
      id: "p3-may",
      purchaseDate: new Date("2026-05-10T12:00:00.000Z"),
      valor: 500_000,
      status: "PAGO", // fatura de junho — já quitada por OUTRO pagamento
    });
    await createPurchase({
      id: "p3-june",
      purchaseDate: new Date("2026-06-10T12:00:00.000Z"),
      valor: 700_000,
      status: "PLANEJADO", // fatura de julho — quitada pelo pagamento importado
    });

    const result = await commit(
      bankOfx(ofxDebit("20260628", 700_000, `PAGTO CART CRED ${LAST4}`, "T3-PAY")),
      "2026-06",
    );
    expect(result.cardPayments).toBe(1);
    expect(await statusOf("p3-june-entry")).toBe("PAGO");
    expect(await statusOf("p3-may-entry")).toBe("PAGO");

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, result.importId, REQUESTER),
    ).rejects.toBeInstanceOf(ConflictException);

    // Nenhuma das duas faturas foi reaberta; o pagamento e o import continuam.
    expect(await statusOf("p3-june-entry")).toBe("PAGO");
    expect(await statusOf("p3-may-entry")).toBe("PAGO");
    expect(
      (await setupPrisma.bankStatementImport.findUnique({ where: { id: result.importId } }))?.deletedAt,
    ).toBeNull();
  });

  it("#4 — lote sem pagamento de fatura continua reversível", async () => {
    const result = await commit(
      bankOfx(ofxDebit("20260615", 4_299, "MERCADO BOM PRECO", "T4-MKT")),
      "2026-06",
    );
    expect(result.inserted).toBe(1);

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, result.importId);
    expect(detail.canUndo).toBe(true);
    expect(detail.blocking.cardInvoicePayments).toBe(0);

    const undo = await service.undoImport(TENANT, PESSOAL, accountId, result.importId, REQUESTER);
    expect(undo).toMatchObject({ ok: true, alreadyUndone: false, removedExpenses: 1 });
    expect(
      (await setupPrisma.bankStatementImport.findUnique({ where: { id: result.importId } }))?.deletedAt,
    ).not.toBeNull();
  });


  /** Import "cru" + pagamento de fatura ligado a ele, com `createdAt` e
   *  `deletedAt` controlados — cobre despesa ADOTADA e SOFT-DELETADA. */
  async function rawImportWithPayment(opts: {
    fitTag: string;
    createdAt: Date;
    deletedAt?: Date | null;
  }): Promise<string> {
    const imp = await setupPrisma.bankStatementImport.create({
      data: {
        tenantId: TENANT,
        accountId,
        periodLabel: "2026-06",
        source: "OFX",
        inserted: 1,
        totalAmountCents: 700_000,
        createdAt: opts.createdAt,
      },
    });
    await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: `Pagamento fatura ${opts.fitTag}`,
        valor: 700_000,
        quantidade: 1,
        valorTotal: 700_000,
        formaPagamento: "A_VISTA",
        dataPagamento: opts.createdAt,
        status: "PAGO",
        importId: imp.id,
        bankLast4: BANK_LAST4,
        cardLast4: LAST4,
        // adotada = criada ANTES do import; aqui forçamos createdAt no passado
        createdAt: new Date(opts.createdAt.getTime() - 5 * 24 * 3600 * 1000),
        deletedAt: opts.deletedAt ?? null,
      },
    });
    return imp.id;
  }

  it("#8 — pagamento de fatura ADOTADO (createdAt anterior ao import): detalhe bloqueado e DELETE 409/zero writes", async () => {
    const importId = await rawImportWithPayment({
      fitTag: "T8",
      createdAt: new Date("2026-06-20T12:00:00.000Z"),
    });

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, importId);
    expect(detail.canUndo).toBe(false);
    expect(detail.blocking.cardInvoicePayments).toBe(1);

    const before = await setupPrisma.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } });
    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, REQUESTER),
    ).rejects.toBeInstanceOf(ConflictException);
    const after = await setupPrisma.expense.findMany({ where: { tenantId: TENANT }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
    expect(
      (await setupPrisma.bankStatementImport.findUnique({ where: { id: importId } }))?.deletedAt,
    ).toBeNull();
  });

  it("#9 — pagamento de fatura SOFT-DELETADO ligado ao import: mesmo bloqueio (409, zero writes)", async () => {
    const importId = await rawImportWithPayment({
      fitTag: "T9",
      createdAt: new Date("2026-06-25T12:00:00.000Z"),
      deletedAt: new Date("2026-06-26T12:00:00.000Z"),
    });

    const detail = await service.getImportDetail(TENANT, PESSOAL, accountId, importId);
    expect(detail.canUndo).toBe(false);
    expect(detail.blocking.cardInvoicePayments).toBe(1);

    await expect(
      service.undoImport(TENANT, PESSOAL, accountId, importId, REQUESTER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await setupPrisma.bankStatementImport.findUnique({ where: { id: importId } }))?.deletedAt,
    ).toBeNull();
  });
});
