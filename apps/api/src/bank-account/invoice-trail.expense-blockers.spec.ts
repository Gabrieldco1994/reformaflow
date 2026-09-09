/**
 * #569 (degrau PR1) — blockers B1/B2 do fechamento EXPENSE.
 *
 * Evidência comportamental de que mutações genéricas de despesa (edição de um
 * lado de par cross-project vinculado e reabertura de parcela) NÃO podem
 * corromper a trilha de liquidação por importação (`imported_invoice_liquidations`).
 *
 * PrismaService real + banco descartável; nenhum service/delegate/resposta
 * mockado. Projetos/cartões/compras são fixtures; TODOS os claims de liquidação
 * abaixo são produzidos pelo `commitImport` real (via `commitStatement`).
 *
 * B1 e B2 reusam a fixture canônica `invoice-undo.fixtures`; os repros de
 * pagamento B3/B4 vivem no spec do outro owner e não são duplicados aqui.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_REQUESTER,
  commitStatement,
  makeBankAccountService,
  makeExpenseService,
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedInstallmentPurchase,
  seedPessoal,
  seedProject,
} from './__tests__/invoice-undo.fixtures';

const TENANT = 'rf569-expense-blockers';
const A = 'rf569-project-a';
const B = 'rf569-project-b';
const CARD = '5691';
const BANK = '5692';
const ADMIN = { id: ADMIN_REQUESTER.id, role: 'ADMIN' as const };
const setup = new PrismaClient();
const prisma = new PrismaService();
const bank = makeBankAccountService(prisma);
const expenses = makeExpenseService(prisma);
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
  const orderBy = { id: 'asc' as const };
  return {
    expenses: await setup.expense.findMany({ where, orderBy }),
    entries: await setup.cashFlowEntry.findMany({ where, orderBy }),
    ledger: await setup.importedInvoiceLiquidation.findMany({ where, orderBy }),
    imports: await setup.bankStatementImport.findMany({ where, orderBy }),
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
  await setup.expense.update({
    where: { id: seeded.id },
    data: { valor: parcelas * 10_000 },
  });
  const row = await setup.expense.findUniqueOrThrow({
    where: { id: seeded.id },
  });
  const entries = await setup.cashFlowEntry.findMany({
    where: { expenseId: seeded.id },
    orderBy: { data: 'asc' },
  });
  expect(row.valor * row.quantidade).toBe(row.valorTotal);
  expect(row.valorTotal).toBe(parcelas * 10_000);
  expect(entries.map((e) => [e.id, e.valor, e.status])).toEqual(
    seeded.entryIds.map((id) => [id, 10_000, 'PLANEJADO']),
  );
  return seeded;
}

async function importedPayment(
  expectedPurchaseId: string,
  expectedEntryId: string,
  date = '20260705',
  period = '2026-07',
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
    fitId: `rf569-${date}`,
  });
  const payment = await setup.expense.findFirstOrThrow({
    where: {
      tenantId: TENANT,
      importId: committed.importId,
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
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
    prevStatus: 'PLANEJADO',
    dueMonth: period,
  });
  expect(payment).toMatchObject({
    valor: 10_000,
    valorTotal: 10_000,
    invoiceUndoState: 'PROCESSED_SETTLED',
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
  ).toBe('PAGO');
  return { committed, payment, claims };
}

/**
 * Pagamento de fatura importado que NÃO liquida nada (0 flips) — carimbo
 * `PROCESSED_NONE` (estado 2a/2b do design). O cartão é resolvido pelo memo, mas
 * não há parcela em aberto na janela ⇒ zero linhas no ledger. É uma trilha REAL:
 * a proveniência durável é o carimbo, não a existência de itens (§1.2).
 */
