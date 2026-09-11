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
const BANKB = "5723";
const GENERIC_INVOICE_NOT_FOUND = "Recurso não encontrado";
const GENERIC_IMPORT_TRAIL_MESSAGE =
  "INVOICE_HAS_IMPORT_TRAIL: uma parcela desta fatura foi liquidada " +
  "por uma importação de extrato. Desfaça a importação para reabrir a fatura.";
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

/**
 * Vincula a compra a um `CreditCardStatementImport` REAL do cartão (total = uma
 * fatura de R$100), habilitando a Estratégia 2 (fallback por fatura importada)
 * de `prepareSettleInvoice`/`resolveEffectiveDueMonths`. `createdAt` controla a
 * janela de 75d de `findImportByTotal`.
 */
async function linkCurrentStatement(purchaseId: string, createdAtIso: string) {
  const ccImport = await setup.creditCardStatementImport.create({
    data: {
      id: `iul-blockers-cc-${purchaseId}`,
      tenantId: TENANT,
      cardId,
      source: "OFX",
      status: "COMPLETED",
      inserted: 1,
      periodLabel: "cc-statement",
      totalAmountCents: 10_000,
      createdAt: new Date(createdAtIso),
    },
  });
  await setup.expense.update({
    where: { id: purchaseId },
    data: { importId: ccImport.id },
  });
  return ccImport;
}

type ResolveCard = {
  id: string;
  last4: string;
  closingDay: number | null;
  dueDay: number | null;
};

/** `resolveEffectiveDueMonths` REAL, ordenado, contra PrismaService real. */
async function effectiveMonths(
  card: ResolveCard,
  amountCents: number,
  paymentDate: Date,
) {
  const months = await prisma.$transaction((tx) =>
    settlement.resolveEffectiveDueMonths({
      tenantId: TENANT,
      card,
      amountCents,
      paymentDate,
      tx,
    }),
  );
  return [...months].sort();
}

/**
 * A resolução AUTORIZADA REAL (`prepareSettleInvoice`) — os ids das parcelas que
 * um pagamento EFETIVAMENTE viraria. `resolveEffectiveDueMonths` tem de espelhar
 * ESTA seleção (mesma precedência vencimento→fallback), nunca o histórico todo.
 */
async function preparedEntryIds(
  card: ResolveCard,
  amountCents: number,
  paymentDate: Date,
) {
  const prepared = await prisma.$transaction((tx) =>
    settlement.prepareSettleInvoice({
      tenantId: TENANT,
      card,
      amountCents,
      paymentDate,
      tx,
      requester: ADMIN,
    }),
  );
  return prepared.purchases.flatMap((item) => item.entries.map((e) => e.id));
}

/**
 * #569 runtime tie — compra 90000 = 3×30000 (08-05/09-10/10-10, fecha 20 vence
 * 1) → faturas set/out/nov de 30000 cada. Espelha `purchase`, mas com o valor
 * do runtime real (design §hipótese). `valor × quantidade = valorTotal`.
 */
