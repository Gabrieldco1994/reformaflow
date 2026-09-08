// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import type { RateioRequester } from '../expense/rateio.types';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { MonthlyOverviewService } from '../monthly-overview/monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptService } from '../receipt/receipt.service';
import { BankAccountService, type BankImportDecision } from './bank-account.service';
import * as bankParsers from './parsers';

const CLOCK = new Date('2026-09-08T15:00:00.000Z');
const DATE = new Date('2026-09-01T00:00:00.000Z');
const TENANT = 'bank-credit-override-tenant';
const PROJECT = 'bank-credit-override-pessoal';
const TARGET_PROJECT = 'bank-credit-override-reforma';
const REQUESTER: RateioRequester = {
  role: 'USER',
  allowedProjects: [PROJECT, TARGET_PROJECT],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses', 'receipts', 'bankAccounts', 'creditCards'],
};

// Literal OFX amounts, not a test-side reconstruction of the service sign rule.
function statement(...amounts: string[]): Buffer {
  return Buffer.from(
    [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>',
      '<BANKACCTFROM><ACCTID>1881</ACCTID></BANKACCTFROM><BANKTRANLIST>',
      ...amounts.map((amount, index) =>
        [
          '<STMTTRN><TRNTYPE>OTHER</TRNTYPE>',
          '<DTPOSTED>20260901</DTPOSTED>',
          `<TRNAMT>${amount}</TRNAMT><FITID>override-${index}</FITID>`,
          `<MEMO>Ordinary movement ${index}</MEMO></STMTTRN>`,
        ].join('\n'),
      ),
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n'),
  );
}

describe('bank amount magnitude — real PrismaService and caixa', () => {
  const setup = new PrismaClient(); // Hard cleanup/read including soft-deleted rows only.
  const prisma = new PrismaService();
  let bank: BankAccountService;
  let monthly: MonthlyOverviewService;
  let receipts: ReceiptService;
  let accountId: string;
  const previousApiKey = process.env.GEMINI_API_KEY;

  async function cleanup(): Promise<void> {
    const where = { tenantId: TENANT };
    await setup.cashFlowEntry.deleteMany({ where });
    await setup.expense.deleteMany({ where });
    await setup.receipt.deleteMany({ where });
    await setup.bankStatementImport.deleteMany({ where });
    await setup.merchantCategory.deleteMany({ where });
    await setup.recurringBill.deleteMany({ where });
    await setup.bankAccount.deleteMany({ where });
    await setup.project.deleteMany({ where });
    await setup.tenant.deleteMany({ where: { id: TENANT } });
  }

  /** Full rows, including soft-deletes/timestamps: failed preflight must write nothing. */
  async function snapshot(): Promise<unknown> {
    const args = { where: { tenantId: TENANT }, orderBy: { id: 'asc' as const } };
    return Promise.all([
      setup.expense.findMany(args),
      setup.receipt.findMany(args),
      setup.cashFlowEntry.findMany(args),
      setup.bankStatementImport.findMany(args),
      setup.merchantCategory.findMany(args),
      setup.recurringBill.findMany(args),
      setup.bankAccount.findMany(args),
      setup.project.findMany(args),
      setup.creditCard.findMany(args),
      setup.crossProjectSettlement.findMany(args),
      setup.rateioAllocation.findMany(args),
      setup.invoiceAdjustment.findMany(args),
    ]);
  }

  async function preview(file: Buffer): Promise<string[]> {
    const result = await bank.previewImport(
      TENANT,
      PROJECT,
      accountId,
      file,
      'ordinary.ofx',
      'OFX',
      undefined,
      REQUESTER,
    );
    return result.preview.map((row) => row.externalId);
  }

  async function commit(
    file: Buffer,
    decisions?: BankImportDecision[],
  ): Promise<Awaited<ReturnType<BankAccountService['commitImport']>>> {
    return bank.commitImport(
      TENANT,
      PROJECT,
      accountId,
      file,
      'ordinary.ofx',
      'OFX',
      '2026-09',
      undefined,
      decisions,
      null,
      REQUESTER,
    );
  }

  async function expectRejected(file: Buffer, decisions: unknown, externalId: string, message: RegExp): Promise<void> {
    const before = await snapshot();
    // Simulate an untrusted JSON boundary; do not coerce invalid values to numbers.
    const result = commit(file, decisions as BankImportDecision[]);
    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toMatchObject({
      response: { externalId, message: expect.stringMatching(message) },
    });
    expect(await snapshot()).toEqual(before);
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout'],
    });
    jest.setSystemTime(CLOCK);
    delete process.env.GEMINI_API_KEY; // Real classifier, no external AI/credentials.
    await setup.$connect();
    await prisma.onModuleInit();
    const classifier = new MerchantClassifierService(prisma);
    const settlement = new CardInvoiceSettlementService(prisma);
    bank = new BankAccountService(prisma, classifier, new ConciliacaoService(prisma), settlement);
    monthly = new MonthlyOverviewService(prisma, settlement);
    receipts = new ReceiptService(prisma, classifier);
  });

  beforeEach(async () => {
    await cleanup();
    await prisma.tenant.create({ data: { id: TENANT, name: 'Credit override test' } });
    await prisma.project.create({
      data: { id: PROJECT, tenantId: TENANT, name: 'Pessoal', type: 'PESSOAL' },
    });
    await prisma.project.create({
      data: { id: TARGET_PROJECT, tenantId: TENANT, name: 'Reforma', type: 'REFORMA' },
    });
    const account = await bank.createAccount(TENANT, PROJECT, {
      institution: 'ITAU',
      nickname: 'Conta teste',
      last4: '1881',
      openingBalanceCents: 0,
      openingBalanceDate: '2026-08-31',
    });
    accountId = account.bankAccount.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousApiKey;
    jest.useRealTimers();
  });

  it.each([
    ['credit unchanged', '500.00', undefined, true, 50000, 50000],
    ['debit unchanged', '-500.00', undefined, false, 50000, -50000],
    ['credit edited', '500.00', 60000, true, 60000, 60000],
    ['debit edited', '-500.00', 60000, false, 60000, -60000],
    ['credit minimum', '500.00', 1, true, 1, 1],
    ['debit minimum', '-500.00', 1, false, 1, -1],
    ['credit Prisma Int maximum', '500.00', 2147483647, true, 2147483647, 2147483647],
    ['debit Prisma Int maximum', '-500.00', 2147483647, false, 2147483647, -2147483647],
  ] as const)(
    '%s preserves direction, account/date, flow and monthly caixa',
    async (_name, amount, override, credit, expectedAmount, expectedBalance) => {
      const file = statement(amount);
      const [externalId] = await preview(file);
      const result = await commit(
        file,
        override === undefined ? undefined : [{ externalId, overrides: { valorCents: override } }],
      );
      expect(result).toMatchObject({
        inserted: credit ? 0 : 1,
        receiptsInserted: credit ? 1 : 0,
        duplicated: 0,
        skipped: 0,
        failedItems: [],
      });
      const expenses = await prisma.expense.findMany({ where: { tenantId: TENANT } });
      const received = await prisma.receipt.findMany({ where: { tenantId: TENANT } });
      expect(expenses).toHaveLength(credit ? 0 : 1);
      expect(received).toHaveLength(credit ? 1 : 0);
      const movement = credit ? received[0] : expenses[0];
      expect(movement).toMatchObject({
        valor: expectedAmount,
        status: credit ? 'EM_CAIXA' : 'PAGO',
        bankLast4: '1881',
        externalId,
        importId: result.importId,
        deletedAt: null,
      });
      if (credit) {
        expect(received[0]).toMatchObject({ data: DATE, linkedReceiptId: null });
      } else {
        expect(expenses[0]).toMatchObject({
          valorTotal: expectedAmount,
          dataPagamento: DATE,
          cardLast4: null,
          linkedExpenseId: null,
        });
      }
      expect(await prisma.cashFlowEntry.findMany({ where: { tenantId: TENANT } })).toEqual([
        expect.objectContaining({
          valor: expectedAmount,
          tipo: credit ? 'RECEBIMENTO' : 'DESPESA',
          status: credit ? 'EM_CAIXA' : 'PAGO',
          data: DATE,
          formaPagamento: 'CONTA_CORRENTE',
          deletedAt: null,
          receiptId: credit ? movement.id : null,
          expenseId: credit ? null : movement.id,
        }),
      ]);
      const caixa = await monthly.getCaixaConta(TENANT, PROJECT, CLOCK);
      expect(caixa).toMatchObject({ hoje: expectedBalance, saldoInicial: 0, temSaldoInicial: true });
      expect(caixa.porMes).toContainEqual({ mes: '2026-09', caixa: expectedBalance });
    },
  );

  it.each(['500.00', '-500.00'])('explicit undefined preserves original %s', async (amount) => {
    const file = statement(amount);
    const [externalId] = await preview(file);
    await commit(file, [{ externalId, overrides: { valorCents: undefined } }]);
    expect((await monthly.getCaixaConta(TENANT, PROJECT, CLOCK)).hoje).toBe(amount === '500.00' ? 50000 : -50000);
  });

  it.each([null, '60000', 1.5, 0, -1, -60000, 2147483648, NaN, Infinity, -Infinity, true, {}])(
    'invalid second-row override %p rejects the whole batch without writes',
    async (invalid: unknown) => {
      for (const amount of ['500.00', '-500.00']) {
        const file = statement('-500.00', amount);
        const [first, second] = await preview(file);
        await expectRejected(
          file,
          [
            { externalId: first, overrides: { valorCents: 60000, category: 'ALIMENTACAO' } },
            { externalId: second, overrides: { valorCents: invalid } },
          ],
          second,
          /valor.*centavos.*inteiro/i,
        );
      }
    },
  );

  it('rejects explicit magnitude for an original zero rather than inventing direction', async () => {
    // Current file parsers filter zero. Inject only that otherwise unreachable
    // parser output to protect the service boundary; all financial logic is real.
    const file = statement('500.00');
    const parsed = await bankParsers.parseBankStatementBuffers([file], accountId, 'OFX');
    const externalId = parsed.transactions[0].externalId;
    const parser = jest.spyOn(bankParsers, 'parseBankStatementBuffers').mockResolvedValueOnce({
      ...parsed,
      transactions: [{ ...parsed.transactions[0], amountCents: 0 }],
    });
    try {
      await expectRejected(file, [{ externalId, overrides: { valorCents: 1 } }], externalId, /zero.*dire[çc][ãa]o/i);
    } finally {
      parser.mockRestore();
    }
  });

  it('keeps the existing parser exclusion of zero bank-file rows', async () => {
    const file = statement('0.00');
    expect(await preview(file)).toEqual([]);
    expect(await commit(file)).toMatchObject({ total: 0, inserted: 0, receiptsInserted: 0 });
  });

  it('does not validate overrides on skipped rows', async () => {
    const file = statement('500.00');
    const [externalId] = await preview(file);
    const payload: unknown = [{ externalId, action: 'skip', overrides: { valorCents: null } }];
    expect(await commit(file, payload as BankImportDecision[])).toMatchObject({
      inserted: 0,
      receiptsInserted: 0,
      skipped: 1,
    });
    expect(await prisma.cashFlowEntry.count({ where: { tenantId: TENANT } })).toBe(0);
  });

  it('replay of the original file cannot update or recreate the edited credit', async () => {
    const file = statement('500.00');
    const [externalId] = await preview(file);
    await commit(file, [{ externalId, overrides: { valorCents: 60000 } }]);
    const before = await snapshot();
    for (const decisions of [
      undefined,
      [{ externalId, overrides: { valorCents: 70000 } }],
      [{ externalId, overrides: { valorCents: null } }],
    ]) {
      const result = await commit(file, decisions as BankImportDecision[] | undefined);
      expect(result).toMatchObject({ inserted: 0, receiptsInserted: 0, duplicated: 1 });
      // Existing semantics retain an empty audit import on each replay.
      await setup.bankStatementImport.delete({ where: { id: result.importId } });
      expect(await snapshot()).toEqual(before);
    }
    expect((await monthly.getCaixaConta(TENANT, PROJECT, CLOCK)).hoje).toBe(60000);
  });

  it('changed credit magnitude with a receipt link rejects the whole batch before writes', async () => {
    const target = await receipts.create(TENANT, TARGET_PROJECT, {
      valor: 500,
      data: '2026-09-01',
      tipo: 'PAGAMENTO',
      status: 'PREVISTO',
    });
    const file = statement('-500.00', '500.00');
    const [first, second] = await preview(file);
    await expectRejected(
      file,
      [
        { externalId: first, overrides: { category: 'ALIMENTACAO' } },
        { externalId: second, action: 'link', linkToReceiptId: target.id, overrides: { valorCents: 60000 } },
      ],
      second,
      /remova.*v[íi]nculo/i,
    );
  });

  it.each([undefined, 50000])('receipt link with magnitude %p keeps existing semantics', async (value) => {
    const target = await receipts.create(TENANT, TARGET_PROJECT, {
      valor: 500,
      data: '2026-09-01',
      tipo: 'PAGAMENTO',
      status: 'PREVISTO',
    });
    const file = statement('500.00');
    const [externalId] = await preview(file);
    const result = await commit(file, [
      {
        externalId,
        action: 'link',
        linkToReceiptId: target.id,
        ...(value === undefined ? {} : { overrides: { valorCents: value } }),
      },
    ]);
    expect(result).toMatchObject({ linked: 1, receiptsInserted: 1, inserted: 0 });
    expect(await prisma.receipt.findFirst({ where: { tenantId: TENANT, projectId: PROJECT } })).toMatchObject({
      valor: 50000,
      linkedReceiptId: target.id,
      status: 'EM_CAIXA',
    });
    expect(await prisma.receipt.findUnique({ where: { id: target.id } })).toMatchObject({
      valor: 50000,
      status: 'EM_CAIXA',
    });
    expect(await prisma.cashFlowEntry.findFirst({ where: { receiptId: target.id } })).toMatchObject({
      valor: 50000,
      status: 'EM_CAIXA',
    });
    expect((await monthly.getCaixaConta(TENANT, PROJECT, CLOCK)).hoje).toBe(50000);
  });

  it.each([true, false])('edited internal credit preserves registered-account neutrality=%s', async (owned) => {
    const destination = await bank.createAccount(TENANT, PROJECT, {
      institution: 'ITAU',
      nickname: 'Destino',
      last4: '1882',
    });
    const file = statement('500.00');
    const [externalId] = await preview(file);
    expect(
      await commit(file, [
        {
          externalId,
          overrides: {
            valorCents: 60000,
            category: 'MOVIMENTACAO_INTERNA',
            transferToAccountId: owned ? destination.bankAccount.id : null,
          },
        },
      ]),
    ).toMatchObject({ receiptsInserted: 1, inserted: 0 });
    expect(await prisma.receipt.findFirst({ where: { tenantId: TENANT } })).toMatchObject({
      valor: 60000,
      tipo: 'RESGATE',
      status: 'EM_CAIXA',
      bankLast4: '1881',
      data: DATE,
    });
    const entries = await prisma.cashFlowEntry.findMany({ where: { tenantId: TENANT } });
    expect(entries).toHaveLength(owned ? 0 : 1);
    if (!owned) expect(entries[0]).toMatchObject({ valor: 60000, tipo: 'RECEBIMENTO', status: 'EM_CAIXA' });
    // Caixa is source-based and type-agnostic, not a sum of neutral CashFlowEntries.
    expect((await monthly.getCaixaConta(TENANT, PROJECT, CLOCK)).hoje).toBe(60000);
  });
});
