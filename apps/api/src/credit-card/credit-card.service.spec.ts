import { Test, TestingModule } from '@nestjs/testing';
import { CreditCardService } from './credit-card.service';
import { PrismaService } from '../prisma/prisma.service';

function makePrismaMock() {
  return {
    project: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    creditCard: { findFirst: jest.fn() },
    creditCardStatementImport: {
      create: jest.fn().mockResolvedValue({ id: 'imp1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    creditCardTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
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
    cashFlowEntry: {
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  } as any;
}

function ofxFor(date: string, amountReais: number, memo: string, fitid: string) {
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

describe('CreditCardService', () => {
  let service: CreditCardService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [CreditCardService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(CreditCardService);

    prisma.creditCard.findFirst.mockResolvedValue({
      id: 'card1',
      tenantId: 't1',
      projectId: 'pessoal1',
      brand: 'MASTERCARD',
      last4: '1234',
      nickname: 'MC Black',
      institution: 'Itau',
    });

    // $transaction com callback ou array
    prisma.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    });
  });

  describe('previewImport — cross-project matches', () => {
    it('retorna crossProjectMatches para despesas planejadas em outros projetos', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'reforma1', name: 'Reforma Casa', type: 'REFORMA' },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'exp1',
          projectId: 'reforma1',
          titulo: 'POLO MARMORESS',
          fornecedor: null,
          valorTotal: 215834,
          formaPagamento: 'A_VISTA',
          quantidadeParcela: null,
          dataInicioParcela: new Date('2026-04-28'),
          dataPagamento: null,
          createdAt: new Date('2026-04-01'),
        },
      ]);

      const ofx = buildOfx(ofxFor('20260429', 2158.34, 'POLO MARMORESS', 'X1'));
      const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'fatura.ofx', 'OFX');

      expect(result.preview).toHaveLength(1);
      expect(result.preview[0].crossProjectMatches).toHaveLength(1);
      const m = result.preview[0].crossProjectMatches[0];
      expect(m.expenseId).toBe('exp1');
      expect(m.projectName).toBe('Reforma Casa');
      expect(m.valorCents).toBe(215834);
      expect(m.deltaCents).toBe(0);
    });

    it('não retorna match quando valor diverge mais que 5%', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'reforma1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'exp1',
          projectId: 'reforma1',
          titulo: 'POLO',
          fornecedor: null,
          valorTotal: 100000,
          formaPagamento: 'A_VISTA',
          quantidadeParcela: null,
          dataInicioParcela: new Date('2026-04-28'),
          dataPagamento: null,
          createdAt: new Date('2026-04-01'),
        },
      ]);
      const ofx = buildOfx(ofxFor('20260429', 2000, 'POLO', 'X2'));
      const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'fatura.ofx', 'OFX');
      expect(result.preview[0].crossProjectMatches).toHaveLength(0);
    });

    it('não retorna match quando data está fora da janela ±10 dias', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'reforma1', name: 'Reforma', type: 'REFORMA' },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          id: 'exp1',
          projectId: 'reforma1',
          titulo: 'POLO',
          fornecedor: null,
          valorTotal: 215834,
          formaPagamento: 'A_VISTA',
          quantidadeParcela: null,
          dataInicioParcela: new Date('2026-01-01'),
          dataPagamento: null,
          createdAt: new Date('2026-01-01'),
        },
      ]);
      const ofx = buildOfx(ofxFor('20260429', 2158.34, 'POLO', 'X3'));
      const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'fatura.ofx', 'OFX');
      expect(result.preview[0].crossProjectMatches).toHaveLength(0);
    });

    it('retorna futureInstallments como array (vazio para OFX)', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA', 'X4'));
      const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      expect(Array.isArray(result.futureInstallments)).toBe(true);
    });

    it('faz match por valor de parcela para despesas parceladas de outro projeto', async () => {
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

      const ofx = buildOfx(ofxFor('20260429', 6666.66, 'INFRA', 'PX1'));
      const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'fatura.ofx', 'OFX');
      expect(result.preview[0].crossProjectMatches).toHaveLength(1);
      expect(result.preview[0].crossProjectMatches?.[0]?.valorCents).toBe(666666);
    });

    it('marca como duplicate quando externalId já existe no projeto', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA', 'X5'));
      // 1ª chamada: parsed.transactions[].externalId  (findExistingExternalIds)
      // 2ª chamada: expense.findMany para cross-project (vazio)
      prisma.expense.findMany
        .mockResolvedValueOnce([{ externalId: 'dummy' }]) // será substituído
        .mockResolvedValueOnce([]);
      // Mais simples: stub findExistingExternalIds via prisma.expense.findMany
      // retornando o externalId real. Para isso, precisamos saber o ID. Simplifica:
      // mocka pra qualquer chamada retornar [].
      prisma.expense.findMany.mockReset();
      // 1ª call → existing IDs (with select externalId)
      prisma.expense.findMany.mockImplementation(async (args: any) => {
        if (args?.select?.externalId) {
          // retorna o primeiro externalId que o parser gerou
          return [{ externalId: args.where.externalId.in[0] }];
        }
        return [];
      });
      const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      expect(result.duplicated).toBe(1);
      expect(result.preview[0].duplicate).toBe(true);
    });
  });

  describe('commitImport — decisions', () => {
    it('decision.skip ignora a transação (não cria expense)', async () => {
      const ofx = buildOfx(
        ofxFor('20260429', 100, 'LOJA SKIP', 'SK1'),
        ofxFor('20260430', 200, 'LOJA OK', 'OK1'),
      );
      // mock findFirst (settlement check) → não há expense existente
      prisma.expense.findFirst.mockResolvedValue(null);

      // Captura os externalIds gerados pelo parser
      let skipId = '';
      let okId = '';
      const origPreview = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      const lojaSkip = origPreview.preview.find((t) => t.merchant === 'LOJA SKIP');
      const lojaOk = origPreview.preview.find((t) => t.merchant === 'LOJA OK');
      skipId = lojaSkip!.externalId;
      okId = lojaOk!.externalId;

      prisma.expense.create.mockClear();
      const res = await service.commitImport(
        't1', 'pessoal1', 'card1',
        Buffer.from(ofx), 'f.ofx', 'OFX',
        undefined, undefined,
        [{ externalId: skipId, action: 'skip' }],
      );

      expect(res.inserted).toBe(1);
      expect(res.skipped).toBe(1);
      expect(prisma.expense.create).toHaveBeenCalledTimes(1);
      const createdCall = prisma.expense.create.mock.calls[0][0];
      expect(createdCall.data.titulo).toContain('LOJA OK');
    });

    it('decision.overrides aplica titulo, valor e categoria', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA X', 'OV1'));
      prisma.expense.findFirst.mockResolvedValue(null);
      const preview = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      const ext = preview.preview[0].externalId;

      prisma.expense.create.mockClear();
      await service.commitImport(
        't1', 'pessoal1', 'card1',
        Buffer.from(ofx), 'f.ofx', 'OFX',
        undefined, undefined,
        [{
          externalId: ext,
          overrides: { titulo: 'Custom Title', valorCents: 12345, category: 'INVESTIMENTOS' },
        }],
      );

      const call = prisma.expense.create.mock.calls[0][0];
      expect(call.data.titulo).toContain('Custom Title');
      expect(call.data.fornecedor).toBe('Custom Title');
      expect(call.data.valor).toBe(12345);
      expect(call.data.valorTotal).toBe(12345);
      expect(call.data.tipoDespesa).toBe('INVESTIMENTOS');
    });

    it('decision.link aciona linkToExpense após criar a despesa', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA Y', 'LK1'));
      prisma.expense.findFirst
        // 1ª: linkToExpense → source lookup (no projeto PESSOAL)
        .mockResolvedValueOnce({
          id: 'src1', tenantId: 't1', projectId: 'pessoal1',
          cardLast4: '1234', dataPagamento: new Date('2026-04-29'),
          dataInicioParcela: null, createdAt: new Date(), linkedExpenseId: null,
        })
        // 2ª: dentro da $transaction → target lookup
        .mockResolvedValueOnce({
          id: 'tgt1', tenantId: 't1', projectId: 'reforma1',
          status: 'PLANEJADO', dataPagamento: null, dataInicioParcela: new Date('2026-04-28'),
        });

      prisma.expense.create.mockResolvedValueOnce({ id: 'src1' });
      const preview = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      const ext = preview.preview[0].externalId;

      const res = await service.commitImport(
        't1', 'pessoal1', 'card1',
        Buffer.from(ofx), 'f.ofx', 'OFX',
        undefined, undefined,
        [{ externalId: ext, action: 'link', linkToExpenseId: 'tgt1' }],
      );

      expect(res.linked).toBe(1);
      expect(res.inserted).toBe(1);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('decision.link também atualiza alvo já PAGO (re-link)', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA Z', 'LK2'));
      prisma.expense.findFirst
        .mockResolvedValueOnce({
          id: 'src2', tenantId: 't1', projectId: 'pessoal1',
          cardLast4: '1234', dataPagamento: new Date('2026-04-29'),
          dataInicioParcela: null, createdAt: new Date(), linkedExpenseId: null,
        })
        .mockResolvedValueOnce({
          id: 'tgt2', tenantId: 't1', projectId: 'casa1',
          status: 'PAGO', dataPagamento: new Date('2026-04-10'), dataInicioParcela: null,
        });

      prisma.expense.create.mockResolvedValueOnce({ id: 'src2' });
      const preview = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      const ext = preview.preview[0].externalId;

      const res = await service.commitImport(
        't1', 'pessoal1', 'card1',
        Buffer.from(ofx), 'f.ofx', 'OFX',
        undefined, undefined,
        [{ externalId: ext, action: 'link', linkToExpenseId: 'tgt2' }],
      );

      expect(res.linked).toBe(1);
    });
  });
});
