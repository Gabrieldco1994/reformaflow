/**
 * #569 (degrau) — blockers B3/B4 do pre-check `INVOICE_HAS_IMPORT_TRAIL` no
 * `payInvoice`. Evidência executável REAL contra o serviço: PrismaService real +
 * DB descartável do worktree; nenhum service/delegate/resposta mockado. Todas as
 * liquidações por importação abaixo saem do `commitImport` real.
 *
 * B3: uma trilha de setembro (fatura anterior já liquidada por extrato) NÃO pode
 *     bloquear o pagamento manual de outubro da fatura corrente do cartão.
 * B4: compra manual OCULTA em projeto que o requester não vê ⇒ 404 (nunca 409
 *     enganoso), tanto no valor que casa quanto no que não casa; zero escrita.
 *
 * Cópia mínima dos casos B3/B4 da prova QA (qa-569-572-blockers), reusando as
 * fixtures compartilhadas — nada de fabricar carimbo/ledger na mão.
 */
import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  ADMIN_REQUESTER,
  commitStatement,
  makeBankAccountService,
  makeMonthlyOverviewService,
  makeSettlementService,
  pessoalRequester,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
  seedProject,
} from "./__tests__/invoice-undo.fixtures";

const TENANT = "iul-blockers-b34";
const A = "iul-blockers-project-a";
const B = "iul-blockers-project-b";
const CARD = "5721";
const BANK = "5722";
const ADMIN = { id: ADMIN_REQUESTER.id, role: "ADMIN" as const };
const ONLY_A = { ...pessoalRequester(A), id: "iul-blockers-restricted-a" };
const setup = new PrismaClient();
const prisma = new PrismaService();
const bank = makeBankAccountService(prisma);
const monthly = makeMonthlyOverviewService(prisma);
const settlement = makeSettlementService(prisma);
let accountId: string;
let cardId: string;

