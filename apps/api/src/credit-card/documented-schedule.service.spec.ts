require('../../../../scripts/test-db-env.cjs');

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Expense, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import {
  applyParcelaFunding,
  FUNDING_CONFLICT,
} from '../conciliacao/additive-settlement';
import { ExpenseService } from '../expense/expense.service';
import { parseStoredExpenseSchedule } from '../expense/documented-schedule';
import { StoredProjectionScheduleV1 } from '../expense/documented-schedule.types';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import {
  MonthlyOverviewService,
  buildRunwayCandidatos,
} from '../monthly-overview/monthly-overview.service';
import { TenantFinancialService } from '../tenant-financial/tenant-financial.service';
import { DashboardService } from '../dashboard/dashboard.service';
import {
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedPessoal,
} from '../bank-account/__tests__/invoice-undo.fixtures';
import { CreditCardService } from './credit-card.service';
import { CardInvoiceSettlementService } from './card-invoice-settlement.service';
import { DocumentedScheduleService } from './documented-schedule.service';
import { RestoreImportedExpenseService } from './restore-imported-expense.service';
import { parseStatement } from './parsers';

const tenantId = 'synthetic-701-correction-core';
const projectId = `${tenantId}-personal`;
const targetProjectId = `${tenantId}-target`;
const actor = {
  id: `${tenantId}-actor`,
  role: 'USER',
  allowedProjects: [projectId, targetProjectId],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: [
    'expenses',
    'creditCards',
    'bankAccounts',
    'monthlyOverview',
  ],
};
const evidence = {
  documentSha256: 'c'.repeat(64),
  reference: 'Synthetic documentary cents',
};
const setup = new PrismaClient();
const prisma = new PrismaService();
const other = new PrismaService();
const conciliacao = new ConciliacaoService(prisma);
const expenses = new ExpenseService(prisma, conciliacao);
const cards = new CreditCardService(
  prisma,
  conciliacao,
  new MerchantClassifierService(prisma),
);
const service = new DocumentedScheduleService(prisma);
const settlement = new CardInvoiceSettlementService(prisma);
let scope: {
  tenantId: string;
  projectId: string;
  cardId: string;
  importId: string;
  expenseId: string;
};
let changes: Array<{
  cashFlowEntryId: string;
  amountCents: number;
  invoiceDueMonth: string;
  evidence: typeof evidence;
}>;
let fail: 'cash-cas' | 'audit' | null = null;

prisma.$use(async (params, next) => {
  if (
    fail === 'cash-cas' &&
    params.model === 'CashFlowEntry' &&
    params.action === 'updateMany'
  )
    return { count: 0 };
  if (
    fail === 'audit' &&
    params.model === 'UserActivityLog' &&
    params.action === 'create'
  )
    throw new Error('Synthetic audit failure');
  return next(params);
});

async function cleanup() {
  await setup.userActivityLog.deleteMany({ where: { tenantId } });
  await setup.user.deleteMany({ where: { tenantId } });
  await resetTenant(setup, tenantId);
}
async function snapshot() {
  return {
    expenses: await setup.expense.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
    cash: await setup.cashFlowEntry.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
    allocations: await setup.rateioAllocation.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
    funding: await setup.crossProjectSettlement.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
    audits: await setup.userActivityLog.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
  };
}
async function preview() {
  const result = await service.correct(scope, actor, {
    mode: 'preview',
    changes,
  });
  if (!('fingerprint' in result))
    throw new Error('Expected applicable preview');
  return {
    mode: 'apply',
    requestId: 'synthetic-request',
    expectedFingerprint: result.fingerprint,
    changes,
  };
}

async function restoreDeletedPurchase(): Promise<void> {
  await expenses.remove(tenantId, projectId, scope.expenseId, actor);
  const restore = new RestoreImportedExpenseService(prisma);
  const plan = await restore.restore(scope, actor, { mode: 'preview' });
  await restore.restore(scope, actor, {
    mode: 'apply',
    expectedFingerprint: plan.fingerprint,
  });
}
async function target() {
  return expenses.create(tenantId, targetProjectId, {
    titulo: 'Synthetic contract',
    tipoDespesa: 'OUTROS',
    valor: 370.5,
    quantidade: 1,
    formaPagamento: 'PARCELADO',
    quantidadeParcela: 3,
    dataInicioParcela: '2026-08-02',
    status: 'PLANEJADO',
  });
}

