require('../../../../scripts/test-db-env.cjs');

import { INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { CashFlowEntry, Expense, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  resetTenant,
  seedBankAccount,
  seedCardWithClosingDue,
  seedPessoal,
} from '../bank-account/__tests__/invoice-undo.fixtures';
import { ModulesGuard } from '../common/guards/modules.guard';
import { ProjectAccessGuard } from '../common/guards/project-access.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { FinancialScheduleResponseInterceptor } from '../common/interceptors/financial-schedule-response.interceptor';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { ExpenseModule } from '../expense/expense.module';
import { ExpenseService } from '../expense/expense.service';
import {
  parseStoredExpenseSchedule,
  serializeFinancialScheduleResponse,
} from '../expense/documented-schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CreditCardModule } from './credit-card.module';
import { CreditCardService } from './credit-card.service';
import { CardInvoiceSettlementService } from './card-invoice-settlement.service';
import { AgentService } from '../agent/agent.service';
import { AgentToolsService } from '../agent/tools/agent-tools.service';
import { ChatMessage, LlmProvider } from '../agent/llm/llm.types';
import { MonthlyOverviewService } from '../monthly-overview/monthly-overview.service';
import { TenantFinancialService } from '../tenant-financial/tenant-financial.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { ReceiptService } from '../receipt/receipt.service';

const tenantId = 'synthetic-assisted-701';
const projectId = `${tenantId}-personal`;
const targetProjectId = `${tenantId}-target`;
const foreignTenant = `${tenantId}-foreign`;
const actor = {
  id: `${tenantId}-actor`,
  tenantId,
  role: 'USER',
  allowedProjects: [projectId, targetProjectId],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses', 'creditCards', 'monthlyOverview'],
};
const evidence = {
  documentSha256: 'a'.repeat(64),
  reference: 'Synthetic statement proof',
};
const attesterId = `${tenantId}-attester`;
const attestationArtifact =
  'Declaração sintética — última parcela: R$ 10,00.\nTotal confirmado: R$ 60,01.\n';
const attestation = {
  evidenceKind: 'user-attestation',
  attestedByUserId: attesterId,
  attestedAt: '2026-09-23T12:00:00.000Z',
  documentSha256: createHash('sha256')
    .update(attestationArtifact, 'utf8')
    .digest('hex'),
  reference:
    '  Declaração UTF-8: última ocorrência; total confirmado.\nNão é fatura.  ',
};
async function authorizedAttester(): Promise<void> {
  await setup.user.create({
    data: {
      id: attesterId,
      tenantId,
      username: attesterId,
      name: 'Synthetic attester',
      role: actor.role,
      allowedProjects: JSON.stringify(actor.allowedProjects),
      allowedProjectTypes: JSON.stringify(actor.allowedProjectTypes),
      allowedModules: JSON.stringify(actor.allowedModules),
    },
  });
}
const marker = 'synthetic-legacy-import-marker';
const setup = new PrismaClient();
const prisma = new PrismaService();
let app: INestApplication;
let url: string;
let expenses: ExpenseService;
let conciliacao: ConciliacaoService;
let tools: AgentToolsService;
let source: Expense;
let cardId: string;
let rows: CashFlowEntry[];
let lookupFailure = false;
let writeFailure: 'cash-cas' | 'audit' | null = null;
prisma.$use(async (params, next) => {
  if (
    lookupFailure &&
    params.action === 'findUnique' &&
    ['CreditCardStatementImport', 'BankStatementImport'].includes(
      params.model ?? '',
    )
  )
    throw new Error('Synthetic unavailable existence probe');
  if (
    writeFailure === 'cash-cas' &&
    params.model === 'CashFlowEntry' &&
    params.action === 'updateMany'
  )
    return { count: 0 };
  if (
    writeFailure === 'audit' &&
    params.model === 'UserActivityLog' &&
    params.action === 'create'
  )
    throw new Error('Synthetic audit failure');
  return next(params);
});

interface Change {
  cashFlowEntryId: string;
  amountCents: number;
  evidence: typeof evidence;
  allocationBreakdown?: Array<{
    allocationId: string;
    targetCashFlowEntryId: string;
    amountCents: number;
  }>;
  mirrorCorrection?: {
    targetCashFlowEntryId: string;
    before: { sourceAmountCents: number; targetAmountCents: number };
    after: { sourceAmountCents: number; targetAmountCents: number };
  };
}
const assistance = (legacy = false) => ({
  basis: legacy ? 'absent-legacy-reference' : 'no-import-reference',
  reason: 'Synthetic operator-attested document, not historic import proof',
  evidence,
});
const changes = (): Change[] => [
  { cashFlowEntryId: rows[1].id, amountCents: 44996, evidence },
];
const route = (importId?: string): string =>
  importId
    ? `/projects/${projectId}/credit-cards/${cardId}/imports/${importId}/expenses/${source.id}/documented-schedule`
    : `/projects/${projectId}/credit-cards/${cardId}/expenses/${source.id}/documented-schedule/assisted`;
async function post(
  body: unknown,
  importId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await fetch(`${url}${route(importId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: result.status,
    body: (await result.json()) as Record<string, unknown>,
  };
}
async function preview(
  selected = changes(),
  legacy = false,
  importId?: string,
): Promise<Record<string, unknown>> {
  const result = await post(
    {
      mode: 'preview',
      changes: selected,
      ...(!importId ? { assistance: assistance(legacy) } : {}),
    },
    importId,
  );
  expect(result.status).toBe(201);
  return result.body;
}
async function applyRequest(
  selected = changes(),
  legacy = false,
  importId?: string,
): Promise<Record<string, unknown>> {
  const plan = await preview(selected, legacy, importId);
  return {
    mode: 'apply',
    requestId: 'synthetic-assisted-request',
    expectedFingerprint: plan.fingerprint,
    changes: selected,
    ...(!importId ? { assistance: assistance(legacy) } : {}),
  };
}
async function snapshot(): Promise<unknown> {
  const args = { where: { tenantId }, orderBy: { id: 'asc' as const } };
  return {
    expenses: await setup.expense.findMany(args),
    cash: await setup.cashFlowEntry.findMany(args),
    allocations: await setup.rateioAllocation.findMany(args),
    audits: await setup.userActivityLog.findMany(args),
    funding: await setup.crossProjectSettlement.findMany(args),
    claims: await setup.importedInvoiceLiquidation.findMany(args),
    imports: await setup.creditCardStatementImport.findMany(args),
    bankImports: await setup.bankStatementImport.findMany(args),
  };
}
async function cleanup(): Promise<void> {
  for (const id of [tenantId, foreignTenant]) {
    await setup.userActivityLog.deleteMany({ where: { tenantId: id } });
    await setup.user.deleteMany({ where: { tenantId: id } });
    await resetTenant(setup, id);
  }
}
async function batch(kind = 'active'): Promise<void> {
  const foreign = kind === 'foreign';
  if (foreign)
    await seedPessoal(setup, {
      tenantId: foreignTenant,
      projectId: foreignTenant,
    });
  const owner = foreign ? foreignTenant : tenantId;
  const project = foreign ? foreignTenant : projectId;
  if (kind.startsWith('bank')) {
    const account = await seedBankAccount(setup, {
      tenantId: owner,
      projectId: project,
      last4: '8701',
    });
    await setup.bankStatementImport.create({
      data: {
        id: marker,
        tenantId: owner,
        accountId: account.id,
        source: 'CSV_GENERIC',
        periodLabel: '2026-11',
        deletedAt: kind === 'bank-deleted' ? new Date() : null,
      },
    });
    return;
  }
  const selectedCard =
    kind === 'other-card' || foreign
      ? (
          await seedCardWithClosingDue(setup, {
            tenantId: owner,
            projectId: project,
            last4: '9701',
          })
        ).id
      : cardId;
  await setup.creditCardStatementImport.create({
    data: {
      id: marker,
      tenantId: owner,
      cardId: selectedCard,
      source: 'CSV_GENERIC',
      periodLabel: '2026-11',
      status: kind === 'failed' ? 'FAILED' : 'COMPLETED',
      deletedAt: kind === 'deleted' ? new Date() : null,
    },
  });
}

beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [CreditCardModule, ExpenseModule],
    providers: [
      ...[RolesGuard, ModulesGuard, ProjectAccessGuard].map((useClass) => ({
        provide: APP_GUARD,
        useClass,
      })),
      {
        provide: APP_INTERCEPTOR,
        useClass: FinancialScheduleResponseInterceptor,
      },
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  expenses = module.get(ExpenseService);
  conciliacao = module.get(ConciliacaoService);
  const monthly = new MonthlyOverviewService(
    prisma,
    module.get(CardInvoiceSettlementService),
  );
  const classifier = module.get(MerchantClassifierService);
  tools = new AgentToolsService(
    prisma,
    new TenantFinancialService(prisma, monthly),
    expenses,
    new ReceiptService(prisma, classifier),
    module.get(CreditCardService),
    classifier,
    {} as never,
    monthly,
  );
  app = module.createNestApplication();
  app.useLogger(false);
  app.use(
    (
      req: Request & { user?: typeof actor },
      _res: Response,
      next: NextFunction,
    ) => {
      req.user = actor;
      next();
    },
  );
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
});
beforeEach(async () => {
  lookupFailure = false;
  writeFailure = null;
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
      allowedProjectTypes: JSON.stringify(actor.allowedProjectTypes),
      allowedModules: JSON.stringify(actor.allowedModules),
    },
  });
  cardId = (
    await seedCardWithClosingDue(setup, {
      tenantId,
      projectId,
      last4: '7701',
      closingDay: 20,
      dueDay: 10,
    })
  ).id;
  source = await expenses.create(tenantId, projectId, {
    titulo: 'Synthetic manual card obligation',
    tipoDespesa: 'OUTROS',
    valor: 4500,
    quantidade: 1,
    formaPagamento: 'PARCELADO',
    quantidadeParcela: 10,
    dataInicioParcela: '2026-08-02',
    status: 'PLANEJADO',
    creditCardId: cardId,
  });
  rows = await prisma.cashFlowEntry.findMany({
    where: { expenseId: source.id, deletedAt: null },
    orderBy: { data: 'asc' },
  });
});
afterAll(async () => {
  lookupFailure = false;
  await app?.close();
  await cleanup();
  await prisma.$disconnect();
  await setup.$disconnect();
});

it.each([false, true])(
  'records honest V2 provenance and intact identity (legacy: %s), with stable retry',
  async (legacy) => {
    if (legacy)
      await setup.expense.update({
        where: { id: source.id },
        data: { importId: marker, externalId: 'legacy-external' },
      });
    const before = await snapshot();
    const apply = await applyRequest(changes(), legacy);
    expect(await snapshot()).toEqual(before);
    const later = await preview(changes(), legacy);
    expect(later.fingerprint).toBe(apply.expectedFingerprint);
    expect((await post(apply)).status).toBe(201);
    const stored = await prisma.expense.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(stored).toMatchObject({
      importId: legacy ? marker : null,
      externalId: legacy ? 'legacy-external' : null,
      valorTotal: 449996,
    });
    const parsed = parseStoredExpenseSchedule(stored.documentedSchedule);
    expect(parsed).toMatchObject({
      version: 2,
      kind: 'source',
      provenance: {
        kind: 'assisted-card',
        basis: assistance(legacy).basis,
        originalImportId: legacy ? marker : null,
        originalExternalId: legacy ? 'legacy-external' : null,
        reason: assistance(legacy).reason,
        referenceCheck: legacy
          ? 'ABSENT_IN_CARD_AND_BANK_IMPORTS'
          : 'NO_REFERENCE',
        evidence: {
          ...evidence,
          actorUserId: actor.id,
          recordedAt: expect.any(String),
        },
        ...(legacy ? { checkedAt: expect.any(String) } : {}),
      },
    });
    expect(parseStoredExpenseSchedule(JSON.stringify(parsed))).toEqual(parsed);
    const after = await snapshot();
    expect((await post(apply)).body).toMatchObject({ alreadyApplied: true });
    expect(await snapshot()).toEqual(after);
    expect(
      (
        await post({
          ...apply,
          assistance: { ...assistance(legacy), reason: 'Changed' },
        })
      ).status,
    ).toBe(409);
    const fresh = await prisma.cashFlowEntry.findMany({
      where: { expenseId: source.id, deletedAt: null },
      orderBy: { data: 'asc' },
    });
    expect(fresh).toEqual(
      rows.map((row, index) =>
        index === 1
          ? { ...row, valor: 44996, updatedAt: expect.any(Date) }
          : row,
      ),
    );
    const response = await fetch(
      `${url}/projects/${projectId}/expenses/${source.id}`,
    );
    const publicExpense = await response.json();
    expect(publicExpense).toHaveProperty('schedule.version', 1);
    const safe = serializeFinancialScheduleResponse({
      source: stored,
      nested: [{ plannedDocumentedSchedule: stored.documentedSchedule }],
    });
    for (const forbidden of [
      'provenance',
      'referenceCheck',
      'checkedAt',
      'lastOperation',
      'documentedSchedule',
      'plannedDocumentedSchedule',
      evidence.documentSha256,
      assistance().reason,
    ])
      for (const result of [safe, publicExpense])
        expect(JSON.stringify(result)).not.toContain(forbidden);
    expect(
      await prisma.creditCardStatementImport.count({ where: { tenantId } }),
    ).toBe(0);
  },
);

it.each([
  'active',
  'deleted',
  'failed',
  'other-card',
  'foreign',
  'bank',
  'bank-deleted',
])(
  'never admits a real %s import through assistance, regardless of scoped visibility',
  async (kind) => {
    await setup.expense.update({
      where: { id: source.id },
      data: { importId: marker },
    });
    await batch(kind);
    const before = await snapshot();
    const result = await post({
      mode: 'preview',
      changes: changes(),
      assistance: assistance(true),
    });
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain(marker);
    expect(await snapshot()).toEqual(before);
  },
);

it.each(['preview', 'retry'])(
  'reference appearing before %s/apply invalidates admission',
  async (stage) => {
    await setup.expense.update({
      where: { id: source.id },
      data: { importId: marker },
    });
    const apply = await applyRequest(changes(), true);
    if (stage === 'retry') expect((await post(apply)).status).toBe(201);
    await batch('deleted');
    const before = await snapshot();
    expect((await post(apply)).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  },
);

it.each([
  { state: 'valid', attested: false },
  { state: 'malformed', attested: false },
  { state: 'valid', attested: true },
  { state: 'malformed', attested: true },
])(
  'Maria transport keeps $state V2 provenance private (attested: $attested)',
  async ({ state, attested }) => {
    const selected = changes();
    if (attested) {
      await authorizedAttester();
      selected[0].evidence = attestation;
    }
    expect((await post(await applyRequest(selected))).status).toBe(201);
    if (state === 'malformed')
      await setup.expense.update({
        where: { id: source.id },
        data: { documentedSchedule: `{"private":"${evidence.reference}"` },
      });
    const raw = await expenses.findAll(tenantId, projectId);
    const execute = jest.spyOn(tools, 'execute').mockResolvedValue(raw);
    const delivered: ChatMessage[][] = [];
    const llm: LlmProvider = {
      id: 'synthetic-offline',
      isConfigured: () => true,
      chat: jest.fn(async (messages) => {
        delivered.push(structuredClone(messages));
        return messages.some((message) => message.role === 'tool')
          ? { content: 'OK', toolCalls: [] }
          : {
              content: '',
              toolCalls: [
                {
                  id: 'synthetic-call',
                  name: 'find_expenses',
                  arguments: { projectId },
                },
              ],
            };
      }),
    };
    try {
      const run = new AgentService(llm, tools).chat({
        ...actor,
        userId: actor.id,
        projectId,
        projectScope: [projectId],
        messages: [{ role: 'user', content: 'Synthetic expense lookup' }],
      });
      if (state === 'malformed')
        await expect(run).rejects.toThrow(
          /^Invalid documented expense schedule$/,
        );
      else {
        await run;
        const message = delivered[1].find((item) => item.role === 'tool')!;
        expect(JSON.parse(message.content)).toHaveProperty(
          'items.0.schedule.version',
          1,
        );
        expect(JSON.parse(message.content)).toHaveProperty(
          'items.0.schedule.occurrences.1.valor',
          44996,
        );
      }
      for (const secret of [
        'provenance',
        'documentSha256',
        evidence.reference,
        assistance().reason,
        'lastOperation',
        'evidenceKind',
        'attestedAt',
        'attestedByUserId',
        attesterId,
        attestation.reference,
        attestation.documentSha256,
      ])
        expect(JSON.stringify(delivered)).not.toContain(secret);
    } finally {
      execute.mockRestore();
    }
  },
);

it.each([
  'version',
  'extra',
  'null-evidence',
  'wrong-basis',
  'invalid-timestamp',
  'unknown-receipt-field',
])(
  'strict V2 parsing rejects %s without leaking stored JSON',
  async (fault) => {
    expect((await post(await applyRequest())).status).toBe(201);
    const saved = await prisma.expense.findUniqueOrThrow({
      where: { id: source.id },
    });
    const value = JSON.parse(saved.documentedSchedule!) as Record<
      string,
      unknown
    >;
    const provenance = value.provenance as Record<string, unknown>;
    if (fault === 'version') value.version = 3;
    if (fault === 'extra') provenance.importId = 'invented';
    if (fault === 'null-evidence') provenance.evidence = null;
    if (fault === 'wrong-basis') provenance.basis = 'absent-legacy-reference';
    if (fault === 'invalid-timestamp')
      (provenance.evidence as Record<string, unknown>).recordedAt =
        'not-a-date';
    if (fault === 'unknown-receipt-field')
      (value.lastOperation as Record<string, unknown>).public = true;
    expect(() => parseStoredExpenseSchedule(JSON.stringify(value))).toThrow(
      /^Invalid documented expense schedule$/,
    );
  },
);

it('a failed global existence lookup never proves absence', async () => {
  await setup.expense.update({
    where: { id: source.id },
    data: { importId: marker },
  });
  const apply = await applyRequest(changes(), true);
  const before = await snapshot();
  lookupFailure = true;
  try {
    expect((await post(apply)).status).toBe(500);
  } finally {
    lookupFailure = false;
  }
  expect(await snapshot()).toEqual(before);
});

it('attestation metadata cannot alter paid occurrences or create funding', async () => {
  await authorizedAttester();
  const selected = [{ ...changes()[0], evidence: attestation }];
  const apply = await applyRequest(selected);
  await setup.expense.update({
    where: { id: source.id },
    data: { paidParcelas: '[1]' },
  });
  await setup.cashFlowEntry.update({
    where: { id: rows[1].id },
    data: { status: 'PAGO' },
  });
  const before = await snapshot();
  expect((await post(apply)).status).toBe(409);
  expect(
    (
      await post({
        mode: 'preview',
        changes: selected,
        assistance: assistance(),
      })
    ).status,
  ).toBe(409);
  expect(await snapshot()).toEqual(before);
  expect(
    await setup.crossProjectSettlement.count({ where: { tenantId } }),
  ).toBe(0);
  expect(
    await setup.importedInvoiceLiquidation.count({ where: { tenantId } }),
  ).toBe(0);
});

it.each([
  undefined,
  null,
  { ...assistance(), basis: 'absent-legacy-reference' },
  { ...assistance(), reason: '' },
  { ...assistance(), importId: marker },
  { ...assistance(), evidence: { ...evidence, actorUserId: 'forged' } },
])('rejects invalid or mismatched assistance %j', async (invalid) => {
  const before = await snapshot();
  expect(
    (await post({ mode: 'preview', changes: changes(), assistance: invalid }))
      .status,
  ).toBe(400);
  expect(await snapshot()).toEqual(before);
});

it.each([false, true])(
  'does not make manual/orphan expenses eligible for the original import route (%s)',
  async (legacy) => {
    if (legacy)
      await setup.expense.update({
        where: { id: source.id },
        data: { importId: marker },
      });
    expect(
      (await post({ mode: 'preview', changes: changes() }, marker)).status,
    ).toBe(404);
  },
);

it.each([
  'quantity',
  'paid',
  'ambiguous-card',
  'grants',
  'ownership',
  'bank',
  'recurrence',
])(
  'rechecks %s before assisted apply without partial writes',
  async (drift) => {
    const apply = await applyRequest();
    if (drift === 'quantity')
      await setup.expense.update({
        where: { id: source.id },
        data: { quantidade: 10, valor: 45000 },
      });
    if (drift === 'paid') {
      await setup.expense.update({
        where: { id: source.id },
        data: { paidParcelas: '[1]' },
      });
      await setup.cashFlowEntry.update({
        where: { id: rows[1].id },
        data: { status: 'PAGO' },
      });
    }
    if (drift === 'ambiguous-card')
      await seedCardWithClosingDue(setup, {
        tenantId,
        projectId,
        last4: '7701',
      });
    if (drift === 'grants')
      await setup.user.update({
        where: { id: actor.id },
        data: { allowedProjects: JSON.stringify([targetProjectId]) },
      });
    if (drift === 'ownership')
      await setup.creditCard.update({
        where: { id: cardId },
        data: { projectId: targetProjectId },
      });
    if (drift === 'bank')
      await setup.expense.update({
        where: { id: source.id },
        data: { bankLast4: '1234' },
      });
    if (drift === 'recurrence')
      await setup.expense.update({
        where: { id: source.id },
        data: { recorrente: true },
      });
    const before = await snapshot();
    expect([404, 409]).toContain((await post(apply)).status);
    expect(await snapshot()).toEqual(before);
    if (drift === 'quantity')
      expect(
        (
          await post({
            mode: 'preview',
            changes: changes(),
            assistance: assistance(),
          })
        ).status,
      ).toBe(409);
  },
);

async function mirror(
  all = false,
  imported = false,
): Promise<{
  target: Expense;
  targetRows: CashFlowEntry[];
  selected: Change[];
}> {
  // Structurally equivalent legacy fixture: the source's physical CFEs, not division, own the amounts.
  await setup.cashFlowEntry.deleteMany({
    where: {
      expenseId: source.id,
      id: { in: rows.slice(6).map((row) => row.id) },
    },
  });
  rows = rows.slice(0, 6);
  await setup.expense.update({
    where: { id: source.id },
    data: {
      valor: 6001,
      valorTotal: 6001,
      quantidadeParcela: 6,
      ...(imported
        ? { importId: marker, externalId: 'synthetic-imported' }
        : {}),
    },
  });
  for (const [index, row] of rows.entries())
    await setup.cashFlowEntry.update({
      where: { id: row.id },
      data: { valor: index === 0 ? 1001 : 1000, parcela: `${index + 1}/6` },
    });
  if (imported) await batch();
  const target = await expenses.create(tenantId, targetProjectId, {
    titulo: 'Synthetic legacy counterpart',
    tipoDespesa: 'OUTROS',
    valor: all ? 60.06 : 60.02,
    quantidade: 1,
    formaPagamento: 'PARCELADO',
    quantidadeParcela: 6,
    dataInicioParcela: '2026-08-09',
    status: 'PLANEJADO',
  });
  const targetRows = await prisma.cashFlowEntry.findMany({
    where: { expenseId: target.id, deletedAt: null },
    orderBy: { data: 'asc' },
  });
  if (!all)
    for (const [index, row] of targetRows.entries())
      await setup.cashFlowEntry.update({
        where: { id: row.id },
        data: { valor: index < 2 ? 1001 : 1000 },
      });
  await setup.expense.update({
    where: { id: source.id },
    data: { linkedExpenseId: target.id },
  });
  const selected = [1, ...(all ? [2, 3, 4, 5] : [])].map((index) => ({
    cashFlowEntryId: rows[index].id,
    amountCents: 1000,
    evidence,
    mirrorCorrection: {
      targetCashFlowEntryId: targetRows[index].id,
      before: { sourceAmountCents: 1000, targetAmountCents: 1001 },
      after: { sourceAmountCents: 1000, targetAmountCents: 1000 },
    },
  }));
  return { target, targetRows, selected };
}

it.each([false, true])(
  'repairs a selected one-way mirror difference with source financial no-op (imported %s)',
  async (imported) => {
    const { target, selected } = await mirror(false, imported);
    const apply = await applyRequest(
      selected,
      false,
      imported ? marker : undefined,
    );
    const before = await setup.cashFlowEntry.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    expect((await post(apply, imported ? marker : undefined)).status).toBe(201);
    expect(
      await setup.cashFlowEntry.findMany({
        where: { tenantId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(
      before.map((row) =>
        row.id === selected[0].mirrorCorrection!.targetCashFlowEntryId
          ? { ...row, valor: 1000, updatedAt: expect.any(Date) }
          : row,
      ),
    );
    const stored = await prisma.expense.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(parseStoredExpenseSchedule(stored.documentedSchedule)).toMatchObject(
      {
        version: imported ? 1 : 2,
        lastOperation: {
          mirrorCorrections: selected.map((change) => ({
            cashFlowEntryId: change.cashFlowEntryId,
            ...change.mirrorCorrection,
          })),
        },
      },
    );
    const parsed = parseStoredExpenseSchedule(stored.documentedSchedule);
    expect(parseStoredExpenseSchedule(JSON.stringify(parsed))).toEqual(parsed);
    const json = JSON.stringify(serializeFinancialScheduleResponse(stored));
    expect(json).not.toContain('mirrorCorrections');
    expect(json).not.toContain('lastOperation');
    expect(
      (await prisma.expense.findUniqueOrThrow({ where: { id: target.id } }))
        .valorTotal,
    ).toBe(6001);
    const after = await snapshot();
    expect(
      (await post(apply, imported ? marker : undefined)).body,
    ).toMatchObject({ alreadyApplied: true });
    expect(await snapshot()).toEqual(after);
    await setup.cashFlowEntry.update({
      where: { id: selected[0].mirrorCorrection!.targetCashFlowEntryId },
      data: { valor: 999 },
    });
    const drifted = await snapshot();
    expect((await post(apply, imported ? marker : undefined)).status).toBe(409);
    expect(await snapshot()).toEqual(drifted);
  },
);

it.each(['cash-cas', 'audit'] as const)(
  'rolls back assisted source, counterpart and receipt on %s failure',
  async (failure) => {
    const { selected } = await mirror();
    const apply = await applyRequest(selected);
    const before = await snapshot();
    writeFailure = failure;
    try {
      expect((await post(apply)).status).toBe(
        failure === 'cash-cas' ? 409 : 500,
      );
    } finally {
      writeFailure = null;
    }
    expect(await snapshot()).toEqual(before);
  },
);

it('serializes assisted competing requests and records just one receipt and audit', async () => {
  const apply = await applyRequest();
  const results = await Promise.all([
    post(apply),
    post({ ...apply, requestId: 'other-request' }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  expect(await prisma.userActivityLog.count({ where: { tenantId } })).toBe(1);
  expect(
    (await prisma.expense.findUniqueOrThrow({ where: { id: source.id } }))
      .valorTotal,
  ).toBe(449996);
});

it('does not repair unselected future mirror differences; all documented differences can reconcile', async () => {
  const { target, selected } = await mirror(true);
  const before = await snapshot();
  const plan = await preview([selected[0]]);
  expect(plan).toMatchObject({
    applicable: false,
    reason: 'UNSELECTED_MIRROR_DRIFT',
    unselectedOccurrenceIndices: [2, 3, 4, 5],
  });
  expect(
    (
      await post({
        mode: 'apply',
        requestId: 'partial',
        expectedFingerprint: plan.fingerprint,
        changes: [selected[0]],
        assistance: assistance(),
      })
    ).status,
  ).toBe(409);
  expect(await snapshot()).toEqual(before);
  expect((await post(await applyRequest(selected))).status).toBe(201);
  expect(
    (await prisma.expense.findUniqueOrThrow({ where: { id: target.id } }))
      .valorTotal,
  ).toBe(6001);
});

it('keeps the orphan-marker six-occurrence case blocked when only the second difference is documented', async () => {
  const { selected } = await mirror(true);
  await setup.expense.update({
    where: { id: source.id },
    data: { importId: marker, externalId: 'synthetic-legacy-external' },
  });
  const before = await snapshot();
  const plan = await preview([selected[0]], true);
  expect(plan).toMatchObject({
    applicable: false,
    reason: 'UNSELECTED_MIRROR_DRIFT',
    unselectedOccurrenceIndices: [2, 3, 4, 5],
  });
  expect(
    (
      await post({
        mode: 'apply',
        requestId: 'synthetic-orphan-partial',
        expectedFingerprint: plan.fingerprint,
        changes: [selected[0]],
        assistance: assistance(true),
      })
    ).status,
  ).toBe(409);
  expect(await snapshot()).toEqual(before);
});

it.each([false, true])(
  'keeps document/attestation evidence distinct and private (real import: %s)',
  async (imported) => {
    await authorizedAttester();
    const { target, selected } = await mirror(true, imported);
    const input = selected.map((change, index) => ({
      ...change,
      evidence:
        index === selected.length - 1
          ? attestation
          : { ...evidence, evidenceKind: 'document' },
    }));
    const before = await setup.cashFlowEntry.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    const apply = await applyRequest(
      input,
      false,
      imported ? marker : undefined,
    );
    expect((await post(apply, imported ? marker : undefined)).status).toBe(201);
    const saved = await prisma.expense.findUniqueOrThrow({
      where: { id: source.id },
    });
    const stored = parseStoredExpenseSchedule(saved.documentedSchedule);
    expect(stored).toMatchObject({
      version: imported ? 1 : 2,
      kind: 'source',
      recordedByUserId: actor.id,
      lastOperation: { actorUserId: actor.id },
    });
    if (stored?.kind !== 'source') throw new Error('Expected source schedule');
    expect(stored.occurrences[1].amountEvidence).toMatchObject({
      ...evidence,
      evidenceKind: 'document',
      actorUserId: actor.id,
    });
    expect(stored.occurrences[5].amountEvidence).toEqual({
      ...attestation,
      actorUserId: actor.id,
      recordedAt: expect.any(String),
    });
    expect(stored.occurrences[0].amountEvidence).toBeNull();
    expect(stored.occurrences.every((row) => row.cycleEvidence === null)).toBe(
      true,
    );
    expect(parseStoredExpenseSchedule(JSON.stringify(stored))).toEqual(stored);
    expect(saved).toMatchObject({
      importId: imported ? marker : null,
      valorTotal: 6001,
    });
    const afterCash = await setup.cashFlowEntry.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    });
    expect(afterCash).toEqual(
      before.map((row) =>
        row.expenseId === target.id && row.parcela !== '1/6'
          ? { ...row, valor: 1000, updatedAt: expect.any(Date) }
          : row,
      ),
    );
    const after = await snapshot();
    expect(
      (await post(apply, imported ? marker : undefined)).body,
    ).toMatchObject({ alreadyApplied: true });
    expect(await snapshot()).toEqual(after);
    const changed = input.map((change, index) =>
      index === input.length - 1
        ? {
            ...change,
            evidence: { ...attestation, attestedByUserId: actor.id },
          }
        : change,
    );
    expect(
      (
        await post(
          { ...apply, changes: changed },
          imported ? marker : undefined,
        )
      ).status,
    ).toBe(409);
    for (const path of [
      `/projects/${projectId}/expenses/${source.id}`,
      `/projects/${projectId}/expenses`,
      `/projects/${targetProjectId}/expenses/${target.id}`,
    ]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      const json = JSON.stringify(await response.json());
      for (const secret of [
        'evidenceKind',
        'attestedByUserId',
        'attestedAt',
        attesterId,
        attestation.reference,
        attestation.documentSha256,
      ])
        expect(json).not.toContain(secret);
    }
  },
);

it('validates assistance attestation as well as occurrence evidence', async () => {
  await authorizedAttester();
  const body = {
    mode: 'preview',
    changes: changes(),
    assistance: { ...assistance(), evidence: attestation },
  };
  const plan = await post(body);
  expect(plan.status).toBe(201);
  expect(
    (
      await post({
        ...body,
        mode: 'apply',
        requestId: 'attested-assistance',
        expectedFingerprint: plan.body.fingerprint,
      })
    ).status,
  ).toBe(201);
  const stored = parseStoredExpenseSchedule(
    (await prisma.expense.findUniqueOrThrow({ where: { id: source.id } }))
      .documentedSchedule,
  );
  expect(stored).toMatchObject({
    version: 2,
    provenance: { evidence: { ...attestation, actorUserId: actor.id } },
  });
});

it('confirmed total and last occurrence do not supply evidence for other unknown mirror differences', async () => {
  await authorizedAttester();
  const { selected } = await mirror(true, true);
  const last = { ...selected[4], evidence: attestation };
  const before = await snapshot();
  const plan = await preview([last], false, marker);
  expect(plan).toMatchObject({
    applicable: false,
    reason: 'UNSELECTED_MIRROR_DRIFT',
    unselectedOccurrenceIndices: [1, 2, 3, 4],
  });
  expect(
    (
      await post(
        {
          mode: 'apply',
          requestId: 'only-confirmed-last',
          expectedFingerprint: plan.fingerprint,
          changes: [last],
        },
        marker,
      )
    ).status,
  ).toBe(409);
  expect(await snapshot()).toEqual(before);
});

it.each([
  'missing-kind',
  'unknown-kind',
  'document-with-attribution',
  'missing-attester',
  'missing-time',
  'invalid-time',
  'future-time',
  'client-actor',
  'client-recordedAt',
  'empty-hash',
  'null-kind',
])('rejects malformed attestation %s before any write', async (fault) => {
  await authorizedAttester();
  await preview();
  const proof: Record<string, unknown> = { ...attestation };
  if (fault === 'missing-kind') delete proof.evidenceKind;
  if (fault === 'unknown-kind') proof.evidenceKind = 'certified';
  if (fault === 'document-with-attribution') proof.evidenceKind = 'document';
  if (fault === 'missing-attester') delete proof.attestedByUserId;
  if (fault === 'missing-time') delete proof.attestedAt;
  if (fault === 'invalid-time') proof.attestedAt = '2026-02-30T12:00:00.000Z';
  if (fault === 'future-time') proof.attestedAt = '2999-01-01T00:00:00.000Z';
  if (fault === 'client-actor') proof.actorUserId = actor.id;
  if (fault === 'client-recordedAt') proof.recordedAt = attestation.attestedAt;
  if (fault === 'empty-hash') proof.documentSha256 = '';
  if (fault === 'null-kind') proof.evidenceKind = null;
  const before = await snapshot();
  expect(
    (
      await post({
        mode: 'preview',
        changes: [{ ...changes()[0], evidence: proof }],
        assistance: assistance(),
      })
    ).status,
  ).toBe(400);
  expect(await snapshot()).toEqual(before);
});

it.each([
  'missing',
  'foreign',
  'deleted',
  'projects',
  'modules',
  'malformed-grants',
])(
  'rechecks %s attester identity/permissions before apply and retry',
  async (fault) => {
    await authorizedAttester();
    const { selected } = await mirror();
    const input = [{ ...selected[0], evidence: attestation }];
    const apply = await applyRequest(input);
    expect((await post(apply)).status).toBe(201);
    if (fault === 'missing')
      await setup.user.delete({ where: { id: attesterId } });
    if (fault === 'foreign') {
      await seedPessoal(setup, {
        tenantId: foreignTenant,
        projectId: foreignTenant,
      });
      await setup.user.update({
        where: { id: attesterId },
        data: { tenantId: foreignTenant },
      });
    }
    if (fault === 'deleted')
      await setup.user.update({
        where: { id: attesterId },
        data: { deletedAt: new Date() },
      });
    if (fault === 'projects')
      await setup.user.update({
        where: { id: attesterId },
        data: { allowedProjects: JSON.stringify([projectId]) },
      });
    if (fault === 'modules')
      await setup.user.update({
        where: { id: attesterId },
        data: {
          allowedModules: '["receipts"]',
          allowedProjectTypes: '["REFORMA"]',
        },
      });
    if (fault === 'malformed-grants')
      await setup.user.update({
        where: { id: attesterId },
        data: { allowedProjects: 'not-json' },
      });
    const before = await snapshot();
    const result = await post(apply);
    expect(result.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain(attesterId);
    expect(await snapshot()).toEqual(before);
  },
);

it('revoking the attester after preview invalidates apply, including assistance-only attribution', async () => {
  await authorizedAttester();
  const body = {
    mode: 'preview',
    changes: changes(),
    assistance: { ...assistance(), evidence: attestation },
  };
  const plan = await post(body);
  expect(plan.status).toBe(201);
  await setup.user.update({
    where: { id: attesterId },
    data: { deletedAt: new Date() },
  });
  const before = await snapshot();
  expect(
    (
      await post({
        ...body,
        mode: 'apply',
        requestId: 'revoked',
        expectedFingerprint: plan.body.fingerprint,
      })
    ).status,
  ).toBe(404);
  expect(await snapshot()).toEqual(before);
});

it.each([
  'before',
  'after',
  'target-id',
  'allocation',
  'missing',
  'paid-target',
  'competing-owner',
  'hidden-target',
  'claim',
])('rejects invalid mirror matrix or graph: %s', async (invalid) => {
  const { target, selected } = await mirror();
  const valid = await applyRequest(selected);
  if (invalid === 'before')
    selected[0].mirrorCorrection!.before.targetAmountCents = 1002;
  if (invalid === 'after')
    selected[0].mirrorCorrection!.after.targetAmountCents = 1002;
  if (invalid === 'target-id')
    selected[0].mirrorCorrection!.targetCashFlowEntryId = rows[0].id;
  if (invalid === 'allocation')
    selected[0].allocationBreakdown = [
      {
        allocationId: 'invented',
        targetCashFlowEntryId: rows[0].id,
        amountCents: 1000,
      },
    ];
  if (invalid === 'missing') delete selected[0].mirrorCorrection;
  if (invalid === 'paid-target') {
    await setup.expense.update({
      where: { id: target.id },
      data: { paidParcelas: '[1]' },
    });
    await setup.cashFlowEntry.update({
      where: { id: selected[0].mirrorCorrection!.targetCashFlowEntryId },
      data: { status: 'PAGO' },
    });
  }
  if (invalid === 'competing-owner') {
    const other = await expenses.create(tenantId, targetProjectId, {
      tipoDespesa: 'OUTROS',
      valor: 1,
      quantidade: 1,
      formaPagamento: 'A_VISTA',
      status: 'PLANEJADO',
    });
    await setup.expense.update({
      where: { id: other.id },
      data: { linkedExpenseId: target.id },
    });
  }
  if (invalid === 'hidden-target')
    await setup.user.update({
      where: { id: actor.id },
      data: { allowedProjects: JSON.stringify([projectId]) },
    });
  if (invalid === 'claim') {
    await batch('bank');
    const payment = await expenses.create(tenantId, projectId, {
      tipoDespesa: 'OUTROS',
      valor: 10.01,
      quantidade: 1,
      formaPagamento: 'A_VISTA',
      status: 'PAGO',
      dataPagamento: '2026-09-09',
    });
    await setup.importedInvoiceLiquidation.create({
      data: {
        tenantId,
        paymentExpenseId: payment.id,
        importId: marker,
        cardId,
        purchaseExpenseId: target.id,
        cashFlowEntryId: selected[0].mirrorCorrection!.targetCashFlowEntryId,
        prevStatus: 'PLANEJADO',
        entryValorCents: 1001,
        parcela: '2/6',
        dueMonth: '2026-09',
      },
    });
  }
  const before = await snapshot();
  expect([400, 404, 409]).toContain(
    (
      await post({
        mode: 'preview',
        changes: selected,
        assistance: assistance(),
      })
    ).status,
  );
  expect([400, 404, 409]).toContain(
    (await post({ ...valid, changes: selected })).status,
  );
  expect(await snapshot()).toEqual(before);
});

it('requires an exact operator matrix for ten occurrences and nine targets, preserving all other CFEs and planned snapshots', async () => {
  const targets: Expense[] = [];
  for (let index = 0; index < 9; index++)
    targets.push(
      await expenses.create(tenantId, targetProjectId, {
        titulo: `Synthetic N9 ${index}`,
        tipoDespesa: 'OUTROS',
        valor: 500,
        quantidade: 1,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 10,
        dataInicioParcela: '2026-08-09',
        status: 'PLANEJADO',
      }),
    );
  await prisma.$transaction((tx) =>
    conciliacao.ratearSource(
      tx,
      {
        tenantId,
        sourceExpenseId: source.id,
        allocations: targets.map((target) => ({
          targetExpenseId: target.id,
          allocation: 50000,
        })),
      },
      actor,
    ),
  );
  const allocations = await prisma.rateioAllocation.findMany({
    where: { sourceExpenseId: source.id },
    orderBy: { id: 'asc' },
  });
  const cash = await prisma.cashFlowEntry.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { id: 'asc' },
  });
  expect(await preview()).toMatchObject({
    applicable: false,
    requiresAllocationBreakdown: true,
  });
  const selected = changes();
  selected[0].allocationBreakdown = allocations.map((allocation, index) => ({
    allocationId: allocation.id,
    targetCashFlowEntryId: cash.find(
      (row) =>
        row.expenseId === allocation.targetExpenseId && row.parcela === '2/10',
    )!.id,
    amountCents: index < 4 ? 4999 : 5000,
  }));
  const apply = await applyRequest(selected);
  const before = await snapshot();
  for (const cells of [
    selected[0].allocationBreakdown.slice(1),
    [
      selected[0].allocationBreakdown[0],
      ...selected[0].allocationBreakdown.slice(0, 8),
    ],
    selected[0].allocationBreakdown.map((cell) => ({
      ...cell,
      amountCents: 5000,
    })),
  ]) {
    expect([400, 409]).toContain(
      (
        await post({
          ...apply,
          changes: [{ ...selected[0], allocationBreakdown: cells }],
        })
      ).status,
    );
    expect(await snapshot()).toEqual(before);
  }
  expect((await post(apply)).status).toBe(201);
  const amounts = new Map([
    [rows[1].id, 44996],
    ...selected[0].allocationBreakdown.map(
      (cell) =>
        [cell.targetCashFlowEntryId, cell.amountCents] as [string, number],
    ),
  ]);
  expect(
    await prisma.cashFlowEntry.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(
    cash.map((row) =>
      amounts.has(row.id) && amounts.get(row.id) !== row.valor
        ? { ...row, valor: amounts.get(row.id), updatedAt: expect.any(Date) }
        : row,
    ),
  );
  expect(
    await prisma.rateioAllocation.findMany({
      where: { sourceExpenseId: source.id },
      orderBy: { id: 'asc' },
    }),
  ).toEqual(
    allocations.map((row, index) => ({
      ...row,
      allocation: index < 4 ? 49999 : 50000,
    })),
  );
  expect(
    (await prisma.expense.findUniqueOrThrow({ where: { id: source.id } }))
      .valorTotal,
  ).toBe(449996);
  await prisma.$transaction(async (tx) => {
    for (const target of targets)
      await conciliacao.regenerateRateioTargetCashflow(tx, target.id);
  });
  for (const [index, allocation] of allocations.entries()) {
    const entries = await prisma.cashFlowEntry.findMany({
      where: { expenseId: allocation.targetExpenseId, deletedAt: null },
      orderBy: { data: 'asc' },
    });
    expect(entries.map((row) => row.valor)).toEqual(
      Array.from({ length: 10 }, (_, occurrence) =>
        index < 4 && occurrence === 1 ? 4999 : 5000,
      ),
    );
  }
  await prisma.$transaction((tx) =>
    conciliacao.unratearSource(
      tx,
      { tenantId, sourceExpenseId: source.id },
      actor,
    ),
  );
  for (const target of targets) {
    expect(
      await prisma.expense.findUniqueOrThrow({ where: { id: target.id } }),
    ).toMatchObject({
      valorTotal: 50000,
      documentedSchedule: null,
      dataInicioParcela: target.dataInicioParcela,
    });
  }
  const retained = await prisma.expense.findUniqueOrThrow({
    where: { id: source.id },
  });
  expect(parseStoredExpenseSchedule(retained.documentedSchedule)).toMatchObject(
    {
      version: 2,
      provenance: { originalImportId: null },
      projections: [],
    },
  );
});
