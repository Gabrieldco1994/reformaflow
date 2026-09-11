// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

/**
 * #569 PR2 — cobertura de mutação ADICIONAL à RED spec do design doc
 * (`docs/569-pr2-contract-and-red-spec.md` §5.3/§5.4), autorada em paralelo ao
 * backend-expert. Três armadilhas históricas do repo:
 *
 *  - concorrência TOCTOU (regra #16-adjacente / design §2.4): duas chamadas
 *    simultâneas de `undoImport` para o MESMO lote não podem reverter duas
 *    vezes nem corromper `ImportedInvoiceLiquidation` — a releitura tem que
 *    acontecer DENTRO da `$transaction`, não num pré-check externo;
 *  - ACL cross-project — ocultação TOTAL (nunca truncada/anonimizada,
 *    §4.1/§4.2 do contrato) — vazar mesmo que só "existe mas está oculto" já
 *    é uma fuga de informação proibida pelo design;
 *  - sucesso parcial proibido: N parcelas do mesmo lote, uma delas com drift —
 *    a trilha inteira deve abortar, nenhuma das N pode ser escrita.
 */
import { NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { BankAccountService } from "./bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "../expense/rateio.types";
import { EXPECTED_TRAIL_VERSION } from "./__tests__/invoice-undo.fixtures";

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "bank-569-pr2-concurrency-tenant";
const PESSOAL = "bank-569-pr2-concurrency-pessoal";
const HIDDEN_PROJECT = "bank-569-pr2-concurrency-hidden";
const BANK_LAST4 = "6677";

const REQUESTER_FULL: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, HIDDEN_PROJECT],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses", "creditCards", "bankAccounts"],
};

const REQUESTER_LIMITED: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL], // NÃO vê HIDDEN_PROJECT
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["expenses", "creditCards", "bankAccounts"],
};