beforeEach(async () => {
  jest.useFakeTimers({
    now: new Date('2026-11-05T12:00:00Z'),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  fail = null;
  await cleanup();
  await seedPessoal(setup, { tenantId, projectId });
  await setup.project.create({
    data: {
      id: targetProjectId,
      tenantId,
      type: 'REFORMA',
      name: 'Synthetic target',
    },
  });
  await setup.user.create({
    data: {
      id: actor.id,
      tenantId,
      username: actor.id,
      name: 'Synthetic operator',
      role: actor.role,
      allowedProjects: JSON.stringify(actor.allowedProjects),
      allowedModules: JSON.stringify(actor.allowedModules),
      allowedProjectTypes: JSON.stringify(actor.allowedProjectTypes),
    },
  });
  const card = await seedCardWithClosingDue(setup, {
    tenantId,
    projectId,
    last4: '1701',
    closingDay: 20,
    dueDay: 10,
  });
  await cards.commitImport(
    tenantId,
    projectId,
    card.id,
    'date,title,amount\n2026-07-14,Synthetic contract 1/3,123.50\n',
    'synthetic.csv',
    'CSV_GENERIC',
    undefined,
    undefined,
    undefined,
    actor.id,
    actor,
  );
  const source = await prisma.expense.findFirstOrThrow({
    where: { tenantId },
    include: { cashFlow: { orderBy: { data: 'asc' } } },
  });
  scope = {
    tenantId,
    projectId,
    cardId: card.id,
    importId: source.importId!,
    expenseId: source.id,
  };
  changes = [
    {
      cashFlowEntryId: source.cashFlow[1].id,
      amountCents: 12345,
      invoiceDueMonth: '2026-11',
      evidence,
    },
  ];
});
afterEach(() => jest.useRealTimers());
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await other.$disconnect();
  await setup.$disconnect();
});

it('resolves a deleted selected CFE opaquely before preview financial diagnostics', async () => {
  await prisma.cashFlowEntry.delete({
    where: { id: changes[0].cashFlowEntryId },
  });
  const before = await snapshot();
  await expect(
    service.correct(scope, actor, { mode: 'preview', changes }),
  ).rejects.toBeInstanceOf(NotFoundException);
  expect(await snapshot()).toEqual(before);
});

it('previews both effective cycles without presenting a derived cycle as documentary evidence', async () => {
  const before = await snapshot();
  const result = await service.correct(scope, actor, {
    mode: 'preview',
    changes,
  });
  expect(result).toMatchObject({
    affectedCycles: ['2026-09', '2026-11'],
    changes: [
      {
        before: { invoiceDueMonth: null },
        after: { invoiceDueMonth: '2026-11' },
      },
    ],
  });
  expect(await snapshot()).toEqual(before);
});

