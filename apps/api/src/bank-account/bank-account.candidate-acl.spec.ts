import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BankAccountService } from './bank-account.service';
import type { RateioRequester } from '../expense/rateio.types';

const USER: RateioRequester = {
  role: 'USER',
  allowedProjects: ['pessoal', 'visible'],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  // Cada RECURSO exige o seu módulo (#480 SEC-1): Expense → `expenses`,
  // Receipt → `receipts`, cartão/fatura → `creditCards`.
  allowedModules: ['expenses', 'receipts', 'creditCards'],
};

function serviceWith(prisma: any): BankAccountService {
  return new BankAccountService(
    prisma,
    { manualExpenseType: jest.fn().mockResolvedValue(null) } as any,
    {} as any,
    { prepareSettleInvoice: jest.fn().mockResolvedValue({ purchases: [] }) } as any,
  );
}

function bankOfx(): Buffer {
  return Buffer.from(
    [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>',
      '<BANKACCTFROM><ACCTID>1234</ACCTID></BANKACCTFROM><BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260810</DTPOSTED>',
      '<TRNAMT>-100.00</TRNAMT><FITID>acl-480</FITID><MEMO>LOJA</MEMO></STMTTRN>',
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n'),
  );
}

describe('BankAccountService candidate ACL (#480)', () => {
  it('rejects a missing requester before candidate reads', async () => {
    const prisma = {
      bankAccount: { findFirst: jest.fn() },
      project: { findMany: jest.fn() },
    };
    const service = serviceWith(prisma);

    await expect(
      service.previewImport(
        'tenant',
        'pessoal',
        'account',
        bankOfx(),
        'statement.ofx',
        'OFX',
        undefined,
        undefined as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.bankAccount.findFirst).not.toHaveBeenCalled();
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('scopes projects before take/ranking and hides expense and receipt competitors', async () => {
    const projectRows = [
      { id: 'visible', name: 'Visible', type: 'REFORMA' },
      { id: 'hidden', name: 'Hidden', type: 'CASA' },
    ];
    const prisma: any = {
      bankAccount: {
        findFirst: jest.fn().mockResolvedValue({ id: 'account', last4: '1234' }),
      },
      project: {
        findMany: jest.fn(({ where, select }: any) => {
          const rows = select?.name ? projectRows : projectRows.map(({ id }) => ({ id }));
          const ids = where.id?.in;
          return Promise.resolve(ids ? rows.filter((row) => ids.includes(row.id)) : rows);
        }),
      },
      expense: {
        findMany: jest.fn(({ where }: any) =>
          Promise.resolve(
            [
              plannedExpense('visible-exp', 'visible'),
              plannedExpense('hidden-exp', 'hidden'),
            ].filter((row) => where.projectId.in.includes(row.projectId)),
          )),
      },
      receipt: {
        findMany: jest.fn(({ where }: any) =>
          Promise.resolve(
            [
              plannedReceipt('visible-rec', 'visible'),
              plannedReceipt('hidden-rec', 'hidden'),
            ].filter((row) => where.projectId.in.includes(row.projectId)),
          )),
      },
      creditCard: { findMany: jest.fn().mockResolvedValue([]) },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn((run: any) => run(prisma)),
    };
    const service = serviceWith(prisma);

    const result: any = await service.previewImport(
      'tenant',
      'pessoal',
      'account',
      bankOfx(),
      'statement.ofx',
      'OFX',
      undefined,
      USER,
    );

    expect(result.preview[0].crossProjectMatches.map((row: any) => row.projectId)).toEqual([
      'visible',
    ]);
    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: { in: ['visible'] } }),
        take: 1000,
      }),
    );
    expect(prisma.receipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: { in: ['visible'] } }),
        take: 1000,
      }),
    );
  });

  it('groups accessible cards by last4 and scopes entries by project plus last4', async () => {
    const prisma: any = {
      project: {
        findMany: jest.fn().mockResolvedValue([{ id: 'visible-a' }, { id: 'visible-b' }]),
      },
      creditCard: {
        findMany: jest.fn().mockResolvedValue([
          card('card-a', 'visible-a', '4444'),
          card('card-b', 'visible-b', '4444'),
        ]),
      },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = serviceWith(prisma);

    const cards = await service.loadCardsWithEntries(
      'tenant',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-12-31T00:00:00.000Z'),
      USER,
      prisma,
    );

    expect(cards).toEqual([]);
    expect(prisma.cashFlowEntry.findMany).not.toHaveBeenCalled();
  });

  it('loads entries only through the authorized project+last4 pair', async () => {
    const prisma: any = {
      project: {
        findMany: jest.fn().mockResolvedValue([{ id: 'visible' }]),
      },
      creditCard: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            where.projectId.in.includes('visible')
              ? [card('card-visible', 'visible', '4444')]
              : [],
          )),
      },
      cashFlowEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            projectId: 'visible',
            valor: 10_000,
            data: new Date('2026-08-01T00:00:00.000Z'),
            expense: { cardLast4: '4444' },
          },
        ]),
      },
    };
    const service = serviceWith(prisma);

    const cards = await service.loadCardsWithEntries(
      'tenant',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-12-31T00:00:00.000Z'),
      USER,
      prisma,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].entries).toHaveLength(1);
    expect(prisma.cashFlowEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            expect.objectContaining({
              projectId: 'visible',
              expense: expect.objectContaining({
                projectId: 'visible',
                cardLast4: '4444',
                deletedAt: null,
              }),
            }),
          ],
        }),
      }),
    );
  });

  it('rejects an explicit ambiguous legacy last4 before writes', async () => {
    const prisma: any = {
      project: {
        findMany: jest.fn().mockResolvedValue([{ id: 'visible-a' }, { id: 'visible-b' }]),
      },
      creditCard: {
        findMany: jest.fn().mockResolvedValue([
          card('card-a', 'visible-a', '4444'),
          card('card-b', 'visible-b', '4444'),
        ]),
      },
      bankStatementImport: { create: jest.fn() },
      expense: { create: jest.fn() },
      receipt: { create: jest.fn() },
      cashFlowEntry: { create: jest.fn() },
    };
    const service = serviceWith(prisma);

    await expect(
      (service as any).prepareBankCardPayments(
        'tenant',
        [
          {
            transaction: {
              externalId: 'crafted',
              merchant: 'PAGAMENTO FATURA',
              amountCents: 10_000,
              date: new Date('2026-08-10T00:00:00.000Z'),
            },
            categoryOverride: 'PAGAMENTO_FATURA_CARTAO',
            cardOverride: '4444',
          },
        ],
        USER,
        prisma,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.bankStatementImport.create).not.toHaveBeenCalled();
    expect(prisma.expense.create).not.toHaveBeenCalled();
    expect(prisma.receipt.create).not.toHaveBeenCalled();
    expect(prisma.cashFlowEntry.create).not.toHaveBeenCalled();
  });

  it('makes hidden and missing explicit cards the same 404 with zero writes', async () => {
    const writes = {
      bankStatementImport: { create: jest.fn() },
      expense: { create: jest.fn() },
      receipt: { create: jest.fn() },
      cashFlowEntry: { create: jest.fn() },
    };
    const makePrisma = (includeHidden: boolean): any => ({
      project: {
        findMany: jest.fn().mockResolvedValue([{ id: 'visible' }]),
      },
      creditCard: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            includeHidden && where.projectId.in.includes('hidden')
              ? [card('card-hidden', 'hidden', '9999')]
              : [],
          )),
      },
      ...writes,
    });
    const row = {
      transaction: {
        externalId: 'crafted-hidden',
        merchant: 'PAGAMENTO FATURA',
        amountCents: 10_000,
        date: new Date('2026-08-10T00:00:00.000Z'),
      },
      categoryOverride: 'PAGAMENTO_FATURA_CARTAO',
      cardOverride: '9999',
    };

    const errors = [];
    for (const includeHidden of [false, true]) {
      const prisma = makePrisma(includeHidden);
      try {
        await (serviceWith(prisma) as any).prepareBankCardPayments(
          'tenant',
          [row],
          USER,
          prisma,
        );
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getStatus()).toBe(404);
      expect((error as NotFoundException).getResponse()).toEqual(
        (errors[0] as NotFoundException).getResponse(),
      );
    }
    expect(writes.bankStatementImport.create).not.toHaveBeenCalled();
    expect(writes.expense.create).not.toHaveBeenCalled();
    expect(writes.receipt.create).not.toHaveBeenCalled();
    expect(writes.cashFlowEntry.create).not.toHaveBeenCalled();
  });
});

function plannedExpense(id: string, projectId: string): any {
  return {
    id,
    projectId,
    titulo: id,
    fornecedor: null,
    valorTotal: 10_000,
    formaPagamento: 'A_VISTA',
    quantidadeParcela: null,
    dataInicioParcela: new Date('2026-08-10T00:00:00.000Z'),
    dataPagamento: new Date('2026-08-10T00:00:00.000Z'),
    installmentDateOverrides: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

function plannedReceipt(id: string, projectId: string): any {
  return {
    id,
    projectId,
    descricao: id,
    valor: 10_000,
    data: new Date('2026-08-10T00:00:00.000Z'),
  };
}

function card(id: string, projectId: string, last4: string): any {
  return {
    id,
    projectId,
    last4,
    nickname: id,
    brand: 'Visa',
    closingDay: 1,
    dueDay: 10,
  };
}