describe("BankAccountService.undoImport — concorrência, ACL de escrita e atomicidade do lote (#569 PR2)", () => {
  let service: BankAccountService;
  let accountId: string;
  let card: { id: string };

  async function cleanup(): Promise<void> {
    await setupPrisma.rateioAllocation.deleteMany({
      where: { tenantId: TENANT },
    });
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
      data: { id: TENANT, name: "Undo concurrency" },
    });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
        {
          id: HIDDEN_PROJECT,
          tenantId: TENANT,
          type: "REFORMA",
          name: "Reforma oculta",
        },
      ],
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
    card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão concorrência",
        last4: "8899",
        closingDay: 25,
        dueDay: 5,
      },
    });
    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  afterEach(async () => {
    await setupPrisma.rateioAllocation.deleteMany({
      where: { tenantId: TENANT },
    });
    await setupPrisma.importedInvoiceLiquidation.deleteMany({
      where: { tenantId: TENANT },
    });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({
      where: { tenantId: TENANT },
    });
  });

  afterAll(async () => {
    await cleanup();
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  async function seedPaidPurchase(opts: {
    id: string;
    projectId: string;
    dataCompra: Date;
    valorCents: number;
  }): Promise<{ expenseId: string; entryId: string }> {
    await setupPrisma.expense.create({
      data: {
        id: opts.id,
        tenantId: TENANT,
        projectId: opts.projectId,
        tipoDespesa: "OUTROS",
        titulo: `Compra ${opts.id}`,
        valor: opts.valorCents,
        quantidade: 1,
        valorTotal: opts.valorCents,
        formaPagamento: "A_VISTA",
        dataCompra: opts.dataCompra,
        dataPagamento: opts.dataCompra,
        status: "PAGO",
        cardLast4: "8899",
        paidParcelas: null,
      },
    });
    const entry = await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${opts.id}-entry`,
        tenantId: TENANT,
        projectId: opts.projectId,
        expenseId: opts.id,
        valor: opts.valorCents,
        tipo: "DESPESA",
        data: opts.dataCompra,
        categoria: "OUTROS",
        formaPagamento: "CARTAO_CREDITO",
        status: "PAGO",
      },
    });
    return { expenseId: opts.id, entryId: entry.id };
  }

  async function seedSettledPayment(opts: {
    id: string;
    importId: string;
    dueMonth: string;
    parcelas: Array<{
      purchaseExpenseId: string;
      cashFlowEntryId: string;
      valorCents: number;
    }>;
    totalCents: number;
  }): Promise<void> {
    await setupPrisma.bankStatementImport.upsert({
      where: { id: opts.importId },
      update: {},
      create: {
        id: opts.importId,
        tenantId: TENANT,
        accountId,
        periodLabel: opts.dueMonth,
        source: "OFX",
        inserted: 1,
        totalAmountCents: opts.totalCents,
      },
    });
    await setupPrisma.expense.create({
      data: {
        id: opts.id,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: `Pagamento fatura ${opts.dueMonth}`,
        valor: opts.totalCents,
        quantidade: 1,
        valorTotal: opts.totalCents,
        formaPagamento: "A_VISTA",
        status: "PAGO",
        cardLast4: "8899",
        bankLast4: BANK_LAST4,
        accountId,
        importId: opts.importId,
        origin: "import",
        invoiceUndoState: "PROCESSED_SETTLED",
        invoiceUndoParcelaCount: opts.parcelas.length,
        invoiceUndoDueMonth: opts.dueMonth,
        invoiceUndoCardId: card.id,
        invoiceUndoTrailVersion: EXPECTED_TRAIL_VERSION,
      },
    });
    await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${opts.id}-entry`,
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: opts.id,
        valor: opts.totalCents,
        tipo: "DESPESA",
        data: new Date("2026-01-01T12:00:00.000Z"),
        categoria: "Pagamento de fatura",
        formaPagamento: "A_VISTA",
        status: "PAGO",
      },
    });
    for (const p of opts.parcelas) {
      await setupPrisma.importedInvoiceLiquidation.create({
        data: {
          tenantId: TENANT,
          paymentExpenseId: opts.id,
          importId: opts.importId,
          purchaseExpenseId: p.purchaseExpenseId,
          cashFlowEntryId: p.cashFlowEntryId,
          cardId: card.id,
          prevStatus: "PLANEJADO",
          entryValorCents: p.valorCents,
          parcela: null,
          dueMonth: opts.dueMonth,
        },
      });
    }
  }

  it(// Armadilha TOCTOU: duas chamadas simultâneas contra o MESMO importId,
  // via Promise.all contra o service REAL (sem mock). O invariante não é
  // "qual delas vence" — é que NUNCA as duas revertem, e nenhuma linha de
  // ImportedInvoiceLiquidation soft-delete/CashFlowEntry acaba num estado
  // ambíguo (dupla reversão contaria dinheiro 2x no caixa).
  "duas chamadas concorrentes de undoImport para a MESMA importação: exatamente uma reverte, a outra recebe erro/no-op determinístico", async () => {
    const VALUE = 400_000;
    const purchase = await seedPaidPurchase({
      id: "id-concurrency-purchase",
      projectId: PESSOAL,
      dataCompra: new Date("2026-05-10T12:00:00.000Z"),
      valorCents: VALUE,
    });
    await seedSettledPayment({
      id: "id-concurrency-payment",
      importId: "id-concurrency-import",
      dueMonth: "2026-06",
      totalCents: VALUE,
      parcelas: [
        {
          purchaseExpenseId: purchase.expenseId,
          cashFlowEntryId: purchase.entryId,
          valorCents: VALUE,
        },
      ],
    });

    const results = await Promise.allSettled([
      service.undoImport(
        TENANT,
        PESSOAL,
        accountId,
        "id-concurrency-import",
        REQUESTER_FULL,
      ),
      service.undoImport(
        TENANT,
        PESSOAL,
        accountId,
        "id-concurrency-import",
        REQUESTER_FULL,
      ),
    ]);

    const fulfilledValues = results
      .filter((r) => r.status === "fulfilled")
      .map(
        (r) =>
          (
            r as PromiseFulfilledResult<{
              revertedInvoiceParcelas: number;
              alreadyUndone: boolean;
            }>
          ).value,
      );
    // No máximo 1 resultado com reversão de fato (revertedInvoiceParcelas>0
    // e alreadyUndone:false); qualquer outro fulfilled precisa ser
    // alreadyUndone:true — NUNCA duas reversões reais.
    const realReversals = fulfilledValues.filter(
      (v) => v.revertedInvoiceParcelas > 0 && v.alreadyUndone === false,
    );
    expect(realReversals.length).toBeLessThanOrEqual(1);
    expect(realReversals.length).toBeGreaterThanOrEqual(1); // pelo menos uma tem que ter revertido de fato

    const entryAfter = await setupPrisma.cashFlowEntry.findUnique({
      where: { id: purchase.entryId },
    });
    expect(entryAfter?.status).toBe("PLANEJADO");

    // Nunca duplicidade: a linha de ledger ativa (não soft-deletada) tem
    // que ser zero após a reversão — nunca ficar "meio revertida".
    const activeLedger = await setupPrisma.importedInvoiceLiquidation.findMany({
      where: {
        tenantId: TENANT,
        paymentExpenseId: "id-concurrency-payment",
        deletedAt: null,
      },
    });
    expect(activeLedger).toHaveLength(0);
  });

  it(// Re-undo SERIAL (não concorrente): idempotência determinística.
  "re-undo serial da mesma importação: 2ª chamada é alreadyUndone:true, ZERO parcelas revertidas de novo", async () => {
    const VALUE = 150_000;
    const purchase = await seedPaidPurchase({
      id: "id-serial-purchase",
      projectId: PESSOAL,
      dataCompra: new Date("2026-05-10T12:00:00.000Z"),
      valorCents: VALUE,
    });
    await seedSettledPayment({
      id: "id-serial-payment",
      importId: "id-serial-import",
      dueMonth: "2026-06",
      totalCents: VALUE,
      parcelas: [
        {
          purchaseExpenseId: purchase.expenseId,
          cashFlowEntryId: purchase.entryId,
          valorCents: VALUE,
        },
      ],
    });

    const first = await service.undoImport(
      TENANT,
      PESSOAL,
      accountId,
      "id-serial-import",
      REQUESTER_FULL,
    );
    expect(first.alreadyUndone).toBe(false);
    expect(first.revertedInvoiceParcelas).toBe(1);

    const second = await service.undoImport(
      TENANT,
      PESSOAL,
      accountId,
      "id-serial-import",
      REQUESTER_FULL,
    );
    expect(second).toMatchObject({
      ok: true,
      alreadyUndone: true,
      revertedInvoiceParcelas: 0,
    });
  });

  it(// Armadilha ACL: um participante cross-project sem visibilidade nunca
  // pode aparecer no array de settlement — nem truncado, nem "hidden:true".
  // O requester limitado não vê HIDDEN_PROJECT: essa entrada some do array.
  "getImportDetail: participante cross-project sem permissão NÃO aparece em settlement[] — ocultação total, não truncada", async () => {
    const VALUE = 220_000;
    const purchaseVisible = await seedPaidPurchase({
      id: "id-acl-visible-purchase",
      projectId: PESSOAL,
      dataCompra: new Date("2026-05-10T12:00:00.000Z"),
      valorCents: VALUE,
    });
    const purchaseHidden = await seedPaidPurchase({
      id: "id-acl-hidden-purchase",
      projectId: HIDDEN_PROJECT,
      dataCompra: new Date("2026-05-10T12:00:00.000Z"),
      valorCents: VALUE,
    });

    await seedSettledPayment({
      id: "id-acl-payment-visible",
      importId: "id-acl-import",
      dueMonth: "2026-06",
      totalCents: VALUE,
      parcelas: [
        {
          purchaseExpenseId: purchaseVisible.expenseId,
          cashFlowEntryId: purchaseVisible.entryId,
          valorCents: VALUE,
        },
      ],
    });
    await setupPrisma.importedInvoiceLiquidation.create({
      data: {
        tenantId: TENANT,
        paymentExpenseId: "id-acl-payment-visible",
        importId: "id-acl-import",
        purchaseExpenseId: purchaseHidden.expenseId,
        cashFlowEntryId: purchaseHidden.entryId,
        cardId: card.id,
        prevStatus: "PLANEJADO",
        entryValorCents: VALUE,
        parcela: null,
        dueMonth: "2026-06",
      },
    });

    const detail = (await service.getImportDetail(
      TENANT,
      PESSOAL,
      accountId,
      "id-acl-import",
      REQUESTER_LIMITED as never,
    )) as unknown as {
      settlement: Array<{ payments: Array<{ paymentExpenseId: string }> }>;
    };

    // A entrada existe fisicamente (visível ao requester completo), mas o
    // requester limitado NUNCA deve ver nem um traço dela — nem um objeto
    // truncado, nem contagem residual.
    const serialized = JSON.stringify(detail.settlement);
    expect(serialized).not.toContain(purchaseHidden.expenseId);
    expect(serialized).not.toContain("hidden");
  });

  it(// Sucesso parcial proibido: lote com N=3 parcelas na MESMA fatura, uma
  // delas (a do meio) com drift (CashFlowEntry não está mais PAGO). O
  // resultado tem que ser: TRANSAÇÃO INTEIRA abortada, nenhuma das 3
  // revertida — nunca 2 revertidas + 1 bloqueada.
  "lote com N parcelas, uma falharia drift-check: TODAS as N permanecem intocadas (transação abortada por completo)", async () => {
    const VALUE = 100_000;
    const p1 = await seedPaidPurchase({
      id: "id-partial-p1",
      projectId: PESSOAL,
      dataCompra: new Date("2026-05-01T12:00:00.000Z"),
      valorCents: VALUE,
    });
    const p2 = await seedPaidPurchase({
      id: "id-partial-p2",
      projectId: PESSOAL,
      dataCompra: new Date("2026-05-02T12:00:00.000Z"),
      valorCents: VALUE,
    });
    const p3 = await seedPaidPurchase({
      id: "id-partial-p3",
      projectId: PESSOAL,
      dataCompra: new Date("2026-05-03T12:00:00.000Z"),
      valorCents: VALUE,
    });

    await seedSettledPayment({
      id: "id-partial-payment",
      importId: "id-partial-import",
      dueMonth: "2026-06",
      totalCents: VALUE * 3,
      parcelas: [
        {
          purchaseExpenseId: p1.expenseId,
          cashFlowEntryId: p1.entryId,
          valorCents: VALUE,
        },
        {
          purchaseExpenseId: p2.expenseId,
          cashFlowEntryId: p2.entryId,
          valorCents: VALUE,
        },
        {
          purchaseExpenseId: p3.expenseId,
          cashFlowEntryId: p3.entryId,
          valorCents: VALUE,
        },
      ],
    });

    // Drift induzido: p2 foi "revertida por fora" — CashFlowEntry já não é
    // mais PAGO (ex.: outro fluxo reabriu manualmente).
    await setupPrisma.cashFlowEntry.update({
      where: { id: p2.entryId },
      data: { status: "PLANEJADO" },
    });

    const before = {
      p1: await setupPrisma.cashFlowEntry.findUnique({
        where: { id: p1.entryId },
      }),
      p3: await setupPrisma.cashFlowEntry.findUnique({
        where: { id: p3.entryId },
      }),
      ledger: await setupPrisma.importedInvoiceLiquidation.findMany({
        where: {
          tenantId: TENANT,
          paymentExpenseId: "id-partial-payment",
          deletedAt: null,
        },
      }),
    };
    expect(before.p1?.status).toBe("PAGO");
    expect(before.p3?.status).toBe("PAGO");
    expect(before.ledger).toHaveLength(3);

    await expect(
      service.undoImport(
        TENANT,
        PESSOAL,
        accountId,
        "id-partial-import",
        REQUESTER_FULL,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const after = {
      p1: await setupPrisma.cashFlowEntry.findUnique({
        where: { id: p1.entryId },
      }),
      p3: await setupPrisma.cashFlowEntry.findUnique({
        where: { id: p3.entryId },
      }),
      ledger: await setupPrisma.importedInvoiceLiquidation.findMany({
        where: {
          tenantId: TENANT,
          paymentExpenseId: "id-partial-payment",
          deletedAt: null,
        },
      }),
    };
    // p1/p3 (que POR SI SÓ passariam no drift-check) continuam intocadas —
    // a falha de p2 tem que abortar as 3, nunca reverter parcialmente.
    expect(after.p1?.status).toBe("PAGO");
    expect(after.p3?.status).toBe("PAGO");
    expect(after.ledger).toHaveLength(3);
  });

  it(// Baseline positivo do guard ACL — ADMIN/participante com visão completa
  // reverte normalmente (não é só o caminho negativo que precisa de teste).
  "ADMIN com visão de todos os participantes: undoImport reverte normalmente mesmo com participante cross-project", async () => {
    const VALUE = 90_000;
    const purchase = await seedPaidPurchase({
      id: "id-admin-purchase",
      projectId: HIDDEN_PROJECT,
      dataCompra: new Date("2026-05-10T12:00:00.000Z"),
      valorCents: VALUE,
    });
    await seedSettledPayment({
      id: "id-admin-payment",
      importId: "id-admin-import",
      dueMonth: "2026-06",
      totalCents: VALUE,
      parcelas: [
        {
          purchaseExpenseId: purchase.expenseId,
          cashFlowEntryId: purchase.entryId,
          valorCents: VALUE,
        },
      ],
    });

    const result = await service.undoImport(
      TENANT,
      PESSOAL,
      accountId,
      "id-admin-import",
      {
        role: "ADMIN",
      } as RateioRequester,
    );
    expect(result.revertedInvoiceParcelas).toBe(1);
    const entry = await setupPrisma.cashFlowEntry.findUnique({
      where: { id: purchase.entryId },
    });
    expect(entry?.status).toBe("PLANEJADO");
  });

  it(// ACL na ESCRITA (distinto do ACL de leitura já coberto em PR1): requester
  // sem visão do projeto participante tenta desfazer — deve tomar 404
  // indistinguível de "não existe", ZERO escrita, mesmo com trilha íntegra.
  "requester sem ACL do projeto participante: undoImport 404 'Fatura não encontrada', zero escrita mesmo com trilha íntegra", async () => {
    const VALUE = 77_000;
    const purchase = await seedPaidPurchase({
      id: "id-authz-purchase",
      projectId: HIDDEN_PROJECT,
      dataCompra: new Date("2026-05-10T12:00:00.000Z"),
      valorCents: VALUE,
    });
    await seedSettledPayment({
      id: "id-authz-payment",
      importId: "id-authz-import",
      dueMonth: "2026-06",
      totalCents: VALUE,
      parcelas: [
        {
          purchaseExpenseId: purchase.expenseId,
          cashFlowEntryId: purchase.entryId,
          valorCents: VALUE,
        },
      ],
    });

    const before = await setupPrisma.cashFlowEntry.findUnique({
      where: { id: purchase.entryId },
    });
    await expect(
      service.undoImport(
        TENANT,
        PESSOAL,
        accountId,
        "id-authz-import",
        REQUESTER_LIMITED,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    const after = await setupPrisma.cashFlowEntry.findUnique({
      where: { id: purchase.entryId },
    });
    expect(after).toEqual(before);
    expect(after?.status).toBe("PAGO");
  });
});
