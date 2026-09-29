require('../../../../scripts/test-db-env.cjs');

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CreditCardService } from './credit-card.service';
import { CardInvoiceSettlementService } from './card-invoice-settlement.service';
import { parseStatement } from './parsers';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { ExpenseService } from '../expense/expense.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import {
  parseDocumentaryCycle,
  parseStoredExpenseSchedule,
} from '../expense/documented-schedule';
import {
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
} from '../bank-account/__tests__/invoice-undo.fixtures';

const TENANT = 'synthetic-701-import-core';
const PROJECT = `${TENANT}-pessoal`;
const REQUESTER = { ...pessoalRequester(PROJECT), id: 'synthetic-701-actor' };
const CYCLE = {
  invoiceDueMonth: '2026-11',
  evidence: {
    documentSha256: 'a'.repeat(64),
    reference: 'Synthetic statement line 1',
  },
};

describe('documentary import lifecycle with real middleware', () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const cards = new CreditCardService(
    prisma,
    conciliacao,
    new MerchantClassifierService(prisma),
  );
  const settlement = new CardInvoiceSettlementService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  let cardId: string;
  let failCash = false;

  prisma.$use(async (params, next) => {
    if (
      failCash &&
      params.model === 'CashFlowEntry' &&
      params.action === 'create'
    ) {
      throw new Error('Synthetic cash write failure');
    }
    return next(params);
  });

  beforeAll(async () => {
    await prisma.$connect();
    await setup.$connect();
  });
  beforeEach(async () => {
    failCash = false;
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: '0701',
      closingDay: 20,
      dueDay: 10,
    }));
  });
  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.$disconnect();
    await setup.$disconnect();
  });

  async function importRows(rows: string[], overrides = {}) {
    const csv = `date,title,amount\n${rows.join('\n')}\n`;
    const transactions = parseStatement(
      csv,
      cardId,
      'CSV_GENERIC',
      'synthetic.csv',
    ).transactions;
    return cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      'synthetic.csv',
      'CSV_GENERIC',
      undefined,
      undefined,
      transactions.map(({ externalId }) => ({
        externalId,
        action: 'create',
        overrides: { documentaryCycle: CYCLE, ...overrides },
      })),
      REQUESTER.id,
      REQUESTER,
    );
  }

  it.each([12345, -7, -321])(
    'persists the exact source evidence for signed %i cents, including replay',
    async (amount) => {
      const rows = [`2026-08-14,Synthetic entry,${(amount / 100).toFixed(2)}`];
      expect((await importRows(rows)).inserted).toBe(1);
      const source = await prisma.expense.findFirstOrThrow({
        where: { tenantId: TENANT },
        include: { cashFlow: true },
      });
      const stored = parseStoredExpenseSchedule(source.documentedSchedule);
      expect(stored).toEqual({
        version: 1,
        kind: 'source',
        tenantId: TENANT,
        sourceExpenseId: source.id,
        sourceProjectId: PROJECT,
        cardId,
        importId: source.importId,
        externalId: source.externalId,
        recordedByUserId: REQUESTER.id,
        recordedAt: expect.any(String),
        occurrences: [
          {
            index: 0,
            parcela: null,
            valor: amount,
            data: '2026-08-14',
            invoiceDueMonth: '2026-11',
            amountEvidence: null,
            cycleEvidence: {
              ...CYCLE.evidence,
              actorUserId: REQUESTER.id,
              recordedAt: stored?.recordedAt,
            },
          },
        ],
        projections: [],
        lastOperation: null,
      });
      expect(source.cashFlow[0]).toMatchObject({
        data: new Date('2026-08-14'),
        invoiceDueMonth: '2026-11',
        valor: amount,
        status: amount > 0 ? 'PLANEJADO' : 'PAGO',
      });
      expect((await importRows(rows)).duplicated).toBe(1);
      expect(
        await prisma.expense.findUnique({
          where: { id: source.id },
          include: { cashFlow: true },
        }),
      ).toEqual(source);
    },
  );

  it.each([12345, -7])(
    'rolls back expense, cycle and evidence when CFE insertion fails (%i)',
    async (amount) => {
      failCash = true;
      const result = await importRows([
        `2026-08-14,Synthetic failure,${(amount / 100).toFixed(2)}`,
      ]);
      expect(result).toMatchObject({ inserted: 0, skipped: 1 });
      expect(await setup.expense.count({ where: { tenantId: TENANT } })).toBe(
        0,
      );
      expect(
        await setup.cashFlowEntry.count({ where: { tenantId: TENANT } }),
      ).toBe(0);
    },
  );

  it.each([12345, -7])(
    'does not change the parser sign through documentary overrides (%i)',
    async (amount) => {
      const result = await importRows(
        [`2026-08-14,Synthetic sign,${(amount / 100).toFixed(2)}`],
        { valorCents: -amount },
      );
      expect(result).toMatchObject({ inserted: 0, skipped: 1 });
      expect(await setup.expense.count({ where: { tenantId: TENANT } })).toBe(
        0,
      );
      expect(
        await setup.cashFlowEntry.count({ where: { tenantId: TENANT } }),
      ).toBe(0);
    },
  );

  it('settles local index zero (printed 2/3) and undo never reopens signed credits', async () => {
    await importRows(['2026-07-14,Synthetic serial 2/3,123.45']);
    await importRows([
      '2026-08-14,Synthetic rebate,-0.07',
      '2026-09-14,Synthetic discount,-3.21',
    ]);
    const before = await prisma.expense.findMany({
      where: { tenantId: TENANT },
      include: { cashFlow: { orderBy: { data: 'asc' } } },
    });
    const source = before.find((row) => row.valorTotal > 0)!;
    const card = await prisma.creditCard.findUniqueOrThrow({
      where: { id: cardId },
    });
    const result = await settlement.settleInvoice({
      tenantId: TENANT,
      card,
      amountCents: 12017,
      paymentDate: new Date('2026-11-05'),
      requester: REQUESTER,
    });
    expect(result.flippedEntries).toEqual([
      expect.objectContaining({
        cashFlowEntryId: source.cashFlow[0].id,
        parcela: '2/3',
        dueMonth: '2026-11',
        valorCents: 12345,
      }),
    ]);
    const paid = await prisma.expense.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(paid).toMatchObject({
      status: 'PLANEJADO',
      paidParcelas: '[0]',
      documentedSchedule: source.documentedSchedule,
    });
    const undone = await prisma.$transaction((tx) =>
      settlement.unsettleInvoice({
        tenantId: TENANT,
        card,
        dueMonth: '2026-11',
        tx,
        requester: REQUESTER,
      }),
    );
    expect(undone).toEqual({ revertedExpenses: 1, revertedParcelas: 1 });
    const after = await prisma.expense.findMany({
      where: { tenantId: TENANT },
      include: { cashFlow: { orderBy: { data: 'asc' } } },
    });
    for (const row of before) {
      const restored = after.find((item) => item.id === row.id)!;
      expect(restored.documentedSchedule).toBe(row.documentedSchedule);
      expect(restored.status).toBe(row.status);
      expect(restored.paidParcelas).toBe(row.paidParcelas);
      expect(
        restored.cashFlow.map(({ updatedAt: _updatedAt, ...entry }) => entry),
      ).toEqual(
        row.cashFlow.map(({ updatedAt: _updatedAt, ...entry }) => entry),
      );
    }
    expect(
      await prisma.importedInvoiceLiquidation.count({
        where: { tenantId: TENANT },
      }),
    ).toBe(0);
  });

  it('resolves legacy imported labels against local occurrences, not the printed numerator', async () => {
    await importRows(['2026-07-14,Synthetic legacy 2/3,123.45'], {
      documentaryCycle: undefined,
    });
    const source = await prisma.expense.findFirstOrThrow({
      where: { tenantId: TENANT },
      include: { cashFlow: { orderBy: { data: 'asc' } } },
    });
    const card = await prisma.creditCard.findUniqueOrThrow({
      where: { id: cardId },
    });
    await settlement.settleInvoice({
      tenantId: TENANT,
      card,
      amountCents: 12345,
      paymentDate: new Date('2026-08-05'),
      requester: REQUESTER,
    });
    expect(
      await prisma.expense.findUniqueOrThrow({ where: { id: source.id } }),
    ).toMatchObject({ paidParcelas: '[0]', documentedSchedule: null });
    await prisma.$transaction((tx) =>
      settlement.unsettleInvoice({
        tenantId: TENANT,
        card,
        dueMonth: '2026-08',
        tx,
        requester: REQUESTER,
      }),
    );
    expect(
      await prisma.expense.findUniqueOrThrow({ where: { id: source.id } }),
    ).toMatchObject({
      paidParcelas: null,
      status: 'PLANEJADO',
      documentedSchedule: null,
    });
  });

  it('rolls back settlement rather than guessing an index from an incomplete legacy series', async () => {
    await importRows(['2026-07-14,Synthetic incomplete 2/3,123.45'], {
      documentaryCycle: undefined,
    });
    const source = await prisma.expense.findFirstOrThrow({
      where: { tenantId: TENANT },
      include: { cashFlow: { orderBy: { data: 'asc' } } },
    });
    await prisma.cashFlowEntry.delete({ where: { id: source.cashFlow[1].id } });
    const card = await prisma.creditCard.findUniqueOrThrow({
      where: { id: cardId },
    });
    await expect(
      settlement.settleInvoice({
        tenantId: TENANT,
        card,
        amountCents: 12345,
        paymentDate: new Date('2026-08-05'),
        requester: REQUESTER,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await prisma.cashFlowEntry.findUniqueOrThrow({
        where: { id: source.cashFlow[0].id },
      }),
    ).toEqual(source.cashFlow[0]);
    expect(
      await prisma.expense.findUniqueOrThrow({ where: { id: source.id } }),
    ).toMatchObject({
      paidParcelas: null,
      status: 'PLANEJADO',
      documentedSchedule: null,
    });
  });

  it('keeps metadata editable and rejects generic financial regeneration without a partial write', async () => {
    await importRows(['2026-07-14,Synthetic serial 2/3,123.45']);
    const source = await prisma.expense.findFirstOrThrow({
      where: { tenantId: TENANT },
      include: { cashFlow: true },
    });
    await expenses.update(
      TENANT,
      PROJECT,
      source.id,
      { titulo: 'Verified synthetic title' },
      REQUESTER,
    );
    const edited = await prisma.expense.findUniqueOrThrow({
      where: { id: source.id },
      include: { cashFlow: true },
    });
    expect(edited.documentedSchedule).toBe(source.documentedSchedule);
    expect(edited.cashFlow).toEqual(source.cashFlow);
    await expect(
      expenses.update(TENANT, PROJECT, source.id, { valor: 300 }, REQUESTER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await prisma.expense.findUniqueOrThrow({
        where: { id: source.id },
        include: { cashFlow: true },
      }),
    ).toEqual(edited);
  });

  it.each([
    null,
    {},
    { ...CYCLE, invoiceDueMonth: '2026-13' },
    { ...CYCLE, status: 'PAGO' },
    { ...CYCLE, evidence: { ...CYCLE.evidence, actorUserId: 'forged' } },
    { ...CYCLE, evidence: { ...CYCLE.evidence, documentSha256: 'not-a-hash' } },
  ])(
    'rejects incomplete, invalid or forged documentary input (%#)',
    (input) => {
      expect(() => parseDocumentaryCycle(input)).toThrow(RangeError);
    },
  );
});