it('corrects an exact nine-target matrix in place and retains it through regeneration and official undo', async () => {
  const targets: Expense[] = [];
  for (let index = 0; index < 9; index++) {
    targets.push(
      await expenses.create(tenantId, targetProjectId, {
        titulo: `Synthetic matrix target ${index}`,
        tipoDespesa: 'OUTROS',
        valor: index === 8 ? 130.5 : 30,
        quantidade: 1,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 3,
        dataInicioParcela: '2026-08-02',
        status: 'PLANEJADO',
      }),
    );
  }
  await prisma.$transaction((tx) =>
    conciliacao.ratearSource(
      tx,
      {
        tenantId,
        sourceExpenseId: scope.expenseId,
        allocations: targets.map((row) => ({
          targetExpenseId: row.id,
          allocation: row.valorTotal,
        })),
      },
      actor,
    ),
  );
  const before = await snapshot();
  const allocations = targets.map(
    (target) =>
      before.allocations.find((row) => row.targetExpenseId === target.id)!,
  );
  const selected = before.cash.find(
    (row) => row.id === changes[0].cashFlowEntryId,
  )!;
  const matrix = allocations.map((allocation, index) => {
    const cell = before.cash.find(
      (row) =>
        row.expenseId === allocation.targetExpenseId &&
        row.parcela === selected.parcela &&
        row.deletedAt === null,
    )!;
    return {
      allocationId: allocation.id,
      targetCashFlowEntryId: cell.id,
      amountCents: cell.valor - (index === 0 ? 5 : 0),
    };
  });
  const change = {
    cashFlowEntryId: selected.id,
    amountCents: 12345,
    evidence,
    allocationBreakdown: matrix,
  };
  const result = await service.correct(scope, actor, {
    mode: 'preview',
    changes: [change],
  });
  expect(result).toMatchObject({ applicable: true, afterTotalCents: 37045 });
  expect(await snapshot()).toEqual(before);
  const apply = {
    mode: 'apply',
    requestId: 'synthetic-nine-targets',
    expectedFingerprint: result.fingerprint,
    changes: [change],
  };
  await service.correct(scope, actor, apply);
  const after = await snapshot();
  expect(after.allocations).toEqual(
    before.allocations.map((row) => ({
      ...row,
      allocation: row.allocation - (row.id === allocations[0].id ? 5 : 0),
    })),
  );
  expect(after.cash).toEqual(
    before.cash.map((row) =>
      row.id === selected.id || row.id === matrix[0].targetCashFlowEntryId
        ? { ...row, valor: row.valor - 5, updatedAt: expect.any(Date) }
        : row,
    ),
  );
  expect(await service.correct(scope, actor, apply)).toMatchObject({
    alreadyApplied: true,
  });
  expect(await snapshot()).toEqual(after);
  await prisma.$transaction(async (tx) => {
    for (const target of targets)
      await conciliacao.regenerateRateioTargetCashflow(tx, target.id);
  });
  for (const [index, target] of targets.entries()) {
    const entries = await prisma.cashFlowEntry.findMany({
      where: { tenantId, expenseId: target.id },
      orderBy: { data: 'asc' },
    });
    expect(entries.map((row) => row.valor)).toEqual(
      index === 0
        ? [1000, 995, 1000]
        : index === 8
          ? [4350, 4350, 4350]
          : [1000, 1000, 1000],
    );
  }
  await prisma.$transaction((tx) =>
    conciliacao.unratearSource(
      tx,
      {
        tenantId,
        sourceExpenseId: scope.expenseId,
      },
      actor,
    ),
  );
  for (const target of targets) {
    const restored = await prisma.expense.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(restored).toMatchObject({
      valorTotal: target.valorTotal,
      dataInicioParcela: target.dataInicioParcela,
      documentedSchedule: null,
    });
  }
});

