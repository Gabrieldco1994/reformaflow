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
  pessoalRequester,
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

// Spy PASSIVO de escritas: um `$use` adicional que apenas REGISTRA a ação e
// segue o pipeline (`next`). Registrado após o middleware de soft-delete (que o
// construtor do PrismaService instala), enxerga a ação já normalizada e roda
// inclusive dentro de `$transaction`. Gated por `recordWrites` para não custar
// nada fora do ato observado. Prova a diferença entre PREFLIGHT (zero escritas
// sequer TENTADAS) e ROLLBACK (escrita tentada e depois desfeita) — snapshot
// intacto não distingue os dois.
const WRITE_ACTIONS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);
let recordWrites = false;
const writeAttempts: string[] = [];
prisma.$use(async (params, next) => {
  if (recordWrites && WRITE_ACTIONS.has(params.action)) {
    writeAttempts.push(`${params.model ?? '?'}.${params.action}`);
  }
  return next(params);
});

async function observeWrites<T>(operation: () => Promise<T>) {
  writeAttempts.length = 0;
  recordWrites = true;
  try {
    return await observe(operation);
  } finally {
    recordWrites = false;
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

it('Btgt ratear into a target whose installment was partially settled by a real import is rejected with 409 and zero writes', async () => {
  // ALVO: compra parcelada 3x no cartão, em OUTRO projeto (B), parcialmente
  // liquidada por importação REAL — parcela 0 PAGO, 1 e 2 PLANEJADO. É um alvo
  // de rateio VÁLIDO em tudo o mais (cross-project, não-neutro, não conciliado);
  // só a trilha ativa como COMPRA o barra.
  const target = await purchase(B, '2026-06-10T12:00:00.000Z');
  await importedPayment(target.id, target.entryIds[0]);
  const claimed = await setup.importedInvoiceLiquidation.findMany({
    where: { tenantId: TENANT, purchaseExpenseId: target.id, deletedAt: null },
  });
  expect(claimed).toHaveLength(1);
  const targetEntries = await setup.cashFlowEntry.findMany({
    where: { expenseId: target.id },
    orderBy: { data: 'asc' },
  });
  expect(targetEntries.map((e) => e.status)).toEqual(['PAGO', 'PLANEJADO', 'PLANEJADO']);

  // FONTE: despesa PESSOAL sem cartão (o import não a toca), valorTotal fecha o
  // alvo. Criada pelo caminho de produção real.
  const source = await expenses.create(
    TENANT,
    A,
    {
      tipoDespesa: 'MATERIAL',
      valor: 300,
      quantidade: 1,
      titulo: 'compra pessoal a ratear',
      formaPagamento: 'A_VISTA',
      dataCompra: '2026-06-10',
      status: 'PLANEJADO',
    },
    null,
    undefined,
    ADMIN,
  );
  expect(source).toMatchObject({ projectId: A, valorTotal: 30_000, cardLast4: null });

  const before = await fullSnapshot();
  expect(before.allocations).toHaveLength(0);
  console.log('Btgt ARRANGE_OK: claimed cross-project target (1/3 paid by real import), clean source');

  const outcome = await observe(() =>
    expenses.ratear(TENANT, A, source.id, [{ targetExpenseId: target.id, allocation: 30_000 }], ADMIN),
  );
  const after = await fullSnapshot();
  diagnostic('Btgt ACT', outcome.error);
  console.log('Btgt POST', {
    liveClaimIds: after.ledger.filter((l) => l.deletedAt === null).map((l) => l.id),
    targetEntryStatuses: after.entries
      .filter((e) => e.expenseId === target.id && !e.deletedAt)
      .map((e) => e.status),
    allocations: after.allocations.length,
  });
  expect(errorStatus(outcome.error)).toBe(409);
  expect(after).toEqual(before);
});

it('Btgt-ok ratear into a clean (unclaimed) cross-project target still succeeds — the guard does not over-block', async () => {
  // Alvo LIMPO, sem qualquer trilha de importação. Prova que a guarda de #569
  // não bloqueia rateios legítimos.
  const target = await purchase(B, '2026-06-10T12:00:00.000Z');
  expect(
    await setup.importedInvoiceLiquidation.count({ where: { tenantId: TENANT, deletedAt: null } }),
  ).toBe(0);

  const source = await expenses.create(
    TENANT,
    A,
    {
      tipoDespesa: 'MATERIAL',
      valor: 300,
      quantidade: 1,
      titulo: 'compra pessoal a ratear (ok)',
      formaPagamento: 'A_VISTA',
      dataCompra: '2026-06-10',
      status: 'PLANEJADO',
    },
    null,
    undefined,
    ADMIN,
  );
  console.log('Btgt-ok ARRANGE_OK: clean cross-project target, no ledger');

  const outcome = await observe(() =>
    expenses.ratear(TENANT, A, source.id, [{ targetExpenseId: target.id, allocation: 30_000 }], ADMIN),
  );
  diagnostic('Btgt-ok ACT', outcome.error);
  expect(outcome.error).toBeNull();
  const allocations = await setup.rateioAllocation.findMany({
    where: { tenantId: TENANT, sourceExpenseId: source.id },
  });
  expect(allocations.map((a) => a.targetExpenseId)).toEqual([target.id]);
  expect(
    (await setup.expense.findUniqueOrThrow({ where: { id: source.id } })).linkedExpenseId,
  ).toBe(target.id);
});

it('Bmix-existing ratearMixed with an import-claimed EXISTING target + a NEW target is rejected BEFORE the first write (409, zero writes attempted, snapshot intact)', async () => {
  // ALVO EXISTENTE: compra parcelada 3x em B (cross-project), parcela 0 liquidada
  // por importação REAL — trilha ativa como COMPRA. Já existe ANTES da operação,
  // portanto é conhecido no preflight; os alvos NOVOS só nascem depois.
  const existingTarget = await purchase(B, '2026-06-10T12:00:00.000Z');
  await importedPayment(existingTarget.id, existingTarget.entryIds[0]);
  const claimed = await setup.importedInvoiceLiquidation.findMany({
    where: { tenantId: TENANT, purchaseExpenseId: existingTarget.id, deletedAt: null },
  });
  expect(claimed).toHaveLength(1);

  // FONTE limpa (sem cartão; o import não a toca). valorTotal fecha a soma
  // integral do rateio: existente 30k + novo 20k = 50k (Sobra=0).
  const source = await expenses.create(
    TENANT,
    A,
    {
      tipoDespesa: 'MATERIAL',
      valor: 500,
      quantidade: 1,
      titulo: 'fonte mixed a ratear',
      formaPagamento: 'A_VISTA',
      dataCompra: '2026-06-10',
      status: 'PLANEJADO',
    },
    null,
    undefined,
    ADMIN,
  );
  expect(source).toMatchObject({ projectId: A, valorTotal: 50_000, cardLast4: null });

  const before = await fullSnapshot();
  expect(before.allocations).toHaveLength(0);
  console.log('Bmix-existing ARRANGE_OK: claimed existing target (1/3 paid by real import) + clean source + pending new target');

  const outcome = await observeWrites(() =>
    expenses.ratearMixed(
      TENANT,
      A,
      source.id,
      {
        newTargets: [
          {
            targetProjectId: B,
            tipoDespesa: 'MATERIAL',
            valor: 200,
            quantidade: 1,
            allocation: 20_000,
          },
        ],
        existing: [{ targetExpenseId: existingTarget.id, allocation: 30_000 }],
      },
      ADMIN.id,
      ADMIN,
    ),
  );
  const after = await fullSnapshot();
  diagnostic('Bmix-existing ACT', outcome.error);
  console.log('Bmix-existing WRITE_ATTEMPTS', writeAttempts);
  expect(errorStatus(outcome.error)).toBe(409);
  // PREFLIGHT: o alvo NOVO não chegou a ser criado — zero escritas TENTADAS no
  // ato (não é rollback pós-escrita). Sem o preflight, `Expense.create` do alvo
  // novo é tentado antes de `ratearSource` dar 409 e desfazer tudo.
  expect(writeAttempts).toEqual([]);
  expect(after).toEqual(before);
});

it('Bmix-existing-ok ratearMixed with a CLEAN existing target + a NEW target still succeeds — the preflight does not over-block', async () => {
  // Alvo existente LIMPO (sem trilha) + fonte limpa: mixed legítimo continua
  // permitido, criando o alvo novo e o par de alocações.
  const existingTarget = await purchase(B, '2026-06-10T12:00:00.000Z');
  expect(
    await setup.importedInvoiceLiquidation.count({ where: { tenantId: TENANT, deletedAt: null } }),
  ).toBe(0);

  const source = await expenses.create(
    TENANT,
    A,
    {
      tipoDespesa: 'MATERIAL',
      valor: 500,
      quantidade: 1,
      titulo: 'fonte mixed a ratear (ok)',
      formaPagamento: 'A_VISTA',
      dataCompra: '2026-06-10',
      status: 'PLANEJADO',
    },
    null,
    undefined,
    ADMIN,
  );
  console.log('Bmix-existing-ok ARRANGE_OK: clean existing target + clean source + new target');

  const outcome = await observe(() =>
    expenses.ratearMixed(
      TENANT,
      A,
      source.id,
      {
        newTargets: [
          {
            targetProjectId: B,
            tipoDespesa: 'MATERIAL',
            valor: 200,
            quantidade: 1,
            allocation: 20_000,
          },
        ],
        existing: [{ targetExpenseId: existingTarget.id, allocation: 30_000 }],
      },
      ADMIN.id,
      ADMIN,
    ),
  );
  diagnostic('Bmix-existing-ok ACT', outcome.error);
  expect(outcome.error).toBeNull();
  const allocations = await setup.rateioAllocation.findMany({
    where: { tenantId: TENANT, sourceExpenseId: source.id },
    orderBy: { targetExpenseId: 'asc' },
  });
  expect(allocations).toHaveLength(2);
  expect(new Set(allocations.map((a) => a.targetExpenseId))).toContain(existingTarget.id);
  expect(
    (await setup.expense.findUniqueOrThrow({ where: { id: source.id } })).linkedExpenseId,
  ).not.toBeNull();
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

// ── Finding A: a regenerating NON-financial PATCH on an import-claimed purchase ──
// A COMPRA carimbada por importação como parcela liquidada (`activeAsPurchase>0`)
// só era barrada por `changedFinancials`; mas `regenerateCashFlow` (soft-delete +
// recria as `CashFlowEntry` com IDs novos) roda no SUPERSET de insumos —
// categoria, sala, tipo, meio de pagamento e overrides. Uma dessas edições
// passava a guarda e órfãozava `imported_invoice_liquidations.cash_flow_entry_id`
// (aponta para a entrada soft-deletada). Cada representante abaixo é RED antes do
// fix e vira 409 sem escritas depois dele.
describe('A regenerating non-financial mutation on an import-claimed purchase', () => {
  it.each([
    ['categoriaMaoDeObra', async (_projectId: string) => ({ categoriaMaoDeObra: 'ELETRICISTA' })],
    ['tipoDespesa', async (_projectId: string) => ({ tipoDespesa: 'MATERIAL' })],
    [
      'roomId',
      async (projectId: string) => {
        const room = await setup.room.create({
          data: { projectId, name: `Sala rf569 ${Date.now()}` },
        });
        return { roomId: room.id };
      },
    ],
  ] as const)(
    'A-regen %s is rejected with 409, zero writes, and leaves the claimed CashFlowEntry + ledger intact',
    async (label, buildDto) => {
      const p = await purchase(A, '2026-06-10T12:00:00.000Z');
      await importedPayment(p.id, p.entryIds[0]);
      const dto = await buildDto(A);
      try {
        const before = await fullSnapshot();
        expect(
          before.ledger.filter(
            (l) => l.deletedAt === null && l.cashFlowEntryId === p.entryIds[0],
          ),
        ).toHaveLength(1);
        console.log(`A-regen ARRANGE_OK: claimed purchase, mutating ${label}`);

        const outcome = await observeWrites(() =>
          expenses.update(TENANT, A, p.id, dto, ADMIN),
        );
        const after = await fullSnapshot();
        diagnostic(`A-regen ${label}`, outcome.error);
        console.log(`A-regen ${label} WRITE_ATTEMPTS`, writeAttempts);
        console.log(`A-regen ${label} POST`, {
          claimedEntryDeleted:
            after.entries.find((e) => e.id === p.entryIds[0])?.deletedAt !== null,
          liveClaims: after.ledger.filter((l) => l.deletedAt === null).length,
        });
        expect(errorStatus(outcome.error)).toBe(409);
        // PREFLIGHT: a guarda roda ANTES de `expense.update`/`regenerateCashFlow`.
        expect(writeAttempts).toEqual([]);
        expect(after).toEqual(before);
        // O claim ativo continua apontando para uma entrada VIVA.
        expect(
          after.entries.find((e) => e.id === p.entryIds[0])?.deletedAt,
        ).toBeNull();
      } finally {
        // `resetTenant` (fixture, imutável) não limpa `rooms`; a compra rejeitada
        // nunca passou a referenciar a sala, então o hard-delete direto é seguro
        // e mantém o teardown do tenant sem violar a FK de `rooms → projects`.
        await setup.room.deleteMany({ where: { projectId: A } });
      }
    },
  );
});

it('A-desc a title-only edit of an import-claimed purchase stays allowed and preserves the claimed entry + ledger (no regen)', async () => {
  const p = await purchase(A, '2026-06-10T12:00:00.000Z');
  await importedPayment(p.id, p.entryIds[0]);
  const before = await fullSnapshot();
  console.log('A-desc ARRANGE_OK: claimed purchase, title-only edit');

  const outcome = await observe(() =>
    expenses.update(TENANT, A, p.id, { titulo: 'compra renomeada' }, ADMIN),
  );
  const after = await fullSnapshot();
  diagnostic('A-desc ACT', outcome.error);
  expect(outcome.error).toBeNull();
  expect(after.expenses.find((e) => e.id === p.id)?.titulo).toBe(
    'compra renomeada',
  );
  expect(after.entries.filter((e) => e.expenseId === p.id)).toEqual(
    before.entries.filter((e) => e.expenseId === p.id),
  );
  expect(after.ledger).toEqual(before.ledger);
});

it('A-unclaimed a categoria edit on an UNCLAIMED purchase still regenerates its cash flow — the guard does not over-block', async () => {
  const p = await purchase(A, '2026-06-10T12:00:00.000Z');
  expect(
    await setup.importedInvoiceLiquidation.count({
      where: { tenantId: TENANT, deletedAt: null },
    }),
  ).toBe(0);
  console.log('A-unclaimed ARRANGE_OK: unclaimed purchase, categoria edit');

  const outcome = await observe(() =>
    expenses.update(TENANT, A, p.id, { categoriaMaoDeObra: 'ELETRICISTA' }, ADMIN),
  );
  diagnostic('A-unclaimed ACT', outcome.error);
  expect(outcome.error).toBeNull();
  const raw = await setup.expense.findUniqueOrThrow({ where: { id: p.id } });
  expect(raw.categoriaMaoDeObra).toBe('ELETRICISTA');
  // Regeneração ocorreu: as entradas originais foram soft-deletadas e novas
  // (IDs distintos) nasceram vivas.
  const live = await setup.cashFlowEntry.findMany({
    where: { expenseId: p.id, deletedAt: null },
  });
  expect(live).toHaveLength(3);
  expect(live.every((e) => !p.entryIds.includes(e.id))).toBe(true);
});

// ── Finding B: desratear/unratearSource must not orphan an import claim ──
// `ConciliacaoService.unratearSource` é o CORE de reversão de rateio (chamado por
// `Expense.desratear`, `reverseSourceLinks`, e como cleanup do próprio
// `ratearSource`). Ele reabre o status dos alvos e chama `regenerateTargetCashflow`,
// que soft-deleta+recria as `CashFlowEntry` do alvo — órfãozando um
// `imported_invoice_liquidations.cash_flow_entry_id` ATIVO se, DEPOIS do rateio,
// uma importação real liquidou a parcela do alvo. A guarda vive no core, após a
// ACL e ANTES da primeira escrita, cobrindo todos os callers.

/**
 * Monta o cenário: FONTE PESSOAL parcelada (A, sem cartão) rateada 1:1 num ALVO
 * parcelado no cartão (B); DEPOIS uma importação REAL liquida a 1ª parcela do
 * alvo. Retorna os ids e a entrada reivindicada (viva) do alvo.
 */
async function ratearThenClaimTarget() {
  const target = await purchase(B, '2026-06-10T12:00:00.000Z');
  const source = await expenses.create(
    TENANT,
    A,
    {
      tipoDespesa: 'MATERIAL',
      valor: 300,
      quantidade: 1,
      titulo: 'fonte pessoal parcelada a ratear',
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: '2026-06-10',
      dataCompra: '2026-06-10',
      status: 'PLANEJADO',
    },
    null,
    undefined,
    ADMIN,
  );
  expect(source).toMatchObject({ projectId: A, valorTotal: 30_000, cardLast4: null });

  await expenses.ratear(
    TENANT,
    A,
    source.id,
    [{ targetExpenseId: target.id, allocation: 30_000 }],
    ADMIN,
  );

  // Após o rateio o alvo foi realinhado ao cronograma da fonte (3x, datas da
  // fonte): novas entradas vivas. A 1ª (2026-06-10) cai na fatura 2026-07.
  const liveEntries = await setup.cashFlowEntry.findMany({
    where: { expenseId: target.id, deletedAt: null },
    orderBy: { data: 'asc' },
  });
  expect(liveEntries).toHaveLength(3);
  const claimedEntryId = liveEntries[0].id;

  await importedPayment(target.id, claimedEntryId);
  const claim = await setup.importedInvoiceLiquidation.findMany({
    where: { tenantId: TENANT, purchaseExpenseId: target.id, deletedAt: null },
  });
  expect(claim).toHaveLength(1);
  expect(claim[0].cashFlowEntryId).toBe(claimedEntryId);

  return { source, target, claimedEntryId };
}

it('Bunratear desratear a source whose rateio target was later settled by a real import is rejected with 409, zero writes, and the claim stays live', async () => {
  const { source, target, claimedEntryId } = await ratearThenClaimTarget();
  const before = await fullSnapshot();
  expect(before.allocations).toHaveLength(1);
  console.log('Bunratear ARRANGE_OK: rateio then real import claim on target');

  const outcome = await observeWrites(() =>
    expenses.desratear(TENANT, A, source.id, ADMIN),
  );
  const after = await fullSnapshot();
  diagnostic('Bunratear ACT', outcome.error);
  console.log('Bunratear WRITE_ATTEMPTS', writeAttempts);
  console.log('Bunratear POST', {
    claimedEntryDeleted:
      after.entries.find((e) => e.id === claimedEntryId)?.deletedAt !== null,
    liveClaims: after.ledger.filter((l) => l.deletedAt === null).length,
    allocations: after.allocations.length,
  });
  expect(errorStatus(outcome.error)).toBe(409);
  // PREFLIGHT no core: guarda roda após a ACL e ANTES da primeira escrita.
  expect(writeAttempts).toEqual([]);
  expect(after).toEqual(before);
  // O claim ativo continua apontando para a entrada VIVA do alvo.
  expect(after.entries.find((e) => e.id === claimedEntryId)?.deletedAt).toBeNull();
  expect(target.id).toBeDefined();
});

it('Bunratear-acl a requester who cannot see the target project is denied by ACL (404) BEFORE the ledger is consulted', async () => {
  const { source, claimedEntryId } = await ratearThenClaimTarget();
  const before = await fullSnapshot();
  console.log('Bunratear-acl ARRANGE_OK: claimed target, requester scoped to A only');

  // pessoalRequester(A) não enxerga o projeto B (alvo): `assertCanReverseSources`
  // nega em 404 antes de qualquer consulta ao ledger — nunca vira 409.
  const outcome = await observeWrites(() =>
    expenses.desratear(TENANT, A, source.id, pessoalRequester(A)),
  );
  const after = await fullSnapshot();
  diagnostic('Bunratear-acl ACT', outcome.error);
  expect(errorStatus(outcome.error)).toBe(404);
  expect(writeAttempts).toEqual([]);
  expect(after).toEqual(before);
  expect(after.entries.find((e) => e.id === claimedEntryId)?.deletedAt).toBeNull();
});

it('Bunratear-ok desratear a source with NO import claim still reverts normally — the guard does not over-block', async () => {
  const target = await purchase(B, '2026-06-10T12:00:00.000Z');
  const source = await expenses.create(
    TENANT,
    A,
    {
      tipoDespesa: 'MATERIAL',
      valor: 300,
      quantidade: 1,
      titulo: 'fonte pessoal a ratear (ok)',
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: '2026-06-10',
      dataCompra: '2026-06-10',
      status: 'PLANEJADO',
    },
    null,
    undefined,
    ADMIN,
  );
  await expenses.ratear(
    TENANT,
    A,
    source.id,
    [{ targetExpenseId: target.id, allocation: 30_000 }],
    ADMIN,
  );
  expect(
    await setup.importedInvoiceLiquidation.count({ where: { tenantId: TENANT, deletedAt: null } }),
  ).toBe(0);
  expect(
    await setup.rateioAllocation.count({ where: { tenantId: TENANT, sourceExpenseId: source.id } }),
  ).toBe(1);
  console.log('Bunratear-ok ARRANGE_OK: clean rateio, no import claim');

  const outcome = await observe(() => expenses.desratear(TENANT, A, source.id, ADMIN));
  diagnostic('Bunratear-ok ACT', outcome.error);
  expect(outcome.error).toBeNull();
  expect(
    await setup.rateioAllocation.count({ where: { tenantId: TENANT, sourceExpenseId: source.id } }),
  ).toBe(0);
  expect(
    (await setup.expense.findUniqueOrThrow({ where: { id: source.id } })).linkedExpenseId,
  ).toBeNull();
});
