// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

/**
 * #569 PR2 — cobertura de mutação ADICIONAL à RED spec do design doc
 * (`docs/569-pr2-contract-and-red-spec.md` §5.1/§5.2), autorada em paralelo ao
 * backend-expert (fase RED — os métodos/estados abaixo ainda não existem no
 * `undoImport`/`applyRevertImportedLiquidations` reais; falha esperada é
 * "campo/estado inexistente", não erro de sintaxe).
 *
 * Cada `it` documenta a armadilha histórica que motivou o caso — ver CLAUDE.md
 * "Regras de ouro (cicatrizes)".
 *
 * Estratégia de seed: em vez de dirigir `commitImport` (que depende de
 * heurísticas de janela/matching fora de escopo deste arquivo), semeamos
 * DIRETAMENTE o estado pós-commit (compra com CashFlowEntry PAGO + carimbo
 * `invoiceUndoState=PROCESSED_SETTLED` no pagamento + linhas ativas de
 * `ImportedInvoiceLiquidation`) — isolando o teste na única coisa que importa
 * aqui: o contrato de `undoImport` ao CONSUMIR essa trilha.
 */
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

const TENANT = "bank-569-pr2-identity-tenant";
const PESSOAL = "bank-569-pr2-identity-pessoal";
const BANK_LAST4 = "3344";

const REQUESTER: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["expenses", "creditCards", "bankAccounts"],
};