async function tiePurchase() {
  const seeded = await seedInstallmentPurchase(setup, {
    tenantId: TENANT,
    projectId: A,
    cardLast4: CARD,
    parcelas: 3,
    valorCents: 30_000,
    primeiraData: new Date("2026-08-05T12:00:00.000Z"),
  });
  await setup.expense.update({
    where: { id: seeded.id },
    data: { valor: 90_000 },
  });
  const row = await setup.expense.findUniqueOrThrow({ where: { id: seeded.id } });
  expect(row.valor * row.quantidade).toBe(row.valorTotal);
  expect(row.valorTotal).toBe(90_000);
  const entries = await setup.cashFlowEntry.findMany({
    where: { expenseId: seeded.id },
    orderBy: { data: "asc" },
  });
  expect(entries.map((e) => [e.valor, e.status])).toEqual([
    [30_000, "PLANEJADO"],
    [30_000, "PLANEJADO"],
    [30_000, "PLANEJADO"],
  ]);
  return seeded;
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

// ── B3 (mesma raiz) — precedência IDÊNTICA a prepareSettleInvoice ────────────
// (1) alvo por vencimento só interrompe o resolver quando há parcela PLANEJADO
//     real (senão cai no fallback, igual a `if (prepared.length > 0) return`);
// (2) fallback seleciona só a PRIMEIRA parcela PLANEJADO de cada compra
//     (`prepareEarliestSettlement`), nunca TODAS as CFEs do histórico.

it("no-ciclo: uma parcela histórica já liquidada NÃO pode bloquear o pagamento da SEGUNDA (resolver espelha prepareEarliestSettlement, não enumera todas as CFEs)", async () => {
  await setup.creditCard.update({
    where: { id: cardId },
    data: { closingDay: null, dueDay: null },
  });
  const card: ResolveCard = { id: cardId, last4: CARD, closingDay: null, dueDay: null };
  // Compra parcelada sem ciclo: dueMonth = mês da própria CFE (jul/ago/set).
  const p = await purchase(A, "2026-07-05T12:00:00.000Z");
  await linkCurrentStatement(p.id, "2026-07-01T12:00:00.000Z");
  // Import REAL deixa a PRIMEIRA parcela paga (claim de julho, da data real da CFE).
  const first = await importedPayment(p.id, p.entryIds[0], "20260705", "2026-07");
  expect(first.claims[0].dueMonth).toBe("2026-07");
  expect(
    (
      await setup.cashFlowEntry.findMany({
        where: { expenseId: p.id },
        orderBy: { data: "asc" },
      })
    ).map((e) => e.status),
  ).toEqual(["PAGO", "PLANEJADO", "PLANEJADO"]);

  const paymentDate = new Date("2026-08-05T00:00:00.000Z");
  // Preparação REAL seguinte seleciona SÓ a segunda parcela.
  expect(await preparedEntryIds(card, 10_000, paymentDate)).toEqual([p.entryIds[1]]);
  // O resolver deve devolver SÓ agosto — não o histórico {jul, ago, set}.
  expect(await effectiveMonths(card, 10_000, paymentDate)).toEqual(["2026-08"]);

  const before = await fullSnapshot();
  const outcome = await observe(() =>
    monthly.payInvoice(
      TENANT,
      A,
      { cardId, accountId, month: "2026-08", amountCents: 10_000, paymentDate: "2026-08-05" },
      ADMIN,
    ),
  );
  diagnostic("no-ciclo second payment", outcome.error);
  expect(outcome.error).toBeNull();
  expect(outcome.value).toMatchObject({ ok: true, settledParcelas: 1, settledExpenses: 1 });
  expect(
    (
      await setup.cashFlowEntry.findMany({
        where: { expenseId: p.id },
        orderBy: { data: "asc" },
      })
    ).map((e) => e.status),
  ).toEqual(["PAGO", "PAGO", "PLANEJADO"]);
  const after = await fullSnapshot();
  // Claim de julho preservado; um novo PAGAMENTO_FATURA_CARTAO.
  expect(after.ledger).toEqual(before.ledger);
  expect(
    after.expenses.filter((e) => e.tipoDespesa === "PAGAMENTO_FATURA_CARTAO"),
  ).toHaveLength(2);
});

it("com ciclo: alvo por vencimento resolvido MAS sem parcela PLANEJADO cai no fallback — o resolver NÃO pode fixar o mês já pago", async () => {
  const card: ResolveCard = { id: cardId, last4: CARD, closingDay: 20, dueDay: 1 };
  // Compra 08-10/09-10/10-10 → caixa set/out/nov (fecha 20, vence dia 1).
  const p = await purchase(A, "2026-08-10T12:00:00.000Z");
  await linkCurrentStatement(p.id, "2026-08-20T12:00:00.000Z");
  // Import REAL fecha a fatura de SETEMBRO (parcela 1). Claim dueMonth 2026-09.
  const september = await importedPayment(p.id, p.entryIds[0], "20260905", "2026-09");
  expect(september.claims[0].dueMonth).toBe("2026-09");

  // paymentDate 06/09 (≠ 05/09 da importação: evita a dedup de pagamento
  // idêntico) + valor exato → janela {2026-09, 2026-10}; empate resolve ALVO
  // 2026-09, que já está PAGO (0 PLANEJADO) → prepare real cai no fallback e
  // seleciona a parcela de OUTUBRO.
  const paymentDate = new Date("2026-09-06T00:00:00.000Z");
  expect(await preparedEntryIds(card, 10_000, paymentDate)).toEqual([p.entryIds[1]]);
  // O resolver tem de acompanhar o fallback → 2026-10 (não o alvo pago 2026-09).
  expect(await effectiveMonths(card, 10_000, paymentDate)).toEqual(["2026-10"]);

  const before = await fullSnapshot();
  const outcome = await observe(() =>
    monthly.payInvoice(
      TENANT,
      A,
      { cardId, accountId, month: "2026-10", amountCents: 10_000, paymentDate: "2026-09-06" },
      ADMIN,
    ),
  );
  diagnostic("ciclo target-paid falls to fallback", outcome.error);
  expect(outcome.error).toBeNull();
  expect(outcome.value).toMatchObject({ ok: true, settledParcelas: 1, settledExpenses: 1 });
  expect(
    (
      await setup.cashFlowEntry.findMany({
        where: { expenseId: p.id },
        orderBy: { data: "asc" },
      })
    ).map((e) => e.status),
  ).toEqual(["PAGO", "PAGO", "PLANEJADO"]);
  const after = await fullSnapshot();
  expect(after.ledger).toEqual(before.ledger); // claim de setembro intacto
});

// ── #569 TIE (raiz do runtime) — pagar OUTUBRO com data em SETEMBRO ──────────
// A fatura de setembro (30000) foi liquidada por importação; o usuário paga a
// fatura de OUTUBRO (30000) com data 10/09 → janela {2026-09, 2026-10} e EMPATE
// exato de valor. SEM CreditCardStatementImport casável no fallback, o empate
// antigo (mês mais antigo) fixa SETEMBRO (já pago) e a identidade recuperada
// dispara 409 falso. `selectedDueMonth` (dto.month = 2026-10) desempata para
// OUTUBRO, que não tem trilha, e a parcela de outubro é liquidada.
it("TIE: outubro pago com data de setembro (empate set/out) liquida OUTUBRO, não dispara 409 da trilha de setembro", async () => {
  const p = await tiePurchase();
  // Importação REAL (28/08) fecha SÓ a fatura de SETEMBRO (parcela 1).
  const sept = await commitStatement(bank, {
    tenantId: TENANT,
    projectId: A,
    accountId,
    bankLast4: BANK,
    cardLast4: CARD,
    debitCents: 30_000,
    date: "20260828",
    period: "2026-09",
    requester: ADMIN,
    fitId: "iul-tie-sept",
  });
  const septClaims = await setup.importedInvoiceLiquidation.findMany({
    where: { tenantId: TENANT, deletedAt: null },
  });
  expect(septClaims).toHaveLength(1);
  expect(septClaims[0]).toMatchObject({
    purchaseExpenseId: p.id,
    cashFlowEntryId: p.entryIds[0],
    dueMonth: "2026-09",
    entryValorCents: 30_000,
  });
  expect(
    (await setup.cashFlowEntry.findUniqueOrThrow({ where: { id: p.entryIds[0] } }))
      .status,
  ).toBe("PAGO");
  // Sem CreditCardStatementImport algum ⇒ fallback por fatura importada é vazio.
  expect(
    await setup.creditCardStatementImport.count({ where: { tenantId: TENANT } }),
  ).toBe(0);

  const before = await fullSnapshot();
  const outcome = await observe(() =>
    monthly.payInvoice(
      TENANT,
      A,
      {
        cardId,
        accountId,
        month: "2026-10",
        amountCents: 30_000,
        paymentDate: "2026-09-10",
      },
      ADMIN,
    ),
  );
  diagnostic("TIE october-paid-in-september", outcome.error);
  expect(outcome.error).toBeNull();
  expect(outcome.value).toMatchObject({
    ok: true,
    settledParcelas: 1,
    settledExpenses: 1,
  });

  const entriesAfter = await setup.cashFlowEntry.findMany({
    where: { expenseId: p.id },
    orderBy: { data: "asc" },
  });
  // set PAGO (import intacto), out PAGO (novo pagamento manual), nov PLANEJADO;
  // ids das CFEs inalterados.
  expect(entriesAfter.map((e) => [e.id, e.valor, e.status])).toEqual([
    [p.entryIds[0], 30_000, "PAGO"],
    [p.entryIds[1], 30_000, "PAGO"],
    [p.entryIds[2], 30_000, "PLANEJADO"],
  ]);
  const after = await fullSnapshot();
  // Ledger de setembro byte-idêntico (nada tocado).
  expect(after.ledger).toEqual(before.ledger);
  // Exatamente 1 novo PAGAMENTO_FATURA_CARTAO (import de set + manual de out).
  const payments = after.expenses.filter(
    (e) => e.tipoDespesa === "PAGAMENTO_FATURA_CARTAO",
  );
  expect(payments).toHaveLength(2);
  const manual = payments.find((e) => e.importId === null);
  expect(manual).toMatchObject({ valor: 30_000, valorTotal: 30_000 });
  expect(manual?.dataPagamento?.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  // O import de setembro existiu de fato (âncora do 409 antigo).
  expect(sept.importId).toBeTruthy();
});

it("TIE negativo: selecionar SETEMBRO (já importada) continua 409 sem escrita alguma", async () => {
  const p = await tiePurchase();
  await commitStatement(bank, {
    tenantId: TENANT,
    projectId: A,
    accountId,
    bankLast4: BANK,
    cardLast4: CARD,
    debitCents: 30_000,
    date: "20260828",
    period: "2026-09",
    requester: ADMIN,
    fitId: "iul-tie-sept-neg",
  });
  expect(
    (await setup.cashFlowEntry.findUniqueOrThrow({ where: { id: p.entryIds[0] } }))
      .status,
  ).toBe("PAGO");

  const before = await fullSnapshot();
  const outcome = await observe(() =>
    monthly.payInvoice(
      TENANT,
      A,
      {
        cardId,
        accountId,
        month: "2026-09",
        amountCents: 30_000,
        paymentDate: "2026-09-10",
      },
      ADMIN,
    ),
  );
  diagnostic("TIE negative select-september", outcome.error);
  expect(errorStatus(outcome.error)).toBe(409);
  expect(await fullSnapshot()).toEqual(before); // zero escrita
});

it("TIE guard: mês selecionado que NÃO casa o valor não sobrepõe o casamento de valor elegível", async () => {
  // Fatura de OUTUBRO inflada por uma compra extra (30000 parcela + 20000 avulsa
  // = 50000). Pagamento de 30000/10-09 casa EXATO só SETEMBRO. Selecionar
  // OUTUBRO (mês inflado) NÃO pode roubar o alvo: diff de out é pior, então o
  // resolver mantém setembro (nenhuma importação/trilha aqui).
  const p = await tiePurchase();
  const extra = await seedInstallmentPurchase(setup, {
    tenantId: TENANT,
    projectId: A,
    cardLast4: CARD,
    parcelas: 1,
    valorCents: 20_000,
    primeiraData: new Date("2026-09-05T12:00:00.000Z"), // fecha 20/09 → out
  });
  await setup.expense.update({
    where: { id: extra.id },
    data: { valor: 20_000 },
  });

  const before = await fullSnapshot();
  const outcome = await observe(() =>
    monthly.payInvoice(
      TENANT,
      A,
      {
        cardId,
        accountId,
        month: "2026-10", // seleciona outubro, mas 30000 casa setembro
        amountCents: 30_000,
        paymentDate: "2026-09-10",
      },
      ADMIN,
    ),
  );
  diagnostic("TIE guard select-oct-amount-matches-sept", outcome.error);
  expect(outcome.error).toBeNull();
  expect(outcome.value).toMatchObject({ ok: true, settledParcelas: 1 });
  // Setembro (parcela 1) é o alvo pelo VALOR; outubro/nov ficam PLANEJADO.
  const entriesAfter = await setup.cashFlowEntry.findMany({
    where: { expenseId: p.id },
    orderBy: { data: "asc" },
  });
  expect(entriesAfter.map((e) => e.status)).toEqual([
    "PAGO",
    "PLANEJADO",
    "PLANEJADO",
  ]);
  const after = await fullSnapshot();
  expect(after.ledger).toEqual(before.ledger);
});

it("TIE tolerância: a preferência do mês selecionado exige que ELE caia na PRÓPRIA tolerância — empate de diff onde outubro é INVÁLIDO mantém setembro (válido)", async () => {
  const card = { id: cardId, last4: CARD, closingDay: 20, dueDay: 1 };
  // Setembro: total 50250 → diff 250, tol max(200,round(251.25))=251 → VÁLIDO.
  const sep = await seedInstallmentPurchase(setup, {
    tenantId: TENANT,
    projectId: A,
    cardLast4: CARD,
    parcelas: 1,
    valorCents: 50_250,
    primeiraData: new Date("2026-08-05T12:00:00.000Z"), // fecha 20/08 → set
  });
  await setup.expense.update({ where: { id: sep.id }, data: { valor: 50_250 } });
  // Outubro: total 49750 → diff 250, tol max(200,round(248.75))=249 → INVÁLIDO.
  const oct = await seedInstallmentPurchase(setup, {
    tenantId: TENANT,
    projectId: A,
    cardLast4: CARD,
    parcelas: 1,
    valorCents: 49_750,
    primeiraData: new Date("2026-09-05T12:00:00.000Z"), // fecha 20/09 → out
  });
  await setup.expense.update({ where: { id: oct.id }, data: { valor: 49_750 } });

  const paymentDate = new Date("2026-09-10T00:00:00.000Z"); // janela {set, out}
  // Seleciona OUTUBRO, mas no EMPATE de diff (250=250) outubro está FORA da sua
  // própria tolerância (250 > 249). A preferência NÃO pode roubar setembro, que
  // fecha dentro da sua (250 ≤ 251) — senão o resolver devolveria null e nada
  // seria liquidado, apesar de existir fatura fechável.
  const prepared = await prisma.$transaction((tx) =>
    settlement.prepareSettleInvoice({
      tenantId: TENANT,
      card,
      amountCents: 50_000,
      paymentDate,
      tx,
      requester: ADMIN,
      selectedDueMonth: "2026-10",
    }),
  );
  expect(prepared.purchases.flatMap((p) => p.entries.map((e) => e.id))).toEqual([
    sep.entryIds[0],
  ]);

  // Controle: caminho de importação (SEM preferência) escolhe o MESMO setembro
  // (global best por diff → mais antigo → válido). O fix não altera isso.
  const noPref = await prisma.$transaction((tx) =>
    settlement.prepareSettleInvoice({
      tenantId: TENANT,
      card,
      amountCents: 50_000,
      paymentDate,
      tx,
      requester: ADMIN,
    }),
  );
  expect(noPref.purchases.flatMap((p) => p.entries.map((e) => e.id))).toEqual([
    sep.entryIds[0],
  ]);
});

it("no-ciclo: fatura JÁ integralmente paga por importação segue bloqueada pela identidade recuperada mesmo com dto.month mentiroso (recupera identity quando as CFEs PAGO não têm flip)", async () => {
  await setup.creditCard.update({
    where: { id: cardId },
    data: { closingDay: null, dueDay: null },
  });
  const card: ResolveCard = { id: cardId, last4: CARD, closingDay: null, dueDay: null };
  const p = await purchase(A, "2026-07-05T12:00:00.000Z", 1);
  await linkCurrentStatement(p.id, "2026-07-01T12:00:00.000Z");
  await importedPayment(p.id, p.entryIds[0], "20260705", "2026-07"); // paga tudo

  const paymentDate = new Date("2026-07-20T00:00:00.000Z");
  // Nada a virar; o resolver recupera a identidade (2026-07) para o pré-check.
  expect(await preparedEntryIds(card, 10_000, paymentDate)).toEqual([]);
  expect(await effectiveMonths(card, 10_000, paymentDate)).toEqual(["2026-07"]);

  const before = await fullSnapshot();
  const outcome = await observe(() =>
    monthly.payInvoice(
      TENANT,
      A,
      // dto.month MENTE ('2026-11'); o bloqueio tem de vir da identidade recuperada.
      { cardId, accountId, month: "2026-11", amountCents: 10_000, paymentDate: "2026-07-20" },
      ADMIN,
    ),
  );
  diagnostic("no-ciclo fully-paid stays blocked", outcome.error);
  expect(errorStatus(outcome.error)).toBe(409);
  expect(await fullSnapshot()).toEqual(before); // zero escrita
});

// ── SEC-1 (#569, §4 B1 cross-project) — desfazer manual do cockpit ───────────
// `undoInvoicePayment` autoriza (ACL da compra) ANTES de consultar a trilha de
// importação. Um ator SEM ACL sobre a compra PAGA de OUTRO projeto do cartão
// compartilhado recebe o MESMO 404 com ou sem claim ativa — a divergência
// 404/409 vazaria a existência de uma liquidação em projeto invisível (oráculo).
// A trilha (claim) sai de um `commitImport` REAL do dono do projeto oculto.
it("SEC-1 undoInvoicePayment: compra PAGA do ciclo em projeto INVISÍVEL ⇒ ator restrito 404 IDÊNTICO com e sem claim de importação (sem oráculo); ADMIN autorizado 409; zero escrita", async () => {
  // O dono do projeto B tem a PRÓPRIA conta e importa o PRÓPRIO extrato.
  const { id: accountIdB } = await seedBankAccount(setup, {
    tenantId: TENANT,
    projectId: B,
    last4: BANKB,
  });

  // Compra VISÍVEL (A) da fatura 2026-07, quitada por um pagamento manual.
  const visible = await purchase(A, "2026-06-10T12:00:00.000Z", 1);
  await setup.cashFlowEntry.update({
    where: { id: visible.entryIds[0] },
    data: { status: "PAGO" },
  });
  await setup.expense.update({
    where: { id: visible.id },
    data: { status: "PAGO" },
  });

  // Compra OCULTA (B = REFORMA, invisível a um requester só-A) no MESMO ciclo.
  const hidden = await purchase(B, "2026-06-12T12:00:00.000Z", 1);

  // Liquidação REAL: o dono de B importa o extrato (R$200 = fatura A+B do ciclo).
  // Só a parcela AINDA PLANEJADO (a de B) vira PAGO ⇒ 1 claim ancorada SÓ em B.
  const committed = await commitStatement(bank, {
    tenantId: TENANT,
    projectId: B,
    accountId: accountIdB,
    bankLast4: BANKB,
    cardLast4: CARD,
    debitCents: 20_000,
    date: "20260705",
    period: "2026-07",
    requester: ADMIN,
    fitId: "iul-sec1-hidden-B",
  });
  const claim = await setup.importedInvoiceLiquidation.findFirstOrThrow({
    where: { tenantId: TENANT, deletedAt: null },
  });
  expect(claim).toMatchObject({
    purchaseExpenseId: hidden.id,
    cashFlowEntryId: hidden.entryIds[0],
    dueMonth: "2026-07",
  });
  const importPayment = await setup.expense.findFirstOrThrow({
    where: {
      tenantId: TENANT,
      importId: committed.importId,
      tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
    },
  });
  // O pagamento importado nasce em B (não é candidato do desfazer manual de A).
  expect(importPayment.projectId).toBe(B);
  expect(
    (await setup.cashFlowEntry.findUniqueOrThrow({ where: { id: hidden.entryIds[0] } }))
      .status,
  ).toBe("PAGO");

  // Pagamento MANUAL legítimo do ciclo, em A (importId null) — casa com 2026-07.
  await setup.expense.create({
    data: {
      tenantId: TENANT,
      projectId: A,
      tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
      titulo: "pagamento manual A",
      valor: 10_000,
      quantidade: 1,
      valorTotal: 10_000,
      formaPagamento: "A_VISTA",
      dataPagamento: new Date("2026-06-28T12:00:00.000Z"),
      status: "PAGO",
      cardLast4: CARD,
      bankLast4: BANK,
    },
  });

  expect(ONLY_A.allowedProjects).toEqual([A]);
  expect(
    (await setup.project.findUniqueOrThrow({ where: { id: B } })).type,
  ).toBe("REFORMA");
  console.log(
    "SEC-1 ARRANGE_OK: real import claim on hidden B; manual payment in A; requester only A",
  );

  // CONTROLE: ator com ACL TOTAL (ADMIN) enxerga a compra PAGA de B; a claim
  // cross-project bloqueia o desfazer manual ⇒ 409 genérico; zero escrita.
  const beforeAdmin = await fullSnapshot();
  const admin = await observe(() =>
    monthly.undoInvoicePayment(TENANT, A, { cardId, dueMonth: "2026-07" }, ADMIN),
  );
  diagnostic("SEC-1 ADMIN autorizado", admin.error);
  expect(errorStatus(admin.error)).toBe(409);
  expect((admin.error as Error).message).toBe(GENERIC_IMPORT_TRAIL_MESSAGE);
  expect(await fullSnapshot()).toEqual(beforeAdmin);

  // MUNDO 1 (claim PRESENTE): ator restrito não enxerga a compra PAGA de B ⇒
  // 404 de ACL — a autorização precede a consulta de trilha, então NUNCA 409.
  const before1 = await fullSnapshot();
  const world1 = await observe(() =>
    monthly.undoInvoicePayment(TENANT, A, { cardId, dueMonth: "2026-07" }, ONLY_A),
  );
  diagnostic("SEC-1 restrito COM claim", world1.error);
  expect(await fullSnapshot()).toEqual(before1);

  // MUNDO 2 (claim AUSENTE, compra de B AINDA paga): remove só a trilha.
  await setup.importedInvoiceLiquidation.deleteMany({ where: { tenantId: TENANT } });
  const before2 = await fullSnapshot();
  const world2 = await observe(() =>
    monthly.undoInvoicePayment(TENANT, A, { cardId, dueMonth: "2026-07" }, ONLY_A),
  );
  diagnostic("SEC-1 restrito SEM claim", world2.error);
  expect(await fullSnapshot()).toEqual(before2);

  // Dois mundos comparáveis: MESMO 404, MESMA mensagem genérica (sem oráculo de
  // existência da liquidação oculta).
  expect([errorStatus(world1.error), errorStatus(world2.error)]).toEqual([404, 404]);
  expect((world1.error as Error).message).toBe((world2.error as Error).message);
  expect((world1.error as Error).message).toBe(GENERIC_INVOICE_NOT_FOUND);
  expect((world1.error as Error).message).not.toMatch(/IMPORT_TRAIL|liquidad|import/i);
});
