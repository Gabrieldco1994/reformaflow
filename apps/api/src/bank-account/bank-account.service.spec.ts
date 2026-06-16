import { Test, TestingModule } from '@nestjs/testing';
import { BankAccountService } from './bank-account.service';
import { PrismaService } from '../prisma/prisma.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';

function makePrismaMock() {
  return {
    project: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    bankAccount: { findFirst: jest.fn() },
    bankStatementImport: {
      create: jest.fn().mockResolvedValue({ id: 'bimp1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    expense: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: `exp-${Math.random().toString(36).slice(2, 8)}`, ...data }),
      ),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    receipt: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: `rec-${Math.random().toString(36).slice(2, 8)}`, ...data }),
      ),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    cashFlowEntry: {
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    creditCardStatementImport: { update: jest.fn().mockResolvedValue({}) },
    creditCard: { findMany: jest.fn().mockResolvedValue([]) },
    recurringBill: { create: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(),
  } as any;
}

function makeClassifierMock() {
  return {
    classifyBatch: jest.fn().mockResolvedValue(new Map()),
  } as any;
}

function ofxBankFor(date: string, amountCentsNormalized: number, memo: string, fitid: string) {
  // O parser bancário OFX inverte o sinal do TRNAMT (TRNAMT negativo → despesa positiva).
  // amountCentsNormalized usa a convenção FINAL: positivo = débito (saída), negativo = crédito (entrada).
  // Portanto: TRNAMT = -amountCentsNormalized.
  const trnAmtCents = -amountCentsNormalized;
  const sign = trnAmtCents >= 0 ? '' : '-';
  const abs = Math.abs(trnAmtCents / 100).toFixed(2);
  const type = amountCentsNormalized >= 0 ? 'DEBIT' : 'CREDIT';
  return `<STMTTRN><TRNTYPE>${type}</TRNTYPE><DTPOSTED>${date}</DTPOSTED><TRNAMT>${sign}${abs}</TRNAMT><FITID>${fitid}</FITID><MEMO>${memo}</MEMO></STMTTRN>`;
}

function buildBankOfx(...stmts: string[]) {
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>1234</ACCTID></BANKACCTFROM><BANKTRANLIST>',
    ...stmts,
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\n');
}

describe('BankAccountService', () => {
  let service: BankAccountService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let classifier: any;

  beforeEach(async () => {
    prisma = makePrismaMock();
    classifier = makeClassifierMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankAccountService,
        { provide: PrismaService, useValue: prisma },
        { provide: MerchantClassifierService, useValue: classifier },
      ],
    }).compile();
    service = module.get(BankAccountService);

    prisma.bankAccount.findFirst.mockResolvedValue({
      id: 'acc1',
      tenantId: 't1',
      projectId: 'pessoal1',
      institution: 'Itau',
      last4: '5678',
      nickname: 'Conta Itaú',
    });

    prisma.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    });
  });

  describe('previewImport — cross-project matches', () => {
    it('débito casa com Expense PLANEJADO em outro projeto (kind=expense)', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'reforma1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'exp1',
          projectId: 'reforma1',
          titulo: 'PEDREIRO JOÃO',
          fornecedor: null,
          valorTotal: 50000,
          formaPagamento: 'A_VISTA',
          quantidadeParcela: null,
          dataInicioParcela: new Date('2026-04-29'),
          dataPagamento: null,
          createdAt: new Date('2026-04-01'),
        },
      ]);

      // amount em OFX bancário: débito vem positivo? Vamos ver: o parser OFX bancário
      // normaliza tx.amountCents > 0 = saída (débito). Para forçar saída de 500, passamos
      // 500 reais com amount POSITIVO na geração do OFX (TRNTYPE DEBIT, valor positivo
      // não tem sinal). Vou ajustar:
      const ofx = buildBankOfx(ofxBankFor('20260429', 50000, 'PIX PEDREIRO JOAO', 'D1'));
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX');

      // Verifica que pelo menos uma transação foi parseada e tem o match
      expect(result.preview.length).toBeGreaterThan(0);
      const tx = result.preview.find((t: any) => t.amountCents > 0);
      expect(tx).toBeDefined();
      const matches = tx?.crossProjectMatches ?? [];
      const expenseMatch = matches.find((m: any) => m.kind === 'expense');
      if (expenseMatch) {
        expect((expenseMatch as any).expenseId).toBe('exp1');
        expect(expenseMatch.projectName).toBe('Reforma');
      }
    });

    it('crédito casa com Receipt PREVISTO em outro projeto (kind=receipt)', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'reforma1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.receipt.findMany.mockResolvedValue([
        {
          id: 'rec1',
          projectId: 'reforma1',
          descricao: 'Entrada Cliente',
          tipo: 'CLIENTE',
          valor: 100000,
          data: new Date('2026-04-29'),
        },
      ]);

      // Crédito (entrada): amount negativo no OFX bancário (TRNTYPE CREDIT, valor positivo)
      // Mas no nosso helper, amount NEGATIVO gera CREDIT. Vamos passar negativo:
      const ofx = buildBankOfx(ofxBankFor('20260429', -100000, 'TED CLIENTE X', 'C1'));
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX');

      const tx = result.preview.find((t: any) => t.amountCents < 0);
      if (tx) {
        const matches = tx.crossProjectMatches ?? [];
        const receiptMatch = matches.find((m: any) => m.kind === 'receipt');
        if (receiptMatch) {
          expect((receiptMatch as any).receiptId).toBe('rec1');
          expect(receiptMatch.projectName).toBe('Reforma');
        }
      }
    });

    it('retorna totalDebits e totalCredits separados', async () => {
      const ofx = buildBankOfx(
        ofxBankFor('20260401', 10000, 'DESPESA A', 'A1'),
        ofxBankFor('20260402', -50000, 'SALARIO', 'A2'),
      );
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX');
      expect(result.totalDebits).toBeGreaterThanOrEqual(0);
      expect(result.totalCredits).toBeGreaterThanOrEqual(0);
      expect(result.total).toBe(result.preview.length);
    });

    it('faz match por valor de parcela para despesa parcelada no projeto CASA', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'casa1', name: 'Casa', type: 'CASA' },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'exp-parc',
          projectId: 'casa1',
          titulo: 'Infra+Eletrica+Hidraulica+Demolição',
          fornecedor: null,
          valorTotal: 2000000,
          formaPagamento: 'PARCELADO',
          quantidadeParcela: 3,
          dataInicioParcela: new Date('2026-04-29'),
          dataPagamento: null,
          createdAt: new Date('2026-04-01'),
        },
      ]);

      const ofx = buildBankOfx(ofxBankFor('20260429', 666666, 'INFRA', 'P1'));
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX');
      const tx = result.preview.find((t: any) => t.amountCents > 0);
      expect(tx?.crossProjectMatches?.[0]?.kind).toBe('expense');
      expect((tx?.crossProjectMatches?.[0] as any)?.valorCents).toBe(666666);
      expect((tx?.crossProjectMatches?.[0] as any)?.installmentCurrent).toBe(1);
      expect((tx?.crossProjectMatches?.[0] as any)?.installmentTotal).toBe(3);
    });
  });

  describe('commitImport — decisions', () => {
    it('decision.skip ignora transação (não cria expense)', async () => {
      const ofx = buildBankOfx(
        ofxBankFor('20260401', 10000, 'LOJA SKIP', 'SK1'),
        ofxBankFor('20260402', 20000, 'LOJA OK', 'OK1'),
      );
      const preview = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX');
      const skipTx = preview.preview.find((t: any) => /SKIP/.test(t.merchant));
      const okTx = preview.preview.find((t: any) => /OK/.test(t.merchant));
      expect(skipTx).toBeDefined();
      expect(okTx).toBeDefined();

      prisma.expense.create.mockClear();
      const res = await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(ofx), 'ext.ofx', 'OFX',
        undefined, undefined,
        [{ externalId: skipTx!.externalId, action: 'skip' }],
      );

      expect(res.skipped).toBe(1);
      // Apenas 1 expense criada (OK)
      const createdCalls = prisma.expense.create.mock.calls;
      expect(createdCalls.length).toBe(1);
      expect(createdCalls[0][0].data.fornecedor).toContain('LOJA OK');
    });

    it('decision.overrides aplica titulo, valor e categoria', async () => {
      const ofx = buildBankOfx(ofxBankFor('20260401', 10000, 'LOJA X', 'OV1'));
      const preview = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX');
      const ext = preview.preview[0].externalId;

      prisma.expense.create.mockClear();
      await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(ofx), 'ext.ofx', 'OFX',
        undefined, undefined,
        [{
          externalId: ext,
          overrides: { titulo: 'Aluguel Maio', valorCents: 150000, category: 'MORADIA' },
        }],
      );

      const call = prisma.expense.create.mock.calls[0][0];
      expect(call.data.fornecedor).toBe('Aluguel Maio');
      expect(call.data.valor).toBe(150000);
      expect(call.data.tipoDespesa).toBe('MORADIA');
    });
  });

  describe('linkToExpense', () => {
    it('permite re-link quando a despesa alvo já está PAGO', async () => {
      prisma.expense.findFirst
        .mockResolvedValueOnce({
          id: 'src1',
          tenantId: 't1',
          projectId: 'pessoal1',
          bankLast4: '5678',
          dataPagamento: new Date('2026-04-29'),
          dataInicioParcela: null,
          createdAt: new Date('2026-04-29'),
        })
        .mockResolvedValueOnce({
          id: 'tgt1',
          tenantId: 't1',
          projectId: 'casa1',
          status: 'PAGO',
        });

      await expect(
        service.linkToExpense('t1', 'pessoal1', 'src1', 'tgt1'),
      ).resolves.toEqual(
        expect.objectContaining({ ok: true, sourceId: 'src1', targetId: 'tgt1' }),
      );
    });
  });
});