async function observe<T>(operation: () => Promise<T>) {
  try {
    return { value: await operation(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function errorStatus(error: unknown) {
  return error instanceof HttpException ? error.getStatus() : null;
}

function diagnostic(label: string, error: unknown) {
  console.log(label, {
    resolved: error === null,
    status: errorStatus(error),
    error: error instanceof Error ? error.message : error,
  });
}

async function fullSnapshot() {
  const where = { tenantId: TENANT };
  const orderBy = { id: "asc" as const };
  return {
    expenses: await setup.expense.findMany({ where, orderBy }),
    entries: await setup.cashFlowEntry.findMany({ where, orderBy }),
    ledger: await setup.importedInvoiceLiquidation.findMany({ where, orderBy }),
    imports: await setup.bankStatementImport.findMany({ where, orderBy }),
    ccImports: await setup.creditCardStatementImport.findMany({
      where,
      orderBy,
    }),
    receipts: await setup.receipt.findMany({ where, orderBy }),
    allocations: await setup.rateioAllocation.findMany({ where, orderBy }),
    settlements: await setup.crossProjectSettlement.findMany({
      where,
      orderBy,
    }),
  };
}

async function purchase(projectId: string, firstDate: string, parcelas = 3) {
  const seeded = await seedInstallmentPurchase(setup, {
    tenantId: TENANT,
    projectId,
    cardLast4: CARD,
    parcelas,
    valorCents: 10_000,
    primeiraData: new Date(firstDate),
  });
  // Aritmética canônica da despesa: quantidade 1 × preço cheio = total;
  // cada parcela semeada continua com exatamente 10_000 centavos.
  await setup.expense.update({
    where: { id: seeded.id },
    data: { valor: parcelas * 10_000 },
  });
  const row = await setup.expense.findUniqueOrThrow({
    where: { id: seeded.id },
  });
  const entries = await setup.cashFlowEntry.findMany({
    where: { expenseId: seeded.id },
    orderBy: { data: "asc" },
  });
  expect(row.valor * row.quantidade).toBe(row.valorTotal);
  expect(row.valorTotal).toBe(parcelas * 10_000);
  expect(entries.map((e) => [e.id, e.valor, e.status])).toEqual(
    seeded.entryIds.map((id) => [id, 10_000, "PLANEJADO"]),
  );
  return seeded;
}

async function importedPayment(
  expectedPurchaseId: string,
  expectedEntryId: string,
  date = "20260705",
  period = "2026-07",
) {
  const committed = await commitStatement(bank, {
    tenantId: TENANT,
    projectId: A,
    accountId,
    bankLast4: BANK,
    cardLast4: CARD,
    debitCents: 10_000,
    date,
    period,
    requester: ADMIN,
    fitId: `iul-blockers-${date}`,
  });
  const payment = await setup.expense.findFirstOrThrow({
    where: {
      tenantId: TENANT,
      importId: committed.importId,
      tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
    },
  });
  const claims = await setup.importedInvoiceLiquidation.findMany({
    where: { tenantId: TENANT, paymentExpenseId: payment.id, deletedAt: null },
  });
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject({
    purchaseExpenseId: expectedPurchaseId,
    cashFlowEntryId: expectedEntryId,
    importId: committed.importId,
    cardId,
    entryValorCents: 10_000,
    prevStatus: "PLANEJADO",
    dueMonth: period,
  });
  expect(payment).toMatchObject({
    valor: 10_000,
    valorTotal: 10_000,
    invoiceUndoState: "PROCESSED_SETTLED",
    invoiceUndoParcelaCount: 1,
    invoiceUndoDueMonth: period,
    invoiceUndoCardId: cardId,
    invoiceUndoTrailVersion: 1,
  });
  expect(
    (
      await setup.cashFlowEntry.findUniqueOrThrow({
        where: { id: expectedEntryId },
      })
    ).status,
  ).toBe("PAGO");
  return { committed, payment, claims };
}

beforeAll(async () => {
  await setup.$connect();
  await prisma.onModuleInit();
});

beforeEach(async () => {
  await resetTenant(setup, TENANT);
  await seedPessoal(setup, { tenantId: TENANT, projectId: A });
  await seedProject(setup, {
    tenantId: TENANT,
    projectId: B,
    type: "REFORMA",
    name: "Projeto B",
  });
  ({ id: accountId } = await seedBankAccount(setup, {
    tenantId: TENANT,
    projectId: A,
    last4: BANK,
  }));
  ({ id: cardId } = await seedCardWithClosingDue(setup, {
    tenantId: TENANT,
    projectId: A,
    last4: CARD,
    closingDay: 20,
    dueDay: 1,
  }));
});

afterEach(async () => {
  await resetTenant(setup, TENANT);
});

afterAll(async () => {
  await prisma.onModuleDestroy();
  await setup.$disconnect();
});

it("B3 September claim must not block a valid October payment of the current CC statement", async () => {
  const p = await purchase(A, "2026-08-10T12:00:00.000Z");
  const ccImport = await setup.creditCardStatementImport.create({
    data: {
      id: "iul-blockers-current-cc-statement",
      tenantId: TENANT,
      cardId,
      source: "OFX",
      status: "COMPLETED",
      inserted: 1,
      periodLabel: "2026-09",
      totalAmountCents: 10_000,
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
    },
  });
  await setup.expense.update({
    where: { id: p.id },
    data: { importId: ccImport.id },
  });
  const september = await importedPayment(
    p.id,
    p.entryIds[0],
    "20260905",
    "2026-09",
  );
  expect(september.committed.importId).not.toBe(ccImport.id);
  const current = await setup.creditCardStatementImport.findFirstOrThrow({
    where: { tenantId: TENANT, cardId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  expect(current).toMatchObject({
    id: ccImport.id,
    cardId,
    tenantId: TENANT,
    source: "OFX",
    status: "COMPLETED",
    periodLabel: "2026-09",
    totalAmountCents: 10_000,
  });
  expect(
    await setup.creditCardStatementImport.count({
      where: { tenantId: TENANT, cardId },
    }),
  ).toBe(1);
  expect(
    (await setup.expense.findUniqueOrThrow({ where: { id: p.id } })).importId,
  ).toBe(current.id);
  const octoberDate = new Date("2026-10-05T00:00:00.000Z");
  expect(
    (octoberDate.getTime() - current.createdAt.getTime()) / 86_400_000,
  ).toBeLessThan(75);
  const entries = await setup.cashFlowEntry.findMany({
    where: { expenseId: p.id },
    orderBy: { data: "asc" },
  });
  expect(entries.map((e) => [e.id, e.valor, e.status, e.parcela])).toEqual([
    [p.entryIds[0], 10_000, "PAGO", "1/3"],
    [p.entryIds[1], 10_000, "PLANEJADO", "2/3"],
    [p.entryIds[2], 10_000, "PLANEJADO", "3/3"],
  ]);
  // Chamada read-only à preparação PRIMÁRIA REAL: só outubro é pagável.
  const prepared = await prisma.$transaction((tx) =>
    settlement.prepareSettleInvoice({
      tenantId: TENANT,
      card: { id: cardId, last4: CARD, closingDay: 20, dueDay: 1 },
      amountCents: 10_000,
      paymentDate: octoberDate,
      tx,
      requester: ADMIN,
    }),
  );
  expect(
    prepared.purchases.flatMap((item) => item.entries.map((e) => e.id)),
  ).toEqual([p.entryIds[1]]);
  const before = await fullSnapshot();
  console.log("B3 ARRANGE_OK", {
    source: current.source,
    currentCCStatementImportId: current.id,
    purchaseImportId: current.id,
    bankImportId: september.committed.importId,
    septemberClaimDueMonth: september.claims[0].dueMonth,
    primaryOctoberEntryId: p.entryIds[1],
  });

  const outcome = await observe(() =>
    monthly.payInvoice(
      TENANT,
      A,
      {
        cardId,
        accountId,
        month: "2026-10",
        amountCents: 10_000,
        paymentDate: "2026-10-05",
      },
      ADMIN,
    ),
  );
  const after = await fullSnapshot();
  diagnostic("B3 ACT", outcome.error);
  expect(outcome.error).toBeNull();
  expect(outcome.value).toMatchObject({
    ok: true,
    settledParcelas: 1,
    settledExpenses: 1,
  });
  expect(
    after.entries
      .filter((e) => e.expenseId === p.id)
      .map((e) => e.id)
      .sort(),
  ).toEqual([...p.entryIds].sort());
  expect(
    (
      await setup.cashFlowEntry.findMany({
        where: { expenseId: p.id },
        orderBy: { data: "asc" },
      })
    ).map((e) => [e.valor, e.status]),
  ).toEqual([
    [10_000, "PAGO"],
    [10_000, "PAGO"],
    [10_000, "PLANEJADO"],
  ]);
  expect(after.ledger).toEqual(before.ledger);
  expect(
    after.expenses.filter((e) => e.tipoDespesa === "PAGAMENTO_FATURA_CARTAO"),
  ).toHaveLength(2);
});

it("B4 hidden manual purchase: matching and nonmatching amounts both return 404 with zero writes", async () => {
  const hidden = await purchase(B, "2026-06-10T12:00:00.000Z", 1);
  const imported = await importedPayment(hidden.id, hidden.entryIds[0]);
  const hiddenRow = await setup.expense.findUniqueOrThrow({
    where: { id: hidden.id },
  });
  expect(hiddenRow).toMatchObject({
    projectId: B,
    importId: null,
    cardLast4: CARD,
    status: "PAGO",
    valorTotal: 10_000,
  });
  expect(imported.claims[0]).toMatchObject({
    purchaseExpenseId: hidden.id,
    cashFlowEntryId: hidden.entryIds[0],
    dueMonth: "2026-07",
  });
  expect(ONLY_A.allowedProjects).toEqual([A]);
  expect(
    (await setup.creditCard.findUniqueOrThrow({ where: { id: cardId } }))
      .projectId,
  ).toBe(A);
  expect(
    (await setup.bankAccount.findUniqueOrThrow({ where: { id: accountId } }))
      .projectId,
  ).toBe(A);
  const before = await fullSnapshot();
  console.log(
    "B4 ARRANGE_OK: ADMIN real import; B purchase importId=null; requester only A",
  );
  const statuses: Array<number | null> = [];
  for (const amountCents of [10_000, 77_777]) {
    const outcome = await observe(() =>
      monthly.payInvoice(
        TENANT,
        A,
        {
          cardId,
          accountId,
          month: "2026-08",
          amountCents,
          paymentDate: "2026-07-20",
        },
        ONLY_A,
      ),
    );
    diagnostic(`B4 ACT amountCents=${amountCents}`, outcome.error);
    statuses.push(errorStatus(outcome.error));
    expect(await fullSnapshot()).toEqual(before);
  }
  expect(statuses).toEqual([404, 404]);
});
