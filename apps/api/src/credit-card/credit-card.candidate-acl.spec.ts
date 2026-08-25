import { ForbiddenException } from '@nestjs/common';
import { CreditCardService } from './credit-card.service';
import type { RateioRequester } from '../expense/rateio.types';

const USER: RateioRequester = {
  role: 'USER',
  allowedProjects: ['pessoal', 'visible'],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};

function serviceWith(prisma: any): CreditCardService {
  return new CreditCardService(
    prisma,
    {} as any,
    { manualExpenseType: jest.fn().mockResolvedValue(null) } as any,
  );
}

function cardOfx(): Buffer {
  return Buffer.from(
    [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260810</DTPOSTED>',
      '<TRNAMT>-100.00</TRNAMT><FITID>acl-480</FITID><MEMO>LOJA</MEMO></STMTTRN>',
      '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    ].join('\n'),
  );
}

describe('CreditCardService candidate ACL (#480)', () => {
  it('rejects a missing requester before candidate reads', async () => {
    const prisma = {
      creditCard: { findFirst: jest.fn() },
      project: { findMany: jest.fn() },
    };
    const service = serviceWith(prisma);

    await expect(
      service.previewImport(
        'tenant',
        'pessoal',
        'card',
        cardOfx(),
        'statement.ofx',
        'OFX',
        undefined,
        undefined as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.creditCard.findFirst).not.toHaveBeenCalled();
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('filters current and future matches to the resolved project scope before take', async () => {
    const projects = [
      { id: 'visible', name: 'Visible', type: 'REFORMA' },
      { id: 'hidden', name: 'Hidden', type: 'CASA' },
    ];
    const prisma: any = {
      creditCard: {
        findFirst: jest.fn().mockResolvedValue({ id: 'card', last4: '1234' }),
      },
      project: {
        findMany: jest.fn(({ where, select }: any) => {
          const rows = select?.name ? projects : projects.map(({ id }) => ({ id }));
          const ids = where.id?.in;
          return Promise.resolve(ids ? rows.filter((row) => ids.includes(row.id)) : rows);
        }),
      },
      expense: {
        findMany: jest.fn(({ where }: any) => {
          if (!where.projectId?.in) return Promise.resolve([]);
          return Promise.resolve(
            [
              plannedExpense('visible-exp', 'visible'),
              plannedExpense('hidden-exp', 'hidden'),
            ].filter((row) => where.projectId.in.includes(row.projectId)),
          );
        }),
      },
      $transaction: jest.fn((run: any) => run(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = serviceWith(prisma);

    const result: any = await service.previewImport(
      'tenant',
      'pessoal',
      'card',
      cardOfx(),
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