async function importedNonePayment(date = '20260805', period = '2026-08') {
  const committed = await commitStatement(bank, {
    tenantId: TENANT,
    projectId: A,
    accountId,
    bankLast4: BANK,
    cardLast4: CARD,
    debitCents: 7_777, // não casa nenhuma parcela ⇒ 0 flips ⇒ PROCESSED_NONE
    date,
    period,
    requester: ADMIN,
    fitId: `rf569-none-${date}`,
  });
  const payment = await setup.expense.findFirstOrThrow({
    where: {
      tenantId: TENANT,
      importId: committed.importId,
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
    },
  });
  expect(payment.invoiceUndoState).toBe('PROCESSED_NONE');
  expect(
    await setup.importedInvoiceLiquidation.count({
      where: { tenantId: TENANT, deletedAt: null },
    }),
  ).toBe(0);
  return { committed, payment };
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
    type: 'REFORMA',
    name: 'Projeto B',
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

it('B1 title-only update of valid linked common expense preserves the claimed purchase installment IDs and money', async () => {
  const p = await purchase(A, '2026-06-10T12:00:00.000Z');
  // Cria a despesa comum do lado REFORMA e o vínculo pelo service real.
  const common = await expenses.create(
    TENANT,
    B,
    {
      tipoDespesa: 'MATERIAL',
      valor: 300,
      quantidade: 1,
      titulo: 'par original',
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: '2026-06-10',
      dataCompra: '2026-06-10',
      status: 'PLANEJADO',
      linkedExpenseId: p.id,
    },
    null,
    undefined,
    ADMIN,
  );
  expect(common).toMatchObject({
    projectId: B,
    linkedExpenseId: p.id,
    cardLast4: null,
    valorTotal: 30_000,
  });
  expect(
    await setup.crossProjectSettlement.count({ where: { tenantId: TENANT } }),
  ).toBe(0);
  expect(
    await setup.rateioAllocation.count({ where: { tenantId: TENANT } }),
  ).toBe(0);
  await importedPayment(p.id, p.entryIds[0]);
  const before = await fullSnapshot();
  const priorEntries = before.entries.filter((e) => e.expenseId === p.id);
  expect(priorEntries.map((e) => e.id).sort()).toEqual([...p.entryIds].sort());
  expect(priorEntries.every((e) => e.deletedAt === null)).toBe(true);
  console.log('B1 ARRANGE_OK: real linked create + real imported claim');

  const outcome = await observe(() =>
    expenses.update(TENANT, B, common.id, { titulo: 'par renomeado' }, ADMIN),
  );
  const after = await fullSnapshot();
  diagnostic('B1 ACT', outcome.error);
  expect(outcome.error).toBeNull();
  expect(after.expenses.find((e) => e.id === common.id)?.titulo).toBe(
    'par renomeado',
  );
  expect(after.entries.filter((e) => e.expenseId === p.id)).toEqual(
    priorEntries,
  );
  expect(after.ledger).toEqual(before.ledger);
  expect(after.expenses.find((e) => e.id === p.id)).toMatchObject({
    valor: 30_000,
    valorTotal: 30_000,
    status: before.expenses.find((e) => e.id === p.id)!.status,
    paidParcelas: before.expenses.find((e) => e.id === p.id)!.paidParcelas,
  });
});

it('B2 setParcelaStatus(paid:false) rejects an import-paid installment with 409 and zero writes', async () => {
  const p = await purchase(A, '2026-06-10T12:00:00.000Z');
  await importedPayment(p.id, p.entryIds[0]);
  const before = await fullSnapshot();
  const row = before.expenses.find((e) => e.id === p.id)!;
  expect(row).toMatchObject({
    formaPagamento: 'PARCELADO',
    quantidadeParcela: 3,
    valorTotal: 30_000,
  });
  expect(JSON.parse(row.paidParcelas!)).toContain(0);
  console.log('B2 ARRANGE_OK: installment 0 paid by real import, 1/3 claim');

  const outcome = await observe(() =>
    expenses.setParcelaStatus(TENANT, A, p.id, 0, false),
  );
  const after = await fullSnapshot();
  diagnostic('B2 ACT', outcome.error);
  console.log('B2 POST', {
    previousClaimedEntryDeleted:
      after.entries.find((e) => e.id === p.entryIds[0])?.deletedAt !== null,
    currentPurchasePaidParcelas: after.expenses.find((e) => e.id === p.id)
      ?.paidParcelas,
    liveStatuses: after.entries
      .filter((e) => e.expenseId === p.id && !e.deletedAt)
      .map((e) => e.status),
  });
  expect(errorStatus(outcome.error)).toBe(409);
  expect(after).toEqual(before);
});

it('Bmix ratearMixed rejects splitting an import-claimed purchase with 409 and zero writes', async () => {
  const p = await purchase(A, '2026-06-10T12:00:00.000Z');
  await importedPayment(p.id, p.entryIds[0]);
  const before = await fullSnapshot();
  expect(before.allocations).toHaveLength(0);
  expect(
    before.expenses.find((e) => e.id === p.id),
  ).toMatchObject({ valorTotal: 30_000, linkedExpenseId: null });
  console.log('Bmix ARRANGE_OK: claimed source, no prior rateio');

  const outcome = await observe(() =>
    expenses.ratearMixed(
      TENANT,
      A,
      p.id,
      {
        newTargets: [
          {
            targetProjectId: B,
            tipoDespesa: 'MATERIAL',
            valor: 300,
            quantidade: 1,
            allocation: 30_000,
          },
        ],
        existing: [],
      },
      ADMIN.id,
      ADMIN,
    ),
  );
  const after = await fullSnapshot();
  diagnostic('Bmix ACT', outcome.error);
  expect(errorStatus(outcome.error)).toBe(409);
  expect(after).toEqual(before);
});

it('B5-none removing a PROCESSED_NONE stamped card payment (carimbo, zero itens) is rejected with 409 and zero writes', async () => {
  const { payment } = await importedNonePayment();
  const before = await fullSnapshot();
  expect(before.ledger).toHaveLength(0);
  expect(before.expenses.find((e) => e.id === payment.id)?.invoiceUndoState).toBe(
    'PROCESSED_NONE',
  );
  console.log('B5-none ARRANGE_OK: stamped PROCESSED_NONE payment, empty ledger');

  const outcome = await observe(() => expenses.remove(TENANT, A, payment.id, ADMIN));
  const after = await fullSnapshot();
  diagnostic('B5-none ACT', outcome.error);
  expect(errorStatus(outcome.error)).toBe(409);
  expect(after).toEqual(before);
});

it('B9-none reclassifying a PROCESSED_NONE stamped payment to a non-neutral type is 409, while safe descriptive edits stay allowed and preserve the carimbo', async () => {
  const { payment } = await importedNonePayment();
  const before = await fullSnapshot();
  console.log('B9-none ARRANGE_OK: stamped PROCESSED_NONE payment');

  // Reclassificação para tipo INCOMPATÍVEL (não-neutro) ⇒ 409, zero escritas.
  const blocked = await observe(() =>
    expenses.update(TENANT, A, payment.id, { tipoDespesa: 'MATERIAL' }, ADMIN),
  );
  const afterBlocked = await fullSnapshot();
  diagnostic('B9-none reclassify', blocked.error);
  expect(errorStatus(blocked.error)).toBe(409);
  expect(afterBlocked).toEqual(before);

  // Exceção preservada: edição descritiva segura permanece PERMITIDA; carimbo intacto.
  const allowed = await observe(() =>
    expenses.update(TENANT, A, payment.id, { titulo: 'pagamento renomeado' }, ADMIN),
  );
  diagnostic('B9-none descriptive', allowed.error);
  expect(allowed.error).toBeNull();
  const raw = await setup.expense.findUniqueOrThrow({ where: { id: payment.id } });
  expect(raw).toMatchObject({
    titulo: 'pagamento renomeado',
    tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
    invoiceUndoState: 'PROCESSED_NONE',
    importId: payment.importId,
  });
  expect(
    await setup.importedInvoiceLiquidation.count({
      where: { tenantId: TENANT, deletedAt: null },
    }),
  ).toBe(0);
});