describe("BankAccountService.undoImport — identidade (dueMonth+cardId, nunca valor/last4) e drift zero-write (#569 PR2)", () => {
  let service: BankAccountService;
  let accountId: string;

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
      data: { id: TENANT, name: "Undo identity" },
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

  /** Compra à vista PAGO (pós-flip) + 1 CashFlowEntry PAGO. */
  async function seedPaidPurchase(opts: {
    id: string;
    dataCompra: Date;
    valorCents: number;
    cardLast4: string;
  }): Promise<{ expenseId: string; entryId: string }> {
    await setupPrisma.expense.create({
      data: {
        id: opts.id,
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: `Compra ${opts.id}`,
        valor: opts.valorCents,
        quantidade: 1,
        valorTotal: opts.valorCents,
        formaPagamento: "A_VISTA",
        dataCompra: opts.dataCompra,
        dataPagamento: opts.dataCompra,
        status: "PAGO",
        cardLast4: opts.cardLast4,
        paidParcelas: null,
      },
    });
    const entry = await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${opts.id}-entry`,
        tenantId: TENANT,
        projectId: PESSOAL,
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

  /** Pagamento de fatura JÁ carimbado como PROCESSED_SETTLED + ledger ativo. */
  async function seedSettledPayment(opts: {
    id: string;
    importId: string;
    cardId: string;
    cardLast4: string;
    dueMonth: string;
    parcelas: Array<{
      purchaseExpenseId: string;
      cashFlowEntryId: string;
      valorCents: number;
      parcela?: string | null;
    }>;
    totalCents: number;
    createdAt?: Date;
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
        cardLast4: opts.cardLast4,
        bankLast4: BANK_LAST4,
        accountId,
        importId: opts.importId,
        origin: "import",
        invoiceUndoState: "PROCESSED_SETTLED",
        invoiceUndoParcelaCount: opts.parcelas.length,
        invoiceUndoDueMonth: opts.dueMonth,
        invoiceUndoCardId: opts.cardId,
        invoiceUndoTrailVersion: EXPECTED_TRAIL_VERSION,
        createdAt: opts.createdAt ?? new Date("2026-01-01T12:00:00.000Z"),
      },
    });
    const paymentEntry = await setupPrisma.cashFlowEntry.create({
      data: {
        id: `${opts.id}-entry`,
        tenantId: TENANT,
        projectId: PESSOAL,
        expenseId: opts.id,
        valor: opts.totalCents,
        tipo: "DESPESA",
        data: opts.createdAt ?? new Date("2026-01-01T12:00:00.000Z"),
        categoria: "Pagamento de fatura",
        formaPagamento: "A_VISTA",
        status: "PAGO",
      },
    });
    void paymentEntry;
    for (const p of opts.parcelas) {
      await setupPrisma.importedInvoiceLiquidation.create({
        data: {
          tenantId: TENANT,
          paymentExpenseId: opts.id,
          importId: opts.importId,
          purchaseExpenseId: p.purchaseExpenseId,
          cashFlowEntryId: p.cashFlowEntryId,
          cardId: opts.cardId,
          prevStatus: "PLANEJADO",
          entryValorCents: p.valorCents,
          parcela: p.parcela ?? null,
          dueMonth: opts.dueMonth,
        },
      });
    }
  }

  it(// Armadilha: liquidação por dueMonth já é a regra hoje (design §1.1), mas o
  // UNDO precisa devolver a MESMA fatura, não "a fatura de valor X" — duas
  // faturas do MESMO cartão com totais idênticos em meses diferentes são o
  // teste de mutação clássico contra um undo que (por engano) buscasse por
  // `entryValorCents`/valor em vez de `dueMonth`+`cardId`.
  "duas faturas de valor idêntico no mesmo cartão, meses diferentes: undo reverte SÓ a fatura do dueMonth do import, nunca a outra", async () => {
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão idêntico",
        last4: "7777",
        closingDay: 25,
        dueDay: 5,
      },
    });
    const SAME_VALUE = 500_000;
    const march = await seedPaidPurchase({
      id: "id-purchase-march",
      dataCompra: new Date("2026-02-10T12:00:00.000Z"),
      valorCents: SAME_VALUE,
      cardLast4: "7777",
    });
    const july = await seedPaidPurchase({
      id: "id-purchase-july",
      dataCompra: new Date("2026-06-10T12:00:00.000Z"),
      valorCents: SAME_VALUE,
      cardLast4: "7777",
    });

    // só a fatura de março é carimbada/liquidada por ESTE import
    await seedSettledPayment({
      id: "id-payment-march",
      importId: "id-import-march",
      cardId: card.id,
      cardLast4: "7777",
      dueMonth: "2026-03",
      totalCents: SAME_VALUE,
      parcelas: [
        {
          purchaseExpenseId: march.expenseId,
          cashFlowEntryId: march.entryId,
          valorCents: SAME_VALUE,
        },
      ],
    });

    const before = {
      marchEntry: await setupPrisma.cashFlowEntry.findUnique({
        where: { id: march.entryId },
      }),
      julyEntry: await setupPrisma.cashFlowEntry.findUnique({
        where: { id: july.entryId },
      }),
    };
    expect(before.marchEntry?.status).toBe("PAGO");
    expect(before.julyEntry?.status).toBe("PAGO"); // seedPaidPurchase já cria PAGO (não tocado por este import)

    await service.undoImport(
      TENANT,
      PESSOAL,
      accountId,
      "id-import-march",
      REQUESTER,
    );

    const marchEntryAfter = await setupPrisma.cashFlowEntry.findUnique({
      where: { id: march.entryId },
    });
    const julyEntryAfter = await setupPrisma.cashFlowEntry.findUnique({
      where: { id: july.entryId },
    });
    // A fatura de março (alvo do import) volta a PLANEJADO...
    expect(marchEntryAfter?.status).toBe("PLANEJADO");
    // ...e a fatura de julho — MESMO VALOR, cartão diferente mês — não é tocada,
    // mesmo que um undo ingênuo por valor a encontrasse primeiro.
    expect(julyEntryAfter?.status).toBe("PAGO");

    const liquidations = await setupPrisma.importedInvoiceLiquidation.findMany({
      where: { tenantId: TENANT, paymentExpenseId: "id-payment-march" },
    });
    expect(liquidations.every((l) => l.dueMonth === "2026-03")).toBe(true);
    expect(
      liquidations.some((l) => l.purchaseExpenseId === july.expenseId),
    ).toBe(false);
  });

  it(// Armadilha (design §1.2/§7.2, CLAUDE.md caso "cartões diferentes com
  // últimos-4-dígitos iguais"): a trilha usa `card_id` estável. Este teste
  // prova negativamente — cria dois cartões com o MESMO last4 e garante que
  // o undo do pagamento do cartão A nunca toca as parcelas do cartão B,
  // mesmo que ambos aparentem "o mesmo cartão" por last4.
  "cartões diferentes com o mesmo last4: identidade da trilha nunca é resolvida por last4", async () => {
    const cardA = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão A",
        last4: "9999",
        closingDay: 25,
        dueDay: 5,
      },
    });
    const cardB = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "BRADESCO",
        brand: "Master",
        nickname: "Cartão B",
        last4: "9999",
        closingDay: 25,
        dueDay: 5,
      },
    });
    const VALUE = 300_000;
    const purchaseA = await seedPaidPurchase({
      id: "id-purchase-a",
      dataCompra: new Date("2026-04-10T12:00:00.000Z"),
      valorCents: VALUE,
      cardLast4: "9999",
    });
    const purchaseB = await seedPaidPurchase({
      id: "id-purchase-b",
      dataCompra: new Date("2026-04-10T12:00:00.000Z"),
      valorCents: VALUE,
      cardLast4: "9999",
    });

    await seedSettledPayment({
      id: "id-payment-a",
      importId: "id-import-a",
      cardId: cardA.id,
      cardLast4: "9999",
      dueMonth: "2026-05",
      totalCents: VALUE,
      parcelas: [
        {
          purchaseExpenseId: purchaseA.expenseId,
          cashFlowEntryId: purchaseA.entryId,
          valorCents: VALUE,
        },
      ],
    });
    // Registro paralelo — carimbado para o cartão B, MESMO dueMonth, MESMO
    // valor — sem relação com o import sob teste.
    await seedSettledPayment({
      id: "id-payment-b",
      importId: "id-import-b",
      cardId: cardB.id,
      cardLast4: "9999",
      dueMonth: "2026-05",
      totalCents: VALUE,
      parcelas: [
        {
          purchaseExpenseId: purchaseB.expenseId,
          cashFlowEntryId: purchaseB.entryId,
          valorCents: VALUE,
        },
      ],
    });

    await service.undoImport(
      TENANT,
      PESSOAL,
      accountId,
      "id-import-a",
      REQUESTER,
    );

    const entryA = await setupPrisma.cashFlowEntry.findUnique({
      where: { id: purchaseA.entryId },
    });
    const entryB = await setupPrisma.cashFlowEntry.findUnique({
      where: { id: purchaseB.entryId },
    });
    expect(entryA?.status).toBe("PLANEJADO");
    // B pertence a outro cardId (mesmo last4) e outro import — jamais tocado.
    expect(entryB?.status).toBe("PAGO");

    const liqB = await setupPrisma.importedInvoiceLiquidation.findMany({
      where: {
        tenantId: TENANT,
        paymentExpenseId: "id-payment-b",
        deletedAt: null,
      },
    });
    expect(liqB).toHaveLength(1); // não soft-deletado pelo undo do import A
  });

  it(// Armadilha (design §2.3 passo 5 / regra de ouro #16-adjacente de proveniência):
  // um rateio POSTERIOR ao flip da fatura muda o schedule da compra-alvo. O
  // undo precisa detectar esse drift e recusar ANTES de escrever qualquer
  // coisa — nunca reverter "pela metade" e deixar RateioAllocation órfã ou
  // inconsistente com o ledger.
  "compra liquidada que depois sofreu rateio (RateioAllocation): undo detecta drift e bloqueia com ZERO escrita", async () => {
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão rateio",
        last4: "5566",
        closingDay: 25,
        dueDay: 5,
      },
    });
    const VALUE = 200_000;
    const purchase = await seedPaidPurchase({
      id: "id-purchase-rateio",
      dataCompra: new Date("2026-03-10T12:00:00.000Z"),
      valorCents: VALUE,
      cardLast4: "5566",
    });
    // Rateio posterior: a compra virou "fonte" de um rateio para outra
    // despesa planejada — o schedule dela diverge do snapshot do ledger.
    const targetProject = await setupPrisma.project.create({
      data: {
        id: "id-rateio-target-project",
        tenantId: TENANT,
        type: "REFORMA",
        name: "Reforma",
      },
    });
    const targetExpense = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: targetProject.id,
        tipoDespesa: "OUTROS",
        titulo: "Alvo do rateio",
        valor: VALUE,
        quantidade: 1,
        valorTotal: VALUE,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
      },
    });
    await setupPrisma.rateioAllocation.create({
      data: {
        tenantId: TENANT,
        sourceExpenseId: purchase.expenseId,
        targetExpenseId: targetExpense.id,
        allocation: VALUE,
        plannedStatus: "PLANEJADO",
      },
    });

    await seedSettledPayment({
      id: "id-payment-rateio",
      importId: "id-import-rateio",
      cardId: card.id,
      cardLast4: "5566",
      dueMonth: "2026-04",
      totalCents: VALUE,
      parcelas: [
        {
          purchaseExpenseId: purchase.expenseId,
          cashFlowEntryId: purchase.entryId,
          valorCents: VALUE,
        },
      ],
    });

    const before = {
      entry: await setupPrisma.cashFlowEntry.findUnique({
        where: { id: purchase.entryId },
      }),
      liquidation: await setupPrisma.importedInvoiceLiquidation.findMany({
        where: { tenantId: TENANT, paymentExpenseId: "id-payment-rateio" },
      }),
      payment: await setupPrisma.expense.findUnique({
        where: { id: "id-payment-rateio" },
      }),
      allocation: await setupPrisma.rateioAllocation.findMany({
        where: { tenantId: TENANT },
      }),
    };

    await expect(
      service.undoImport(
        TENANT,
        PESSOAL,
        accountId,
        "id-import-rateio",
        REQUESTER,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const after = {
      entry: await setupPrisma.cashFlowEntry.findUnique({
        where: { id: purchase.entryId },
      }),
      liquidation: await setupPrisma.importedInvoiceLiquidation.findMany({
        where: { tenantId: TENANT, paymentExpenseId: "id-payment-rateio" },
      }),
      payment: await setupPrisma.expense.findUnique({
        where: { id: "id-payment-rateio" },
      }),
      allocation: await setupPrisma.rateioAllocation.findMany({
        where: { tenantId: TENANT },
      }),
    };
    // ZERO escrita: nada mudou, nem o ledger, nem o carimbo, nem o rateio.
    expect(after).toEqual(before);
    expect(after.entry?.status).toBe("PAGO");
  });
});
