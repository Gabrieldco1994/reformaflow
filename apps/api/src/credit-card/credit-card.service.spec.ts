import { Test, TestingModule } from '@nestjs/testing';
import { CreditCardService } from './credit-card.service';
import { PrismaService } from '../prisma/prisma.service';

type AnyFn = jest.Mock;

function makePrismaMock() {
  return {
    project: { findFirst: jest.fn() },
    creditCard: { findFirst: jest.fn() },
    creditCardStatementImport: { create: jest.fn(), update: jest.fn() },
    creditCardTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    },
    expense: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  } as any;
}

function ofxFor(date: string, amountReais: number, memo: string, fitid: string) {
  // amount negativo = despesa em OFX cartão de crédito
  return `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${date}</DTPOSTED><TRNAMT>-${amountReais.toFixed(2)}</TRNAMT><FITID>${fitid}</FITID><MEMO>${memo}</MEMO></STMTTRN>`;
}

function buildOfx(...stmts: string[]) {
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
    ...stmts,
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\n');
}

describe('CreditCardService - previewImport (cross-project matches)', () => {
  let service: CreditCardService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [CreditCardService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(CreditCardService);

    prisma.creditCard.findFirst.mockResolvedValue({
      id: 'card1', tenantId: 't1', projectId: 'pessoal1', brand: 'MASTERCARD', last4: '1234',
    });
  });

  it('retorna crossProjectMatches para despesas planejadas em outros projetos', async () => {
    prisma.project.findMany = jest.fn().mockResolvedValue([
      { id: 'reforma1', name: 'Reforma Casa', type: 'REFORMA' },
    ]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp1',
        projectId: 'reforma1',
        titulo: 'POLO MARMORESS',
        fornecedor: null,
        valorTotal: 215834,
        dataInicioParcela: new Date('2026-04-28'),
        dataPagamento: null,
        createdAt: new Date('2026-04-01'),
      },
    ]);

    const ofx = buildOfx(ofxFor('20260429', 2158.34, 'POLO MARMORESS', 'X1'));
    const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'fatura.ofx', 'OFX');

    expect(result.preview).toHaveLength(1);
    expect(result.preview[0].crossProjectMatches).toHaveLength(1);
    const match = result.preview[0].crossProjectMatches[0];
    expect(match.expenseId).toBe('exp1');
    expect(match.projectName).toBe('Reforma Casa');
    expect(match.valorCents).toBe(215834);
    expect(match.deltaCents).toBe(0);
  });

  it('não retorna match quando valor diverge mais que 5% da despesa planejada', async () => {
    prisma.project.findMany = jest.fn().mockResolvedValue([
      { id: 'reforma1', name: 'Reforma', type: 'REFORMA' },
    ]);
    prisma.expense.findMany.mockResolvedValue([
      {
        id: 'exp1',
        projectId: 'reforma1',
        titulo: 'POLO',
        fornecedor: null,
        valorTotal: 100000, // R$ 1000
        dataInicioParcela: new Date('2026-04-28'),
        dataPagamento: null,
        createdAt: new Date('2026-04-01'),
      },
    ]);

    const ofx = buildOfx(ofxFor('20260429', 2000, 'POLO', 'X2')); // R$ 2000, muito longe
    const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'fatura.ofx', 'OFX');

    expect(result.preview[0].crossProjectMatches).toHaveLength(0);
  });

  it('retorna futureInstallments separado das transações atuais', async () => {
    prisma.project.findMany = jest.fn().mockResolvedValue([]);
    prisma.expense.findMany.mockResolvedValue([]);

    // OFX não tem conceito de "futuras" — mas garantimos que campo existe (vazio)
    const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA', 'X3'));
    const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');

    expect(result.futureInstallments).toBeDefined();
    expect(Array.isArray(result.futureInstallments)).toBe(true);
  });
});