it.each([false, true])(
  'fails closed for an unequal legacy one-way mirror (real import batch present: %s)',
  async (hasBatch) => {
    await cards.commitImport(
      tenantId,
      projectId,
      scope.cardId,
      'date,title,amount\n2026-07-14,Synthetic legacy 1/6,10.01\n',
      'synthetic-legacy.csv',
      'CSV_GENERIC',
      undefined,
      undefined,
      undefined,
      actor.id,
      actor,
    );
    const source = await prisma.expense.findFirstOrThrow({
      where: { tenantId, id: { not: scope.expenseId } },
      include: { cashFlow: { orderBy: { data: 'asc' } } },
    });
    const target = await expenses.create(tenantId, targetProjectId, {
      titulo: 'Synthetic unequal legacy mirror',
      tipoDespesa: 'OUTROS',
      valor: 60.06,
      quantidade: 1,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 6,
      dataInicioParcela: '2026-08-02',
      status: 'PLANEJADO',
    });
    const importId = hasBatch ? source.importId! : 'synthetic-legacy-marker';
    // Historical fixture only: no reverse link/allocation or fabricated import batch.
    await setup.expense.update({
      where: { id: source.id },
      data: {
        valor: 6001,
        valorTotal: 6001,
        importId,
        linkedExpenseId: target.id,
      },
    });
    await setup.cashFlowEntry.updateMany({
      where: { id: { in: source.cashFlow.slice(1).map((row) => row.id) } },
      data: { valor: 1000 },
    });
    expect(
      await prisma.creditCardStatementImport.count({
        where: { id: importId, tenantId, deletedAt: null },
      }),
    ).toBe(hasBatch ? 1 : 0);
    const before = await snapshot();
    expect(before.allocations).toHaveLength(0);
    expect(
      before.expenses.find((row) => row.id === target.id)?.linkedExpenseId,
    ).toBeNull();
    await expect(
      service.correct(
        {
          ...scope,
          expenseId: source.id,
          importId,
        },
        actor,
        {
          mode: 'preview',
          changes: [
            {
              cashFlowEntryId: source.cashFlow[1].id,
              amountCents: 1001,
              evidence,
            },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(hasBatch ? ConflictException : NotFoundException);
    expect(await snapshot()).toEqual(before);
  },
);

it('corrects a legacy planned sibling and atomically records evidence, receipt and one audit', async () => {
  const card = await prisma.creditCard.findUniqueOrThrow({
    where: { id: scope.cardId },
  });
  await settlement.settleInvoice({
    tenantId,
    card,
    amountCents: 12350,
    paymentDate: new Date('2026-08-05'),
    requester: actor,
  });
  const before = await snapshot();
  const apply = await preview();
  expect(await snapshot()).toEqual(before);
  expect(await service.correct(scope, actor, apply)).toMatchObject({
    applied: true,
    afterTotalCents: 37045,
  });
  const source = await prisma.expense.findUniqueOrThrow({
    where: { id: scope.expenseId },
  });
  const schedule = parseStoredExpenseSchedule(source.documentedSchedule);
  expect(source).toMatchObject({
    valor: 37045,
    valorTotal: 37045,
    quantidade: 1,
    paidParcelas: '[0]',
    status: 'PLANEJADO',
  });
  expect(schedule?.occurrences.map((row) => row.valor)).toEqual([
    12350, 12345, 12350,
  ]);
  expect(schedule).toMatchObject({
    lastOperation: { requestId: apply.requestId, actorUserId: actor.id },
  });
  if (schedule?.kind !== 'source') throw new Error('Expected private source');
  expect(
    schedule.occurrences.map((row) => row.amountEvidence !== null),
  ).toEqual([false, true, false]);
  const after = await snapshot();
  expect(after.audits).toHaveLength(1);
  expect(after.cash).toEqual(
    before.cash.map((row) =>
      row.id === changes[0].cashFlowEntryId
        ? {
            ...row,
            valor: 12345,
            invoiceDueMonth: '2026-11',
            updatedAt: expect.any(Date),
          }
        : row,
    ),
  );
  expect(await service.correct(scope, actor, apply)).toEqual({
    alreadyApplied: true,
    applied: false,
  });
  expect(await snapshot()).toEqual(after);
});

it.each(['cash-cas', 'audit'] as const)(
  'rolls back every financial row and receipt on %s failure',
  async (failure) => {
    const apply = await preview();
    const before = await snapshot();
    fail = failure;
    await expect(service.correct(scope, actor, apply)).rejects.toThrow();
    fail = null;
    expect(await snapshot()).toEqual(before);
  },
);

it('serializes two independent SQLite writers without duplicate operation audits', async () => {
  const apply = await preview();
  const results = await Promise.allSettled([
    service.correct(scope, actor, apply),
    new DocumentedScheduleService(other).correct(scope, actor, apply),
  ]);
  expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
  for (const result of results)
    if (result.status === 'rejected')
      expect(result.reason).toBeInstanceOf(ConflictException);
  expect((await snapshot()).audits).toHaveLength(1);
  expect(await service.correct(scope, actor, apply)).toEqual({
    alreadyApplied: true,
    applied: false,
  });
});

it('rejects an unrepresentable unit price without changing quantity', async () => {
  await setup.expense.update({
    where: { id: scope.expenseId },
    data: { valor: 18525, quantidade: 2 },
  });
  const before = await snapshot();
  await expect(preview()).rejects.toBeInstanceOf(ConflictException);
  expect(await snapshot()).toEqual(before);
});

it('rereads current ACL before revealing or writing any part of a mirror', async () => {
  const planned = await target();
  await expenses.linkCrossProject(
    tenantId,
    projectId,
    scope.expenseId,
    planned.id,
    actor,
  );
  const apply = await preview();
  await setup.user.update({
    where: { id: actor.id },
    data: { allowedProjects: JSON.stringify([projectId]) },
  });
  const before = await snapshot();
  await expect(service.correct(scope, actor, apply)).rejects.toBeInstanceOf(
    NotFoundException,
  );
  expect(await snapshot()).toEqual(before);
});

it('uses the real ADDITIVE ledger guard rather than treating a funded target as a free mirror', async () => {
  const planned = await target();
  const account = await seedBankAccount(setup, {
    tenantId,
    projectId,
    last4: '2702',
  });
  const payment = await expenses.create(tenantId, projectId, {
    tipoDespesa: 'OUTROS',
    valor: 10,
    quantidade: 1,
    formaPagamento: 'A_VISTA',
    status: 'PAGO',
    dataPagamento: '2026-08-02',
    bankAccountId: account.id,
  });
  await applyParcelaFunding(
    prisma,
    tenantId,
    projectId,
    payment.id,
    {
      mode: 'ADDITIVE',
      targetExpenseId: planned.id,
      parcelaIndex: 0,
      amountCents: 1000,
      requestId: 'synthetic-funding',
    },
    actor,
  );
  // A corrupt/legacy link cannot make an already-funded target eligible for repricing.
  await setup.expense.update({
    where: { id: scope.expenseId },
    data: { linkedExpenseId: planned.id },
  });
  const before = await snapshot();
  await expect(preview()).rejects.toThrow(FUNDING_CONFLICT);
  expect(await snapshot()).toEqual(before);
});

it('captures documented planning at official rateio creation and restores it exactly on undo', async () => {
  await service.correct(scope, actor, await preview());
  const planned = await expenses.create(tenantId, targetProjectId, {
    titulo: 'Synthetic old planning',
    tipoDespesa: 'OUTROS',
    valor: 124,
    quantidade: 1,
    formaPagamento: 'PARCELADO',
    quantidadeParcela: 2,
    dataInicioParcela: '2026-09-02',
    status: 'PLANEJADO',
  });
  const projection: StoredProjectionScheduleV1 = {
    version: 1,
    kind: 'projection',
    tenantId,
    sourceExpenseId: scope.expenseId,
    sourceProjectId: projectId,
    cardId: scope.cardId,
    recordedByUserId: actor.id,
    recordedAt: new Date().toISOString(),
    targetExpenseId: planned.id,
    targetProjectId,
    via: 'mirror',
    allocationId: null,
    occurrences: [
      {
        index: 0,
        sourceIndex: 0,
        parcela: '1/2',
        valor: 6201,
        data: '2026-09-02',
        invoiceDueMonth: '2026-11',
      },
      {
        index: 1,
        sourceIndex: 1,
        parcela: '2/2',
        valor: 6199,
        data: '2026-10-02',
        invoiceDueMonth: null,
      },
    ],
  };
  const raw = JSON.stringify(projection);
  await setup.expense.update({
    where: { id: planned.id },
    data: { documentedSchedule: raw },
  });
  await prisma.$transaction((tx) =>
    conciliacao.regenerateTargetCashflow(tx, planned.id),
  );
  await prisma.$transaction((tx) =>
    conciliacao.ratearSource(
      tx,
      {
        tenantId,
        sourceExpenseId: scope.expenseId,
        allocations: [{ targetExpenseId: planned.id, allocation: 37045 }],
      },
      actor,
    ),
  );
  const allocation = await prisma.rateioAllocation.findFirstOrThrow({
    where: { targetExpenseId: planned.id },
  });
  expect(allocation.plannedDocumentedSchedule).toBe(raw);
  await prisma.$transaction((tx) =>
    conciliacao.unratearSource(
      tx,
      { tenantId, sourceExpenseId: scope.expenseId },
      actor,
    ),
  );
  const restored = await prisma.expense.findUniqueOrThrow({
    where: { id: planned.id },
  });
  expect(restored).toMatchObject({
    documentedSchedule: raw,
    valorTotal: 12400,
    quantidadeParcela: 2,
  });
  const cash = await prisma.cashFlowEntry.findMany({
    where: { expenseId: planned.id },
    orderBy: { data: 'asc' },
  });
  expect(
    cash.map((row) => [
      row.valor,
      row.data.toISOString().slice(0, 10),
      row.invoiceDueMonth,
    ]),
  ).toEqual([
    [6201, '2026-09-02', '2026-11'],
    [6199, '2026-10-02', null],
  ]);
  await expenses.update(
    tenantId,
    targetProjectId,
    planned.id,
    { titulo: 'Safe metadata' },
    actor,
  );
  for (const mutation of [
    () =>
      expenses.update(
        tenantId,
        targetProjectId,
        planned.id,
        { valor: 1 },
        actor,
      ),
    () => expenses.remove(tenantId, targetProjectId, planned.id, actor),
  ])
    await expect(mutation()).rejects.toBeInstanceOf(ConflictException);
  const control = await expenses.create(tenantId, targetProjectId, {
    titulo: 'Ordinary eligible expense',
    tipoDespesa: 'OUTROS',
    valor: 5,
    quantidade: 1,
    formaPagamento: 'A_VISTA',
    status: 'PLANEJADO',
    dataPagamento: '2026-09-10',
  });
  const monthly = new MonthlyOverviewService(prisma, settlement);
  const view = await monthly.getAccountView(
    tenantId,
    projectId,
    '2026-09',
    actor,
  );
  const candidates = buildRunwayCandidatos(
    [{ mes: '2026-09', saldoProjetado: -100 }],
    [view],
    ['2026-09'],
    '2026-09',
  );
  expect(candidates.map((row) => row.expenseId)).not.toContain(planned.id);
  expect(candidates.map((row) => row.expenseId)).toContain(control.id);
});

it.each(['direct', 'reverse'])(
  'counts a %s documented pair exactly once in scoped readers and preserves proof on unlink',
  async (direction) => {
    const planned = await target();
    if (direction === 'direct')
      await expenses.linkCrossProject(
        tenantId,
        projectId,
        scope.expenseId,
        planned.id,
        actor,
      );
    else
      await expenses.linkCrossProject(
        tenantId,
        targetProjectId,
        planned.id,
        scope.expenseId,
        actor,
      );
    await service.correct(scope, actor, await preview());
    const monthly = new MonthlyOverviewService(prisma, settlement);
    const tenant = new TenantFinancialService(prisma, monthly);
    for (const allowedProjects of [[projectId], [projectId, targetProjectId]]) {
      const reader = { ...actor, allowedProjects };
      const overview = await monthly.getOverview(
        tenantId,
        projectId,
        '2026-11',
        reader,
      );
      expect(
        overview.entries
          .filter((row) => !row.isEspelho)
          .reduce((sum, row) => sum + row.valor, 0),
      ).toBe(37045);
      const account = await monthly.getAccountView(
        tenantId,
        projectId,
        '2026-11',
        reader,
      );
      expect(account.saidaTotal).toBe(12345);
      expect(
        account.saidas.some((row) => row.foreignExpenseId === planned.id),
      ).toBe(false);
      expect(
        (await tenant.getByCategory(tenantId, allowedProjects)).reduce(
          (sum, row) => sum + row.total,
          0,
        ),
      ).toBe(37045);
      expect(
        (await tenant.getByProject(tenantId, allowedProjects)).reduce(
          (sum, row) => sum + row.planejadoRestante + row.gastoTotal,
          0,
        ),
      ).toBe(37045);
    }
    for (const id of [projectId, targetProjectId]) {
      expect(
        (await new DashboardService(prisma).getDashboard(tenantId, id)).kpis
          .previsaoGastos,
      ).toBe(37045);
    }
    const before = await prisma.expense.findUniqueOrThrow({
      where: { id: planned.id },
    });
    await expenses.unlinkCrossProject(
      tenantId,
      projectId,
      scope.expenseId,
      actor,
    );
    const after = await prisma.expense.findUniqueOrThrow({
      where: { id: planned.id },
    });
    expect(after).toMatchObject({
      documentedSchedule: before.documentedSchedule,
      valorTotal: 37045,
      linkedExpenseId: null,
    });
  },
);

it('creates a compatible reverse mirror through the existing API without copying evidence or invoice dates', async () => {
  changes[0].amountCents = 12350;
  await service.correct(scope, actor, await preview());
  const planned = await expenses.create(
    tenantId,
    targetProjectId,
    {
      titulo: 'Synthetic compatible mirror',
      tipoDespesa: 'OUTROS',
      valor: 370.5,
      quantidade: 1,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: '2026-09-02',
      status: 'PLANEJADO',
      linkedExpenseId: scope.expenseId,
    },
    actor.id,
    undefined,
    actor,
  );
  const schedule = parseStoredExpenseSchedule(planned.documentedSchedule);
  expect(schedule).toMatchObject({
    kind: 'projection',
    via: 'mirror',
    targetExpenseId: planned.id,
  });
  expect(JSON.stringify(schedule)).not.toContain(evidence.documentSha256);
  const rows = await prisma.cashFlowEntry.findMany({
    where: { expenseId: planned.id },
    orderBy: { data: 'asc' },
  });
  expect(
    rows.map((row) => [
      row.valor,
      row.data.toISOString().slice(0, 10),
      row.invoiceDueMonth,
    ]),
  ).toEqual([
    [12350, '2026-09-02', null],
    [12350, '2026-10-02', '2026-11'],
    [12350, '2026-11-02', null],
  ]);
  const before = await snapshot();
  await expect(
    expenses.create(
      tenantId,
      targetProjectId,
      {
        tipoDespesa: 'OUTROS',
        valor: 370,
        quantidade: 1,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 3,
        dataInicioParcela: '2026-09-02',
        status: 'PLANEJADO',
        linkedExpenseId: scope.expenseId,
      },
      actor.id,
      undefined,
      actor,
    ),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(await snapshot()).toEqual(before);
});

it('keeps a paid reverse documentary mirror outside personal competence without dropping invoice accounting', async () => {
  const planned = await target();
  await expenses.linkCrossProject(
    tenantId,
    targetProjectId,
    planned.id,
    scope.expenseId,
    actor,
  );
  await setup.expense.updateMany({
    where: { tenantId, id: { in: [scope.expenseId, planned.id] } },
    data: { paidParcelas: '[0]' },
  });
  await setup.cashFlowEntry.updateMany({
    where: {
      tenantId,
      expenseId: { in: [scope.expenseId, planned.id] },
      parcela: '1/3',
    },
    data: { status: 'PAGO' },
  });
  await service.correct(scope, actor, await preview());
  const monthly = new MonthlyOverviewService(prisma, settlement);
  const dre = await monthly.getDreOverview(
    tenantId,
    projectId,
    { month: '2026-07', year: 2026 },
    actor,
  );
  expect(dre.mensal.despesaTotal).toBe(0);
  expect(
    (await monthly.getAccountView(tenantId, projectId, '2026-11', actor))
      .saidaTotal,
  ).toBe(12345);
});

it('corrects an officially restored CARD purchase through its real original batch without replacing CFEs', async () => {
  const original = await snapshot();
  await restoreDeletedPurchase();
  const restored = await snapshot();
  expect(restored.cash).toEqual(
    original.cash.map((entry) => ({ ...entry, updatedAt: expect.any(Date) })),
  );
  const apply = await preview();
  expect(await service.correct(scope, actor, apply)).toMatchObject({
    applied: true,
    afterTotalCents: 37045,
  });
  const corrected = await snapshot();
  expect(corrected.cash).toHaveLength(restored.cash.length);
  for (const before of restored.cash) {
    const after = corrected.cash.find((entry) => entry.id === before.id)!;
    if (before.id === changes[0].cashFlowEntryId) {
      expect(after).toEqual({
        ...before,
        valor: changes[0].amountCents,
        invoiceDueMonth: changes[0].invoiceDueMonth,
        updatedAt: after.updatedAt,
      });
    } else {
      expect(after).toEqual(before);
    }
  }
  const source = corrected.expenses.find((row) => row.id === scope.expenseId)!;
  expect(source.importId).toBe(scope.importId);
  expect(source.externalId).toBe(original.expenses[0].externalId);
  expect(parseStoredExpenseSchedule(source.documentedSchedule)).toMatchObject({
    version: 1,
    kind: 'source',
    importId: scope.importId,
  });
  await service.correct(scope, actor, apply);
  expect(await snapshot()).toEqual(corrected);
});

it('retains the final CARD companion barrier for a NEW documentary-cycle import after restoration', async () => {
  await restoreDeletedPurchase();
  const before = await snapshot();
  const csv = 'date,title,amount\n2026-10-14,Synthetic contract 2/3,123.51\n';
  const parsed = parseStatement(
    csv,
    scope.cardId,
    'CSV_GENERIC',
    'companion.csv',
  );
  const result = await cards.commitImport(
    tenantId,
    projectId,
    scope.cardId,
    csv,
    'companion.csv',
    'CSV_GENERIC',
    undefined,
    undefined,
    parsed.transactions.map(({ externalId }) => ({
      externalId,
      action: 'create',
      overrides: {
        documentaryCycle: { invoiceDueMonth: '2026-11', evidence },
      },
    })),
    actor.id,
    actor,
  );
  expect(result).toMatchObject({ inserted: 0, settled: 0, skipped: 1 });
  expect(await snapshot()).toEqual(before);
});
