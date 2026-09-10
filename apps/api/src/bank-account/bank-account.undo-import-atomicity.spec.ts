import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  commitStatement,
  makeBankAccountService,
  makeSettlementService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedPessoal,
  seedSinglePurchase,
  seedStatementImport,
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-atom-tenant";
const PESSOAL = "iul-atom-pessoal";
const CARD = "4300";
const BANK = "8300";
const R = pessoalRequester(PESSOAL);

const setup = new PrismaClient();
const prisma = new PrismaService();

describe("#569 §6.3 — undo-import atomicity (PR 1)", () => {
  let bank: ReturnType<typeof makeBankAccountService>;
  let accountId: string;
  let cardId: string;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PESSOAL });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      last4: CARD,
      closingDay: 20,
      dueDay: 1,
    }));
    ({ id: accountId } = await seedBankAccount(setup, { tenantId: TENANT, projectId: PESSOAL, last4: BANK }));
    bank = makeBankAccountService(prisma);
  });

  afterEach(async () => {
    await setup.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
    await setup.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
    await setup.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setup.receipt.deleteMany({ where: { tenantId: TENANT } });
    await setup.expense.deleteMany({ where: { tenantId: TENANT } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  async function financialSnapshot() {
    const args = { where: { tenantId: TENANT }, orderBy: { id: "asc" as const } };
    const [expenses, entries, imports, ledger, receipts, settlements, allocations] = await Promise.all([
      setup.expense.findMany(args),
      setup.cashFlowEntry.findMany(args),
      setup.bankStatementImport.findMany(args),
      setup.importedInvoiceLiquidation.findMany(args),
      setup.receipt.findMany(args),
      setup.crossProjectSettlement.findMany(args),
      setup.rateioAllocation.findMany(args),
    ]);
    return { expenses, entries, imports, ledger, receipts, settlements, allocations };
  }

  it("P2002 na SEGUNDA linha do ledger reverte o primeiro insert e o lote inteiro, preservando snapshot financeiro completo", async () => {
    const first = await seedSinglePurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD,
      valorCents: 17_000,
      data: new Date("2026-06-10T12:00:00.000Z"),
      id: "atomic-purchase-first",
    });
    const second = await seedSinglePurchase(setup, {
      tenantId: TENANT,
      projectId: PESSOAL,
      cardLast4: CARD,
      valorCents: 24_000,
      data: new Date("2026-06-11T12:00:00.000Z"),
      id: "atomic-purchase-second",
    });
    const settlement = makeSettlementService(prisma);
    const prepared = await prisma.$transaction((tx) =>
      settlement.prepareSettleInvoice({
        tenantId: TENANT,
        card: { id: cardId, last4: CARD, closingDay: 20, dueDay: 1 },
        amountCents: 41_000,
        paymentDate: new Date("2026-06-30T12:00:00.000Z"),
        tx,
        requester: R,
      }),
    );
    expect(prepared.purchases.flatMap((purchase) => purchase.entries.map((entry) => entry.id)))
      .toEqual([first.entryId, second.entryId]);

    // A primeira gravação não conflita; a segunda encontra esta claim ativa.
    await seedStatementImport(setup, { tenantId: TENANT, accountId, id: "pre-existing" });
    await setup.importedInvoiceLiquidation.create({
      data: {
        tenantId: TENANT,
        paymentExpenseId: first.id,
        importId: "pre-existing",
        purchaseExpenseId: second.id,
        cashFlowEntryId: second.entryId,
        cardId,
        prevStatus: "PLANEJADO",
        entryValorCents: 24_000,
        dueMonth: "2026-07",
      },
    });

    const linkedTarget = await setup.expense.create({
      data: {
        id: "atomic-linked-target", tenantId: TENANT, projectId: PESSOAL,
        tipoDespesa: "OUTROS", titulo: "sentinela settlement", valor: 1_000,
        quantidade: 1, valorTotal: 1_000, formaPagamento: "A_VISTA", status: "PLANEJADO",
      },
    });
    const rateioTarget = await setup.expense.create({
      data: {
        id: "atomic-rateio-target", tenantId: TENANT, projectId: PESSOAL,
        tipoDespesa: "OUTROS", titulo: "sentinela rateio", valor: 1_000,
        quantidade: 1, valorTotal: 1_000, formaPagamento: "A_VISTA", status: "PLANEJADO",
      },
    });
    await setup.crossProjectSettlement.create({
      data: {
        id: "atomic-settlement", tenantId: TENANT, sourceExpenseId: first.id,
        targetExpenseId: linkedTarget.id, parcelaIndex: 0, realValor: 1_000,
        plannedValor: 1_000, plannedStatus: "PLANEJADO",
      },
    });
    await setup.rateioAllocation.create({
      data: {
        id: "atomic-allocation", tenantId: TENANT, sourceExpenseId: first.id,
        targetExpenseId: rateioTarget.id, allocation: 1_000, plannedStatus: "PLANEJADO",
      },
    });
    const receipt = await setup.receipt.create({
      data: {
        id: "atomic-receipt", tenantId: TENANT, projectId: PESSOAL, valor: 9_999,
        data: new Date("2026-06-01T12:00:00.000Z"), tipo: "OUTROS", status: "EM_CAIXA",
        linkedReceiptId: "receipt-link-sentinel",
      },
    });
    await setup.cashFlowEntry.create({
      data: {
        id: "atomic-receipt-entry", tenantId: TENANT, projectId: PESSOAL,
        receiptId: receipt.id, valor: 9_999, tipo: "RECEBIMENTO",
        data: new Date("2026-06-01T12:00:00.000Z"), categoria: "OUTROS",
        formaPagamento: "CONTA_CORRENTE", status: "EM_CAIXA",
      },
    });

    const before = await financialSnapshot();
    const ledgerWrites: Array<{
      cashFlowEntryId: string;
      outcome: "PENDING" | "SUCCEEDED" | "P2002";
      runInTransaction: boolean;
    }> = [];
    prisma.$use(async (params, next) => {
      const data = params.args?.data as
        | { tenantId?: string; cashFlowEntryId?: string }
        | undefined;
      if (
        params.model !== "ImportedInvoiceLiquidation"
        || params.action !== "create"
        || data?.tenantId !== TENANT
      ) {
        return next(params);
      }
      const observation: (typeof ledgerWrites)[number] = {
        cashFlowEntryId: data.cashFlowEntryId!,
        outcome: "PENDING",
        runInTransaction: params.runInTransaction,
      };
      ledgerWrites.push(observation);
      try {
        const result = await next(params);
        observation.outcome = "SUCCEEDED";
        return result;
      } catch (caught) {
        if ((caught as { code?: string }).code === "P2002") {
          observation.outcome = "P2002";
        }
        throw caught;
      }
    });
    let error: unknown;
    try {
      await commitStatement(bank, {
        tenantId: TENANT,
        projectId: PESSOAL,
        accountId,
        bankLast4: BANK,
        cardLast4: CARD,
        debitCents: 41_000,
        date: "20260630",
        period: "2026-06",
        requester: R,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "P2002" });
    expect(ledgerWrites).toEqual([
      {
        cashFlowEntryId: first.entryId,
        outcome: "SUCCEEDED",
        runInTransaction: true,
      },
      {
        cashFlowEntryId: second.entryId,
        outcome: "P2002",
        runInTransaction: true,
      },
    ]);
    expect(await financialSnapshot()).toEqual(before);
    expect(before.expenses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: first.id, status: "PLANEJADO", valorTotal: 17_000, paidParcelas: null,
      }),
      expect.objectContaining({
        id: second.id, status: "PLANEJADO", valorTotal: 24_000, paidParcelas: null,
      }),
    ]));
    expect(before.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.entryId, status: "PLANEJADO", valor: 17_000 }),
      expect.objectContaining({ id: second.entryId, status: "PLANEJADO", valor: 24_000 }),
      expect.objectContaining({ id: "atomic-receipt-entry", receiptId: receipt.id }),
    ]));
    expect(before.ledger).toHaveLength(1);
    expect(before.settlements).toHaveLength(1);
    expect(before.allocations).toHaveLength(1);
    expect(before.receipts).toHaveLength(1);
  });

  // Removidos desta branch (PR 1): os 2 `it` que exercitam `undoImport` revertendo
  // via ledger ("falha forçada no update de uma entry no meio" e "pagar-por-import →
  // undoImport devolve getAccountView ao baseline"). Ambos vivem inteiros em
  // `test/569-pr2-red`. Undo via ledger é PR 2.

  it("regression: lote sem pagamento de fatura continua ConflictException-free e reversível", async () => {
    const commit = await commitStatement(bank, {
      tenantId: TENANT,
      projectId: PESSOAL,
      accountId,
      bankLast4: BANK,
      debitCents: 4_299,
      date: "20260615",
      period: "2026-06",
      memo: "MERCADO BOM PRECO",
      requester: R,
    });
    const undo = await bank.undoImport(TENANT, PESSOAL, accountId, commit.importId, R);
    expect(undo).toMatchObject({ ok: true });
  });
});
