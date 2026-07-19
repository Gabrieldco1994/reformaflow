import { Test, TestingModule } from '@nestjs/testing';
import { CreditCardService } from './credit-card.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';

function makePrismaMock() {
  return {
    project: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    creditCard: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
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
      providers: [
        CreditCardService,
        ConciliacaoService,
        { provide: PrismaService, useValue: prisma },
      ],
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
      limitTotalCents: 100000,
      limitAvailableCents: null,
      closingDay: 10,
      dueDay: 25,
    });

    // $transaction com callback ou array
    prisma.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    });
  });

  describe('listCards — uso de limite', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-20T12:00:00.000Z'));
      prisma.project.findFirst.mockResolvedValue({ id: 'pessoal1', tenantId: 't1' });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('calcula usado no ciclo aberto atual e ignora despesas neutras', async () => {
      prisma.creditCard.findMany.mockResolvedValue([
        {
          id: 'card1',
          tenantId: 't1',
          projectId: 'pessoal1',
          brand: 'MASTERCARD',
          last4: '1234',
          nickname: 'MC Black',
          institution: 'Itau',
          limitTotalCents: 100000,
          limitAvailableCents: null,
          closingDay: 10,
          dueDay: 25,
          createdAt: new Date('2026-01-01'),
        },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          valorTotal: 30000,
          tipoDespesa: 'ALIMENTACAO',
          dataPagamento: new Date('2026-06-05T00:00:00.000Z'),
          dataInicioParcela: null,
          createdAt: new Date('2026-06-05T00:00:00.000Z'),
        },
        {
          valorTotal: 90000,
          tipoDespesa: 'OUTROS',
          dataPagamento: new Date('2026-06-10T00:00:00.000Z'),
          dataInicioParcela: null,
          createdAt: new Date('2026-06-10T00:00:00.000Z'),
        },
        {
          valorTotal: 10000,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          dataPagamento: new Date('2026-06-03T00:00:00.000Z'),
          dataInicioParcela: null,
          createdAt: new Date('2026-06-03T00:00:00.000Z'),
        },
      ]);

      const result = await service.listCards('t1', 'pessoal1');

      expect(prisma.expense.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 't1',
          projectId: 'pessoal1',
          cardLast4: '1234',
          deletedAt: null,
          tipoDespesa: { notIn: expect.arrayContaining(['PAGAMENTO_FATURA_CARTAO']) },
        }),
      }));
      expect(result[0]).toMatchObject({
        limitUsedCents: 30000,
        limitAvailableComputedCents: 70000,
        limitUsagePercent: 30,
        currentOpenInvoiceMonth: '2026-06',
      });
    });

    it('usa o próximo vencimento quando o vencimento deste mês já passou', async () => {
      prisma.creditCard.findMany.mockResolvedValue([
        {
          id: 'card1',
          tenantId: 't1',
          projectId: 'pessoal1',
          brand: 'MASTERCARD',
          last4: '1234',
          nickname: 'MC Black',
          institution: 'Itau',
          limitTotalCents: 100000,
          limitAvailableCents: null,
          closingDay: 10,
          dueDay: 15,
          createdAt: new Date('2026-01-01'),
        },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        {
          valorTotal: 45000,
          tipoDespesa: 'OUTROS',
          dataPagamento: new Date('2026-06-10T00:00:00.000Z'),
          dataInicioParcela: null,
          createdAt: new Date('2026-06-10T00:00:00.000Z'),
        },
        {
          valorTotal: 25000,
          tipoDespesa: 'OUTROS',
          dataPagamento: new Date('2026-06-05T00:00:00.000Z'),
          dataInicioParcela: null,
          createdAt: new Date('2026-06-05T00:00:00.000Z'),
        },
      ]);

      const result = await service.listCards('t1', 'pessoal1');

      expect(result[0]).toMatchObject({
        limitUsedCents: 45000,
        limitAvailableComputedCents: 55000,
        limitUsagePercent: 45,
        currentOpenInvoiceMonth: '2026-07',
      });
    });

    it('não consulta uso quando o cartão não tem limite total', async () => {
      prisma.creditCard.findMany.mockResolvedValue([
        {
          id: 'card1',
          tenantId: 't1',
          projectId: 'pessoal1',
          brand: 'MASTERCARD',
          last4: '1234',
          nickname: 'MC Black',
          institution: 'Itau',
          limitTotalCents: null,
          limitAvailableCents: null,
          closingDay: 10,
          dueDay: 25,
          createdAt: new Date('2026-01-01'),
        },
      ]);

      const result = await service.listCards('t1', 'pessoal1');

      expect(prisma.expense.findMany).not.toHaveBeenCalled();
      expect(result[0]).not.toHaveProperty('limitUsedCents');
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
      expect(result.preview[0].crossProjectMatches?.[0]?.installmentCurrent).toBe(1);
      expect(result.preview[0].crossProjectMatches?.[0]?.installmentTotal).toBe(3);
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

    it('parcelada: valorTotal = parcela × nº parcelas; cada cashflow = valor da parcela', async () => {
      // Fatura: "SANTIL 1/6" valendo R$ 484,89 por parcela.
      // Regressão: o sistema NÃO deve dividir 484,89 por 6 (bug do R$ 80).
      const ofx = buildOfx(ofxFor('20260610', 484.89, 'SANTIL ELETRO 1/6', 'PARC1'));
      prisma.expense.findFirst.mockResolvedValue(null);
      prisma.expense.create.mockClear();
      prisma.cashFlowEntry.create.mockClear();

      await service.commitImport(
        't1', 'pessoal1', 'card1',
        Buffer.from(ofx), 'f.ofx', 'OFX',
      );

      const created = prisma.expense.create.mock.calls[0][0];
      expect(created.data.formaPagamento).toBe('PARCELADO');
      expect(created.data.quantidadeParcela).toBe(6);
      // total = 484,89 × 6 = 2.909,34 (em centavos)
      expect(created.data.valorTotal).toBe(48489 * 6);
      expect(created.data.valor).toBe(48489 * 6);

      // 6 cashFlowEntries, cada um com o valor da PARCELA (484,89), não o total.
      const cfCalls = prisma.cashFlowEntry.create.mock.calls;
      expect(cfCalls).toHaveLength(6);
      for (const [arg] of cfCalls) {
        expect(arg.data.valor).toBe(48489);
      }
      const somaParcelas = cfCalls.reduce((s: number, [arg]: [any]) => s + arg.data.valor, 0);
      expect(somaParcelas).toBe(created.data.valorTotal);
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

    it('decision.link liquida a parcela do alvo via Conciliação (não sobrescreve)', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA Y', 'LK1'));
      // findFirst resolve por id: fonte (PESSOAL) e alvo (REFORMA)
      prisma.expense.findFirst.mockImplementation(({ where }: any) => {
        if (where.id === 'src1') {
          return Promise.resolve({
            id: 'src1', tenantId: 't1', projectId: 'pessoal1',
            cardLast4: '1234', valor: 10000, valorTotal: 10000,
            dataPagamento: new Date('2026-04-29'), dataInicioParcela: null,
            createdAt: new Date(), linkedExpenseId: null,
          });
        }
        if (where.id === 'tgt1') {
          return Promise.resolve({
            id: 'tgt1', tenantId: 't1', projectId: 'reforma1',
            tipoDespesa: 'METAL_CERAMICA', categoriaMaoDeObra: null, roomId: null,
            valorTotal: 10000, formaPagamento: 'A_VISTA', dataPagamento: null,
            quantidadeParcela: null, dataInicioParcela: new Date('2026-04-28'),
            status: 'PLANEJADO', paidParcelas: null, linkedExpenseId: null, room: null,
          });
        }
        return Promise.resolve(null);
      });
      // regen lê as liquidações do alvo
      prisma.crossProjectSettlement.findMany.mockResolvedValue([{ parcelaIndex: 0, realValor: 10000 }]);

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
      // núcleo: guardou snapshot do planejado (não sobrescreveu o alvo)
      expect(prisma.crossProjectSettlement.upsert).toHaveBeenCalled();
      const upsertArg = prisma.crossProjectSettlement.upsert.mock.calls[0][0];
      expect(upsertArg.create.plannedValor).toBe(10000);
      expect(upsertArg.create.realValor).toBe(10000);
    });

    it('decision.link funciona com alvo parcelado (liquida só a parcela atual)', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA Z', 'LK2'));
      prisma.expense.findFirst.mockImplementation(({ where }: any) => {
        if (where.id === 'src2') {
          return Promise.resolve({
            id: 'src2', tenantId: 't1', projectId: 'pessoal1',
            cardLast4: '1234', valor: 10000, valorTotal: 10000,
            dataPagamento: new Date('2026-04-29'), dataInicioParcela: null,
            createdAt: new Date(), linkedExpenseId: null,
          });
        }
        if (where.id === 'tgt2') {
          return Promise.resolve({
            id: 'tgt2', tenantId: 't1', projectId: 'casa1',
            tipoDespesa: 'METAL_CERAMICA', categoriaMaoDeObra: null, roomId: null,
            valorTotal: 30000, formaPagamento: 'PARCELADO', dataPagamento: null,
            quantidadeParcela: 3, dataInicioParcela: new Date('2026-04-29'),
            status: 'PLANEJADO', paidParcelas: null, linkedExpenseId: null, room: null,
          });
        }
        return Promise.resolve(null);
      });
      prisma.crossProjectSettlement.findMany.mockResolvedValue([{ parcelaIndex: 0, realValor: 10000 }]);

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
      // alvo NÃO fechado por inteiro: parcela 0 paga, 2 abertas
      const targetUpdate = prisma.expense.update.mock.calls.find((c: any[]) => c[0].where.id === 'tgt2');
      expect(targetUpdate[0].data.status).toBe('PLANEJADO');
      expect(targetUpdate[0].data.paidParcelas).toBe('[0]');
    });

    it('repassa createdByUserId para a Expense criada (KPI "despesas criadas" depende disso)', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA CREATEDBY', 'CB1'));
      prisma.expense.findFirst.mockResolvedValue(null);
      const preview = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      expect(preview.preview.length).toBe(1);

      prisma.expense.create.mockClear();
      await service.commitImport(
        't1', 'pessoal1', 'card1',
        Buffer.from(ofx), 'f.ofx', 'OFX',
        undefined, undefined, undefined,
        'user-abc',
      );

      expect(prisma.expense.create).toHaveBeenCalledTimes(1);
      const createdCall = prisma.expense.create.mock.calls[0][0];
      expect(createdCall.data.createdByUserId).toBe('user-abc');
    });

    it('sem createdByUserId, grava null explicitamente (não deixa undefined)', async () => {
      const ofx = buildOfx(ofxFor('20260429', 100, 'LOJA SEM USER', 'CB2'));
      prisma.expense.findFirst.mockResolvedValue(null);
      const preview = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      expect(preview.preview.length).toBe(1);

      prisma.expense.create.mockClear();
      await service.commitImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');

      const createdCall = prisma.expense.create.mock.calls[0][0];
      expect(createdCall.data.createdByUserId).toBeNull();
    });
  });
});
