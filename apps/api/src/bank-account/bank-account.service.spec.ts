import { TEST_OWNER_REQUESTER } from '../test-utils/acl-requester-test-helper';
import { Test, TestingModule } from '@nestjs/testing';
import { BankAccountService } from './bank-account.service';
import { PrismaService } from '../prisma/prisma.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { withAclRequester } from '../test-utils/acl-requester-test-helper';
import { NotFoundException } from '@nestjs/common';
import type { RateioRequester } from '../expense/rateio.types';

const RESTRICTED_IMPORT_REQUESTER: RateioRequester = {
  role: 'USER',
  allowedProjects: ['pessoal1'],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};

function makePrismaMock() {
  return {
    project: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    bankAccount: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
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
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    creditCardStatementImport: {
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    creditCard: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
    recurringBill: { create: jest.fn(), findFirst: jest.fn() },
    crossProjectSettlement: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rateioAllocation: {
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
}

const NO_LEARNED_RULE = {
  expenseType: null,
  source: null,
  confidence: null,
  category: null,
  reason: 'sem-regra' as const,
};

function makeClassifierMock() {
  return {
    classifyBatch: jest.fn().mockResolvedValue(new Map()),
    manualExpenseType: jest.fn().mockResolvedValue(null),
    resolveLearnedExpenseType: jest.fn().mockResolvedValue(NO_LEARNED_RULE),
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

function plannedMatcherExpenses(formaPagamento: 'PARCELADO' | 'QUINZENAL') {
  return [
    {
      id: 'exp-override',
      projectId: 'casa1',
      titulo: 'Parcela reagendada',
      fornecedor: null,
      valorTotal: 50000,
      formaPagamento,
      quantidadeParcela: 1,
      dataInicioParcela: new Date('2026-01-01'),
      dataPagamento: null,
      installmentDateOverrides: '{"0":"2026-04-29"}',
      createdAt: new Date('2026-01-01'),
    },
    {
      id: 'exp-avista',
      projectId: 'casa1',
      titulo: 'Pagamento único',
      fornecedor: null,
      valorTotal: 50000,
      formaPagamento: 'A_VISTA',
      quantidadeParcela: null,
      dataInicioParcela: new Date('2026-04-28'),
      dataPagamento: null,
      installmentDateOverrides: null,
      createdAt: new Date('2026-01-01'),
    },
  ];
}

describe('BankAccountService', () => {
  let service: BankAccountService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let classifier: any;
  let settlement: CardInvoiceSettlementService;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const projects = new Map([
      ['pessoal1', { id: 'pessoal1', tenantId: 't1', type: 'PESSOAL', deletedAt: null }],
      ['reforma1', { id: 'reforma1', tenantId: 't1', type: 'REFORMA', deletedAt: null }],
      ['casa1', { id: 'casa1', tenantId: 't1', type: 'CASA', deletedAt: null }],
    ]);
    prisma.project.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.tenantId === 't1' && where.deletedAt === null
          ? projects.get(where.id) ?? null
          : null,
      ),
    );
    classifier = makeClassifierMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankAccountService,
        ConciliacaoService,
        { provide: PrismaService, useValue: prisma },
        { provide: MerchantClassifierService, useValue: classifier },
        CardInvoiceSettlementService,
      ],
    }).compile();
    service = withAclRequester(module.get(BankAccountService), prisma);
    settlement = module.get(CardInvoiceSettlementService);

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

  describe('listAccounts', () => {
    it('retorna saldo por conta a partir de recebimentos menos despesas pagas não neutras', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 'pessoal1', tenantId: 't1' });
      prisma.bankAccount.findMany.mockResolvedValue([
        {
          id: 'acc1',
          tenantId: 't1',
          projectId: 'pessoal1',
          institution: 'Itau',
          last4: '5678',
          nickname: 'Conta Itaú',
        },
        {
          id: 'acc2',
          tenantId: 't1',
          projectId: 'pessoal1',
          institution: 'Nubank',
          last4: '0001',
          nickname: 'Nu',
        },
      ]);
      prisma.receipt.findMany.mockResolvedValue([
        { bankLast4: '5678', valor: 150000 },
        { bankLast4: '0001', valor: 20000 },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        { bankLast4: '5678', valorTotal: 25000 },
        { bankLast4: '5678', valorTotal: 10000 },
      ]);

      const result = await service.listAccounts('t1', 'pessoal1');

      expect(result).toEqual([
        expect.objectContaining({ id: 'acc1', balanceCents: 115000 }),
        expect.objectContaining({ id: 'acc2', balanceCents: 20000 }),
      ]);
      expect(prisma.receipt.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: 't1',
          projectId: 'pessoal1',
          bankLast4: { in: ['5678', '0001'] },
          status: { in: ['EM_CAIXA', 'PAGO'] },
          deletedAt: null,
        },
        select: { bankLast4: true, valor: true },
      });
      expect(prisma.expense.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: 't1',
          projectId: 'pessoal1',
          bankLast4: { in: ['5678', '0001'] },
          status: 'PAGO',
          tipoDespesa: { notIn: ['PAGAMENTO_FATURA_CARTAO', 'MOVIMENTACAO_INTERNA'] },
          deletedAt: null,
        },
        select: { bankLast4: true, valorTotal: true },
      });
    });

    it('mantém saldo zero quando não há movimentos vinculados', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 'pessoal1', tenantId: 't1' });
      prisma.bankAccount.findMany.mockResolvedValue([
        { id: 'acc1', tenantId: 't1', projectId: 'pessoal1', institution: 'Itau', last4: '5678', nickname: 'Conta Itaú' },
      ]);

      const result = await service.listAccounts('t1', 'pessoal1');

      expect(result[0]).toEqual(expect.objectContaining({ id: 'acc1', balanceCents: 0 }));
    });
  });

  describe('previewImport — cross-project matches', () => {
    it('PIX PF sem regra manual permanece OUTROS no preview', async () => {
      classifier.resolveLearnedExpenseType.mockResolvedValue(NO_LEARNED_RULE);
      const ofx = buildBankOfx(ofxBankFor('20260401', 10000, 'PIX TRANSF JOAO SILVA', 'PF1'));
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const tx = result.preview.find((t: any) => t.amountCents > 0);
      expect(tx?.suggestedCategory).toBe('OUTROS');
      expect(tx?.categoriaFonte).toBeNull();
    });

    it('regra MANUAL do tenant aparece como fonte regra no preview (#582 PR-2)', async () => {
      classifier.resolveLearnedExpenseType.mockResolvedValue({
        expenseType: 'MORADIA', source: 'MANUAL_TENANT', confidence: 1, category: 'moradia', reason: 'resolvido',
      });
      const ofx = buildBankOfx(ofxBankFor('20260401', 10000, 'ENEL DISTRIBUICAO', 'RG1'));
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const tx = result.preview.find((t: any) => t.amountCents > 0);
      expect(tx?.suggestedCategory).toBe('MORADIA');
      expect(tx?.categoriaFonte).toBe('regra');
      expect(classifier.manualExpenseType).not.toHaveBeenCalled();
    });

    it('regra AI do tenant >= limiar vira sugestão no preview (#582 PR-2)', async () => {
      classifier.resolveLearnedExpenseType.mockResolvedValue({
        expenseType: 'TRANSPORTE', source: 'AI_TENANT', confidence: 0.9, category: 'transporte', reason: 'resolvido',
      });
      const ofx = buildBankOfx(ofxBankFor('20260401', 10000, 'POSTO SHELL 42', 'AI1'));
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const tx = result.preview.find((t: any) => t.amountCents > 0);
      expect(tx?.suggestedCategory).toBe('TRANSPORTE');
      expect(tx?.categoriaFonte).toBe('regra');
    });

    it('regra AI do tenant < limiar (sub-limiar) NÃO vira sugestão — cai no classificador local (#582 PR-2)', async () => {
      classifier.resolveLearnedExpenseType.mockResolvedValue({
        expenseType: null, source: null, confidence: null, category: null, reason: 'sub-limiar',
      });
      const ofx = buildBankOfx(ofxBankFor('20260401', 10000, 'ENEL DISTRIBUICAO', 'SL1'));
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const tx = result.preview.find((t: any) => t.amountCents > 0);
      expect(tx?.categoriaFonte).toBeNull();
    });

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
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);

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
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);

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
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
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
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const tx = result.preview.find((t: any) => t.amountCents > 0);
      expect(tx?.crossProjectMatches?.[0]?.kind).toBe('expense');
      expect((tx?.crossProjectMatches?.[0] as any)?.valorCents).toBe(666666);
      expect((tx?.crossProjectMatches?.[0] as any)?.installmentCurrent).toBe(1);
      expect((tx?.crossProjectMatches?.[0] as any)?.installmentTotal).toBe(3);
    });

    it('usa override em PARCELADO 1x e mantém fallback para A_VISTA', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'casa1', name: 'Casa', type: 'CASA' },
      ]);
      prisma.expense.findMany.mockResolvedValue(plannedMatcherExpenses('PARCELADO'));

      const ofx = buildBankOfx(ofxBankFor('20260429', 50000, 'COMPRA CASA', 'OVERRIDE1'));
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const matches = result.preview.find((tx: any) => tx.amountCents > 0)?.crossProjectMatches ?? [];

      expect(matches.find((match: any) => match.expenseId === 'exp-override')).toMatchObject({
        data: '2026-04-29',
        installmentCurrent: 1,
        installmentTotal: 1,
      });
      expect(matches.find((match: any) => match.expenseId === 'exp-avista')).toMatchObject({
        data: '2026-04-28',
        installmentCurrent: null,
        installmentTotal: null,
      });
    });
  });

  describe('previewImport — warning: fatura de cartão importada como extrato (Bug A)', () => {
    it('cabeçalho Nubank "date,title,amount" dispara warning looks_like_card_invoice', async () => {
      const csv = ['date,title,amount', '2026-05-12,IFOOD RESTAURANTE,89.90', '2026-05-13,UBER,32.50'].join('\n');
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(csv), 'fatura.csv', 'CSV_GENERIC', undefined, TEST_OWNER_REQUESTER);
      expect(result.warning?.code).toBe('looks_like_card_invoice');
    });

    it('"Parcela N/M" na descrição dispara warning mesmo sem o cabeçalho Nubank', async () => {
      const csv = ['data;descricao;valor', '12/05/2026;LOJA XYZ PARC 2/4;250,00'].join('\n');
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(csv), 'fatura.csv', 'CSV_GENERIC', undefined, TEST_OWNER_REQUESTER);
      expect(result.warning?.code).toBe('looks_like_card_invoice');
    });

    it('>90% das linhas viram recebimento dispara warning (cobre extrato Bradesco/BB/Caixa tudo positivo)', async () => {
      // Cabeçalho Itaú (não dispara pelo critério de header) com 10 despesas na fatura,
      // que ao inverter para extrato viram 10 recebimentos (100% > 90%).
      const csvItau = [
        'data;descricao;valor',
        ...Array.from({ length: 10 }, (_, i) => `${10 + i}/05/2026;COMPRA ${i};50,00`),
      ].join('\n');
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(csvItau), 'extrato.csv', 'CSV_GENERIC', undefined, TEST_OWNER_REQUESTER);
      expect(result.totalCredits).toBe(10);
      expect(result.warning?.code).toBe('looks_like_card_invoice');
    });

    it('extrato bancário normal (débitos e créditos misturados, sem parcela) NÃO dispara warning', async () => {
      const ofx = buildBankOfx(
        ofxBankFor('20260401', 10000, 'MERCADO', 'B1'),
        ofxBankFor('20260402', -50000, 'SALARIO', 'B2'),
        ofxBankFor('20260403', 5000, 'FARMACIA', 'B3'),
      );
      const result = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('commitImport — decisions', () => {
    it('decision.skip ignora transação (não cria expense)', async () => {
      const ofx = buildBankOfx(
        ofxBankFor('20260401', 10000, 'LOJA SKIP', 'SK1'),
        ofxBankFor('20260402', 20000, 'LOJA OK', 'OK1'),
      );
      const preview = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const skipTx = preview.preview.find((t: any) => /SKIP/.test(t.merchant));
      const okTx = preview.preview.find((t: any) => /OK/.test(t.merchant));
      expect(skipTx).toBeDefined();
      expect(okTx).toBeDefined();

      prisma.expense.create.mockClear();
      const res = await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(ofx), 'ext.ofx', 'OFX',
        undefined, undefined,
        [{ externalId: skipTx!.externalId, action: 'skip' }], null, TEST_OWNER_REQUESTER
      );

      expect(res.skipped).toBe(1);
      // Apenas 1 expense criada (OK)
      const createdCalls = prisma.expense.create.mock.calls;
      expect(createdCalls.length).toBe(1);
      expect(createdCalls[0][0].data.fornecedor).toContain('LOJA OK');
    });

    it('decision.overrides aplica titulo, valor e categoria', async () => {
      const ofx = buildBankOfx(ofxBankFor('20260401', 10000, 'LOJA X', 'OV1'));
      const preview = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const ext = preview.preview[0].externalId;

      prisma.expense.create.mockClear();
      await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(ofx), 'ext.ofx', 'OFX',
        undefined, undefined,
        [{
          externalId: ext,
          overrides: { titulo: 'Aluguel Maio', valorCents: 150000, category: 'MORADIA' },
        }], null, TEST_OWNER_REQUESTER
      );

      const call = prisma.expense.create.mock.calls[0][0];
      expect(call.data.fornecedor).toBe('Aluguel Maio');
      expect(call.data.valor).toBe(150000);
      expect(call.data.tipoDespesa).toBe('MORADIA');
    });

    it('repassa createdByUserId para a Expense criada (KPI "despesas criadas" depende disso)', async () => {
      const ofx = buildBankOfx(ofxBankFor('20260401', 10000, 'LOJA CREATEDBY', 'CB1'));
      await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);

      prisma.expense.create.mockClear();
      await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(ofx), 'ext.ofx', 'OFX',
        undefined, undefined, undefined,
        'user-abc', TEST_OWNER_REQUESTER
      );

      expect(prisma.expense.create).toHaveBeenCalledTimes(1);
      expect(prisma.expense.create.mock.calls[0][0].data.createdByUserId).toBe('user-abc');
    });
  });

  // Bug real (jul/2026): "FATURA PAGA Itaú Personn" de R$ 17.655,85 entrou com
  // cardLast4 null porque nenhuma heurística achou o cartão. Sem cardLast4 o
  // pagamento sai do caixa (§10) mas getAccountView não o reconhece como
  // quitação — a fatura fica em aberto e o mesmo dinheiro conta 2×.
  describe('commitImport — pagamento de fatura sem cartão identificado', () => {
    const faturaOfx = buildBankOfx(
      ofxBankFor('20260721', 1765585, 'FATURA PAGA Itau Personn', 'FP1'),
    );

    it('sem cartão identificado, marca unlinkedCardPayment em vez de dizer que vinculou', async () => {
      prisma.expense.create.mockClear();
      const res = await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(faturaOfx), 'ext.ofx', 'OFX', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER
      );

      const created = prisma.expense.create.mock.calls[0][0].data;
      expect(created.tipoDespesa).toBe('PAGAMENTO_FATURA_CARTAO');
      expect(created.cardLast4).toBeNull();
      expect(res.cardPayments).toBe(0);
      expect(res.unlinkedCardPayments).toBe(1);
    });

    it('decision.overrides.cardLast4 grava o cartão escolhido e liquida a fatura', async () => {
      prisma.creditCard.findFirst.mockResolvedValue({
        id: 'card5572', last4: '5572', nickname: 'Visa ****5572',
        project: { id: 'pessoal1', type: 'PESSOAL', tenantId: 't1', deletedAt: null },
      });
      prisma.creditCard.findMany.mockResolvedValue([
        {
          id: 'card5572',
          projectId: 'pessoal1',
          last4: '5572',
          nickname: 'Visa ****5572',
          brand: 'Visa',
          closingDay: null,
          dueDay: 5,
        },
      ]);
      prisma.creditCard.findUnique.mockResolvedValue({
        id: 'card5572', last4: '5572', closingDay: null, dueDay: 5,
      });
      const settleSpy = jest
        .spyOn(settlement, 'applyPreparedSettlement')
        .mockResolvedValue({ settledExpenses: 3, settledParcelas: 3 });

      prisma.expense.create.mockClear();
      const preview = await service.previewImport(
        't1', 'pessoal1', 'acc1', Buffer.from(faturaOfx), 'ext.ofx', 'OFX',
        undefined, TEST_OWNER_REQUESTER,
      );
      const ext = preview.preview[0].externalId;

      const res = await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(faturaOfx), 'ext.ofx', 'OFX',
        undefined, undefined,
        [{ externalId: ext, overrides: { cardLast4: '5572' } }], null, TEST_OWNER_REQUESTER
      );

      const created = prisma.expense.create.mock.calls[0][0].data;
      expect(created.tipoDespesa).toBe('PAGAMENTO_FATURA_CARTAO');
      expect(created.cardLast4).toBe('5572');
      expect(res.cardPayments).toBe(1);
      expect(res.unlinkedCardPayments).toBe(0);
      expect(settleSpy).toHaveBeenCalled();
    });
  });

  describe('commitImport — transferências bancárias', () => {
    it('crédito "CREDITO LIBERAD PIX" vira recebimento de transferência própria', async () => {
      const ofx = buildBankOfx(ofxBankFor('20260720', -350000, 'CREDITO LIBERAD PIX 6933', 'TRF1'));

      prisma.receipt.create.mockClear();
      await service.commitImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);

      const created = prisma.receipt.create.mock.calls[0][0].data;
      expect(created.tipo).toBe('TRANSFERENCIA_PROPRIA');
    });

    it('débito "PIX CARTAO" vira transferência TED', async () => {
      const ofx = buildBankOfx(ofxBankFor('20260720', 350000, 'PIX CARTAO ALESSAN18/07', 'TRF2'));

      prisma.expense.create.mockClear();
      await service.commitImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);

      const created = prisma.expense.create.mock.calls[0][0].data;
      expect(created.tipoDespesa).toBe('TRANSFERENCIA_TED');
    });

    // TODO: aguardando decisão do PO sobre distinguir transferência entre contas
    // próprias cadastradas de resgate de aplicação/investimento NÃO cadastrada
    // (issue #574). Documenta o comportamento ATUAL (bug), não o esperado — a
    // perna de débito (aplicação) não gera CashFlowEntry, mas a perna de crédito
    // (resgate) gera uma normalmente, então uma transferência interna simétrica
    // (líquido zero) hoje aparece como +R$1.000,00 de entrada real no fluxo de
    // caixa consolidado.
    it('RED (#574): transferência interna simétrica (aplicação R$1.000 + resgate R$1.000) infla o saldo em vez de líquido zero', async () => {
      const ofx = buildBankOfx(
        ofxBankFor('20260720', 100000, 'APLICACAO PROGRAMADA', 'APL1'),
        ofxBankFor('20260721', -100000, 'RESGATE APLICACAO', 'RESG1'),
      );

      prisma.cashFlowEntry.create.mockClear();
      prisma.expense.create.mockClear();
      prisma.receipt.create.mockClear();
      await service.commitImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);

      // As duas pernas foram de fato classificadas como MOVIMENTACAO_INTERNA / resgate.
      expect(prisma.expense.create.mock.calls[0][0].data.tipoDespesa).toBe('MOVIMENTACAO_INTERNA');
      expect(prisma.receipt.create.mock.calls[0][0].data.tipo).toBe('RESGATE');

      const cashFlowCreates = prisma.cashFlowEntry.create.mock.calls.map((c: any) => c[0].data);
      const netCashFlow = cashFlowCreates.reduce(
        (sum: number, e: any) => sum + (e.tipo === 'RECEBIMENTO' ? e.valor : -e.valor),
        0,
      );

      // Comportamento HOJE (bug): só a perna de crédito gera CashFlowEntry.
      // Uma transferência interna verdadeira deveria ter líquido 0, não +100000
      // (R$1.000,00) de "entrada" fantasma no consolidado.
      expect(cashFlowCreates.length).toBe(1);
      expect(netCashFlow).toBe(100000);
    });

    it('#574 fix: reclassificar MOVIMENTACAO_INTERNA com conta de destino CADASTRADA zera o líquido (soma-zero real)', async () => {
      const ofx = buildBankOfx(
        ofxBankFor('20260720', 100000, 'APLICACAO PROGRAMADA', 'APL2'),
        ofxBankFor('20260721', -100000, 'RESGATE APLICACAO', 'RESG2'),
      );
      const preview = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const debitExt = preview.preview.find((t: any) => /APLICACAO PROGRAMADA/.test(t.merchant))!.externalId;
      const creditExt = preview.preview.find((t: any) => /RESGATE APLICACAO/.test(t.merchant))!.externalId;

      prisma.bankAccount.findMany.mockResolvedValue([{ id: 'acc-destino' }]);
      prisma.cashFlowEntry.create.mockClear();
      prisma.expense.create.mockClear();
      prisma.receipt.create.mockClear();

      await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(ofx), 'ext.ofx', 'OFX',
        undefined, undefined,
        [
          { externalId: debitExt, overrides: { category: 'MOVIMENTACAO_INTERNA', transferToAccountId: 'acc-destino' } },
          { externalId: creditExt, overrides: { category: 'MOVIMENTACAO_INTERNA', transferToAccountId: 'acc-destino' } },
        ],
        null, TEST_OWNER_REQUESTER,
      );

      expect(prisma.expense.create.mock.calls[0][0].data.tipoDespesa).toBe('MOVIMENTACAO_INTERNA');
      expect(prisma.receipt.create.mock.calls[0][0].data.tipo).toBe('RESGATE');
      // Nenhuma CashFlowEntry gerada por nenhuma das duas pernas — soma-zero real.
      expect(prisma.cashFlowEntry.create).not.toHaveBeenCalled();
    });

    it('#574: reclassificar MOVIMENTACAO_INTERNA confirmando explicitamente "não é conta minha" (transferToAccountId: null) mantém o comportamento atual (não zera)', async () => {
      const ofx = buildBankOfx(ofxBankFor('20260721', -100000, 'RESGATE APLICACAO', 'RESG3'));
      const preview = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const ext = preview.preview[0].externalId;

      prisma.cashFlowEntry.create.mockClear();
      prisma.receipt.create.mockClear();

      await service.commitImport(
        't1', 'pessoal1', 'acc1',
        Buffer.from(ofx), 'ext.ofx', 'OFX',
        undefined, undefined,
        [{ externalId: ext, overrides: { category: 'MOVIMENTACAO_INTERNA', transferToAccountId: null } }],
        null, TEST_OWNER_REQUESTER,
      );

      expect(prisma.receipt.create.mock.calls[0][0].data.tipo).toBe('RESGATE');
      expect(prisma.cashFlowEntry.create).toHaveBeenCalledTimes(1);
      expect(prisma.cashFlowEntry.create.mock.calls[0][0].data.valor).toBe(100000);
    });

    it('#574: reclassificar MOVIMENTACAO_INTERNA SEM decidir a conta de destino (chave ausente) é rejeitado ANTES de qualquer escrita', async () => {
      const ofx = buildBankOfx(ofxBankFor('20260721', -100000, 'RESGATE APLICACAO', 'RESG4'));
      const preview = await service.previewImport('t1', 'pessoal1', 'acc1', Buffer.from(ofx), 'ext.ofx', 'OFX', undefined, TEST_OWNER_REQUESTER);
      const ext = preview.preview[0].externalId;

      prisma.receipt.create.mockClear();
      prisma.cashFlowEntry.create.mockClear();

      await expect(
        service.commitImport(
          't1', 'pessoal1', 'acc1',
          Buffer.from(ofx), 'ext.ofx', 'OFX',
          undefined, undefined,
          [{ externalId: ext, overrides: { category: 'MOVIMENTACAO_INTERNA' } }],
          null, TEST_OWNER_REQUESTER,
        ),
      ).rejects.toThrow();

      expect(prisma.receipt.create).not.toHaveBeenCalled();
      expect(prisma.cashFlowEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('linkToExpense', () => {
    it('liquida a parcela do alvo via Conciliação (reversível, não-destrutivo)', async () => {
      prisma.expense.findFirst.mockImplementation(({ where }: any) => {
        if (where.id === 'src1') {
          return Promise.resolve({
            id: 'src1', tenantId: 't1', projectId: 'pessoal1',
            bankLast4: '5678', valor: 50000, valorTotal: 50000,
            dataPagamento: new Date('2026-04-29'), dataInicioParcela: null,
            createdAt: new Date('2026-04-29'), linkedExpenseId: null,
          });

        }
        if (where.id === 'tgt1') {
          return Promise.resolve({
            id: 'tgt1', tenantId: 't1', projectId: 'casa1',
            tipoDespesa: 'METAL_CERAMICA', categoriaMaoDeObra: null, roomId: null,
            valorTotal: 50000, formaPagamento: 'A_VISTA', dataPagamento: null,
            quantidadeParcela: null, dataInicioParcela: new Date('2026-04-28'),
            status: 'PLANEJADO', paidParcelas: null, linkedExpenseId: null, room: null,
          });

        }
        return Promise.resolve(null);
      });
      prisma.crossProjectSettlement.findMany.mockResolvedValue([{ parcelaIndex: 0, realValor: 50000 }]);

      await expect(
        service.linkToExpense('t1', 'pessoal1', 'src1', 'tgt1', undefined, TEST_OWNER_REQUESTER),
      ).resolves.toEqual(
        expect.objectContaining({ ok: true, sourceId: 'src1', targetId: 'tgt1' }),
      );
      expect(prisma.crossProjectSettlement.upsert).toHaveBeenCalled();
    });
  });

  describe('commitImport — ACL somente do lote processável', () => {
    it('ignora links hidden duplicados/skip sem criar despesa ou recebimento', async () => {
      const ofx = buildBankOfx(
        ofxBankFor('20260429', 10000, 'DUP EXPENSE HIDDEN', 'DUP-EXP'),
        ofxBankFor('20260430', -20000, 'DUP RECEIPT HIDDEN', 'DUP-REC'),
        ofxBankFor('20260501', 30000, 'SKIP HIDDEN', 'SKIP-HIDDEN'),
      );
      const preview = await service.previewImport(
        't1',
        'pessoal1',
        'acc1',
        Buffer.from(ofx),
        'ext.ofx',
        'OFX',
        undefined,
        TEST_OWNER_REQUESTER,
      );
      const duplicateExpenseId = preview.preview.find((item: any) =>
        item.merchant.includes('DUP EXPENSE'),
      )!.externalId;
      const duplicateReceiptId = preview.preview.find((item: any) =>
        item.merchant.includes('DUP RECEIPT'),
      )!.externalId;
      const skippedId = preview.preview.find((item: any) =>
        item.merchant.includes('SKIP'),
      )!.externalId;
      prisma.$queryRaw.mockResolvedValue([
        { external_id: duplicateExpenseId },
        { external_id: duplicateReceiptId },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'hidden-expense',
          tenantId: 't1',
          projectId: 'hidden-project',
          project: { id: 'hidden-project', tenantId: 't1', type: 'REFORMA' },
        },
      ]);
      prisma.receipt.findMany.mockResolvedValue([
        {
          id: 'hidden-receipt',
          tenantId: 't1',
          projectId: 'hidden-project',
          project: { id: 'hidden-project', tenantId: 't1', type: 'REFORMA' },
        },
      ]);
      prisma.expense.create.mockClear();
      prisma.receipt.create.mockClear();

      await expect(
        service.commitImport(
          't1',
          'pessoal1',
          'acc1',
          Buffer.from(ofx),
          'ext.ofx',
          'OFX',
          undefined,
          undefined,
          [
            {
              externalId: duplicateExpenseId,
              action: 'link',
              linkToExpenseId: 'hidden-expense',
            },
            {
              externalId: duplicateReceiptId,
              action: 'link',
              linkToReceiptId: 'hidden-receipt',
            },
            {
              externalId: skippedId,
              action: 'skip',
              linkToExpenseId: 'hidden-expense',
            },
          ],
          null,
          RESTRICTED_IMPORT_REQUESTER,
        ),
      ).resolves.toEqual(expect.objectContaining({ inserted: 0 }));
      expect(prisma.expense.create).not.toHaveBeenCalled();
      expect(prisma.receipt.create).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'despesa',
        amount: 10000,
        decision: { linkToExpenseId: 'hidden-expense' },
      },
      {
        label: 'recebimento',
        amount: -10000,
        decision: { linkToReceiptId: 'hidden-receipt' },
      },
    ])('bloqueia link hidden processável de $label antes de writes', async ({ amount, decision }) => {
      const ofx = buildBankOfx(
        ofxBankFor('20260429', amount, 'PROCESSADA HIDDEN', 'PROC-HIDDEN'),
      );
      const preview = await service.previewImport(
        't1',
        'pessoal1',
        'acc1',
        Buffer.from(ofx),
        'ext.ofx',
        'OFX',
        undefined,
        TEST_OWNER_REQUESTER,
      );
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'hidden-expense',
          tenantId: 't1',
          projectId: 'hidden-project',
          project: { id: 'hidden-project', tenantId: 't1', type: 'REFORMA' },
        },
      ]);
      prisma.receipt.findMany.mockResolvedValue([
        {
          id: 'hidden-receipt',
          tenantId: 't1',
          projectId: 'hidden-project',
          project: { id: 'hidden-project', tenantId: 't1', type: 'REFORMA' },
        },
      ]);
      prisma.bankStatementImport.create.mockClear();
      prisma.expense.create.mockClear();
      prisma.receipt.create.mockClear();

      await expect(
        service.commitImport(
          't1',
          'pessoal1',
          'acc1',
          Buffer.from(ofx),
          'ext.ofx',
          'OFX',
          undefined,
          undefined,
          [
            {
              externalId: preview.preview[0].externalId,
              action: 'link',
              ...decision,
            },
          ],
          null,
          RESTRICTED_IMPORT_REQUESTER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.bankStatementImport.create).not.toHaveBeenCalled();
      expect(prisma.expense.create).not.toHaveBeenCalled();
      expect(prisma.receipt.create).not.toHaveBeenCalled();
    });
  });

  describe('suggestLinks', () => {
    it('usa override em QUINZENAL 1x e mantém fallback para A_VISTA', async () => {
      prisma.expense.findMany
        .mockResolvedValueOnce([
          {
            id: 'bank-expense',
            titulo: 'Compra importada',
            fornecedor: 'Loja',
            valorTotal: 50000,
            dataPagamento: new Date('2026-04-29'),
            dataInicioParcela: null,
            createdAt: new Date('2026-04-29'),
            status: 'PAGO',
            bankLast4: '5678',
            formaPagamento: 'A_VISTA',
            linkedExpenseId: null,
            tipoDespesa: 'OUTROS',
          },
        ])
        .mockResolvedValueOnce(plannedMatcherExpenses('QUINZENAL'));
      prisma.project.findMany.mockResolvedValue([
        { id: 'casa1', name: 'Casa', type: 'CASA' },
      ]);

      const [result] = await service.suggestLinks(
        't1',
        'pessoal1',
        'acc1',
        TEST_OWNER_REQUESTER,
      );

      expect(result.suggestions.find((suggestion: any) => suggestion.expenseId === 'exp-override')).toMatchObject({
        data: '2026-04-29T00:00:00.000Z',
        installmentCurrent: 1,
        installmentTotal: 1,
      });
      expect(result.suggestions.find((suggestion: any) => suggestion.expenseId === 'exp-avista')).toMatchObject({
        data: '2026-04-28T00:00:00.000Z',
        installmentCurrent: null,
        installmentTotal: null,
      });
    });
  });

  describe('TOCTOU race condition fix', () => {
    it('updateAccount throws NotFoundException when account scope changes between check and write', async () => {
      // Simulate race condition: findAccount passes validation, but between
      // validation and update, the account is deleted or moved to another tenant/project.
      // The updateMany inside the transaction returns count === 0.
      prisma.bankAccount.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.updateAccount('t1', 'pessoal1', 'acc1', { nickname: 'Updated' }),
      ).rejects.toThrow('Conta bancária não encontrada ou foi modificada');

      // Verify that updateMany was called with complete scope (not just id)
      expect(prisma.bankAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'acc1',
            tenantId: 't1',
            projectId: 'pessoal1',
            deletedAt: null,
          }),
        }),
      );
    });

    it('updateAccount succeeds when updateMany returns count === 1', async () => {
      prisma.bankAccount.updateMany.mockResolvedValueOnce({ count: 1 });
      // The second findFirst call (in the return statement) will use the default mock
      prisma.bankAccount.findFirst.mockResolvedValueOnce({
        id: 'acc1',
        tenantId: 't1',
        projectId: 'pessoal1',
        institution: 'Itau',
        last4: '5678',
        nickname: 'Updated Nickname',
      });

      const result = await service.updateAccount('t1', 'pessoal1', 'acc1', { nickname: 'Updated Nickname' });

      expect(result).toBeDefined();
      expect(result.id).toBe('acc1');
      expect(prisma.bankAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'acc1',
            tenantId: 't1',
            projectId: 'pessoal1',
            deletedAt: null,
          }),
        }),
      );
    });

    it('deleteAccount throws NotFoundException when account scope changes between check and delete', async () => {
      // Simulate race condition: findAccount passes validation, but between
      // validation and delete, the account is deleted or moved to another tenant/project.
      // The deleteMany returns count === 0.
      prisma.bankAccount.deleteMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.deleteAccount('t1', 'pessoal1', 'acc1'),
      ).rejects.toThrow('Conta bancária não encontrada ou foi modificada');

      // Verify that deleteMany was called with complete scope (not just id)
      expect(prisma.bankAccount.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'acc1',
            tenantId: 't1',
            projectId: 'pessoal1',
            deletedAt: null,
          }),
        }),
      );
    });

    it('deleteAccount succeeds when deleteMany returns count === 1', async () => {
      prisma.bankAccount.deleteMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.deleteAccount('t1', 'pessoal1', 'acc1');

      expect(result).toEqual({ ok: true });
      expect(prisma.bankAccount.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'acc1',
            tenantId: 't1',
            projectId: 'pessoal1',
            deletedAt: null,
          }),
        }),
      );
    });
  });
});
