import { TEST_OWNER_REQUESTER } from '../test-utils/acl-requester-test-helper';
import { Test, TestingModule } from '@nestjs/testing';
import * as XLSX from 'xlsx';
import { CreditCardService } from './credit-card.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { withAclRequester } from '../test-utils/acl-requester-test-helper';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
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

describe('CreditCardService', () => {
  let service: CreditCardService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let merchantClassifier: { manualExpenseType: jest.Mock };

  beforeEach(async () => {
    prisma = makePrismaMock();
    const projects = new Map([
      ['pessoal1', { id: 'pessoal1', tenantId: 't1', type: 'PESSOAL' }],
      ['reforma1', { id: 'reforma1', tenantId: 't1', type: 'REFORMA' }],
      ['casa1', { id: 'casa1', tenantId: 't1', type: 'CASA' }],
    ]);
    prisma.project.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.tenantId === 't1' && where.deletedAt === null
          ? projects.get(where.id) ?? null
          : null,
      ),
    );
    merchantClassifier = { manualExpenseType: jest.fn().mockResolvedValue(null) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditCardService,
        ConciliacaoService,
        { provide: PrismaService, useValue: prisma },
        { provide: MerchantClassifierService, useValue: merchantClassifier },
      ],
    }).compile();
    service = withAclRequester(module.get(CreditCardService), prisma);

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
    it('aplica regra manual no suggestedCategory e marca fonte regra', async () => {
      merchantClassifier.manualExpenseType.mockResolvedValue('ALIMENTACAO');
      const ofx = buildOfx(ofxFor('20260429', 100, 'PADARIA CENTRAL', 'RGX'));
      const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX');
      expect(result.preview[0].suggestedCategory).toBe('ALIMENTACAO');
      expect(result.preview[0].categoriaFonte).toBe('regra');
    });

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

    it('usa override em QUINZENAL 1x e mantém fallback para A_VISTA', async () => {
      prisma.project.findMany.mockResolvedValue([
        { id: 'casa1', name: 'Casa', type: 'CASA' },
      ]);
      prisma.expense.findMany.mockResolvedValue(plannedMatcherExpenses('QUINZENAL'));

      const ofx = buildOfx(ofxFor('20260429', 500, 'COMPRA CASA', 'OVERRIDE1'));
      const result = await service.previewImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'fatura.ofx', 'OFX');

      expect(result.preview[0].crossProjectMatches.find((match) => match.expenseId === 'exp-override')).toMatchObject({
        data: '2026-04-29',
        installmentCurrent: 1,
        installmentTotal: 1,
      });
      expect(result.preview[0].crossProjectMatches.find((match) => match.expenseId === 'exp-avista')).toMatchObject({
        data: '2026-04-28',
        installmentCurrent: null,
        installmentTotal: null,
      });
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
        Buffer.from(ofx), 'f.ofx', 'OFX', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER
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

    it('meio de série: só as parcelas RESTANTES entram (valorTotal = parcela × restantes)', async () => {
      // Fatura Itaú lista "Parcela 2 de 10" — as parcelas 1..1 já foram cobradas
      // em faturas anteriores e já estão no sistema. Importar a série INTEIRA
      // (×10) inventa dinheiro: a despesa passa a valer mais do que os
      // cashFlowEntries que ela realmente gera, e a fatura infla.
      const ofx = buildOfx(ofxFor('20260622', 228.61, 'PG OBRAMAX 2/10', 'MID1'));
      prisma.expense.findFirst.mockResolvedValue(null);
      prisma.expense.create.mockClear();
      prisma.cashFlowEntry.create.mockClear();

      await service.commitImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);

      const created = prisma.expense.create.mock.calls[0][0];
      const cfCalls = prisma.cashFlowEntry.create.mock.calls;

      // 2/10 → restam 9 parcelas (2..10), não 10.
      expect(cfCalls).toHaveLength(9);
      expect(created.data.quantidadeParcela).toBe(9);
      expect(created.data.valorTotal).toBe(22861 * 9);

      // INVARIANTE: a soma dos lançamentos tem que fechar com o total da despesa.
      const soma = cfCalls.reduce((s: number, [arg]: [any]) => s + arg.data.valor, 0);
      expect(soma).toBe(created.data.valorTotal);

      // Rótulos preservam a numeração REAL da fatura (2/10..10/10) — é o que o
      // dedup entre faturas consecutivas casa.
      expect(cfCalls.map(([a]: [any]) => a.data.parcela)).toEqual([
        '2/10', '3/10', '4/10', '5/10', '6/10', '7/10', '8/10', '9/10', '10/10',
      ]);
    });

    it('meio de série ancora a parcela no mês da FATURA, não na data da compra', async () => {
      // Fatura Itaú de setembro trazendo "Parcela 2 de 10" datada de 22/06 (o
      // Itaú repete a data da COMPRA em toda parcela). A parcela está sendo
      // cobrada em SETEMBRO — ancorar em junho jogaria 9 parcelas 3 meses para
      // trás, inflando faturas passadas e esvaziando as futuras.
      const ws = XLSX.utils.aoa_to_sheet([
        [undefined, 'Cartão', undefined, undefined, undefined, undefined, 'Valor', undefined, 'Vencimento'],
        [undefined, 'Visa - final 5572', undefined, undefined, undefined, undefined, 100, undefined, '08/09/2026'],
        [],
        [undefined, 'Data', 'Lançamento', 'Parcelamento', 'Valor', undefined, 'Titularidade'],
        [undefined, '22/06/2026', 'Pg *Obramax', 'Parcela 2 de 10', '228.61', undefined, 'Titular'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fatura');
      const buf = Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));

      prisma.expense.findFirst.mockResolvedValue(null);
      prisma.expense.create.mockClear();
      prisma.cashFlowEntry.create.mockClear();

      await service.commitImport('t1', 'pessoal1', 'card1', buf, 'fatura.xlsx', 'AUTO', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);

      const created = prisma.expense.create.mock.calls[0][0];
      const iso = (d: Date) => d.toISOString().slice(0, 10);

      // Parcela 2/10 ancorada em setembro (dia da compra preservado).
      expect(iso(created.data.dataInicioParcela)).toBe('2026-09-22');
      // Competência preserva a data real da compra.
      expect(iso(created.data.dataCompra)).toBe('2026-06-22');

      const cf = prisma.cashFlowEntry.create.mock.calls;
      expect(cf).toHaveLength(9);
      expect(iso(cf[0][0].data.data)).toBe('2026-09-22');
      expect(cf[0][0].data.parcela).toBe('2/10');
      // Última parcela (10/10) — oito meses após setembro → maio/2027.
      expect(iso(cf[8][0].data.data)).toBe('2027-05-22');
      expect(cf[8][0].data.parcela).toBe('10/10');
    });

    it('ancora TODA linha da fatura no mês do vencimento, não só parcelas do meio', async () => {
      // Fatura de setembro trazendo uma compra à vista e uma "Parcela 1 de 10",
      // ambas datadas de julho (Itaú lista a data da COMPRA). As duas são
      // cobradas em SETEMBRO — deixá-las em julho enche a fatura errada.
      const ws = XLSX.utils.aoa_to_sheet([
        [undefined, 'Cartão', undefined, undefined, undefined, undefined, 'Valor', undefined, 'Vencimento'],
        [undefined, 'Visa - final 5572', undefined, undefined, undefined, undefined, 100, undefined, '08/09/2026'],
        [],
        [undefined, 'Data', 'Lançamento', 'Parcelamento', 'Valor', undefined, 'Titularidade'],
        [undefined, '21/07/2026', 'Telhanorte 43', '', '202.87', undefined, 'Titular'],
        [undefined, '21/07/2026', 'Telhanorte Parc', 'Parcela 1 de 10', '110.07', undefined, 'Titular'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fatura');
      const buf = Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));

      prisma.expense.findFirst.mockResolvedValue(null);
      prisma.expense.create.mockClear();

      await service.commitImport('t1', 'pessoal1', 'card1', buf, 'fatura.xlsx', 'AUTO', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);

      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const calls = prisma.expense.create.mock.calls.map(([a]: [any]) => a.data);

      const avista = calls.find((d: any) => d.titulo.startsWith('Telhanorte 43'));
      expect(iso(avista.dataPagamento)).toBe('2026-09-21');
      expect(iso(avista.dataCompra)).toBe('2026-07-21');

      const parc1 = calls.find((d: any) => d.titulo.includes('(1/10)'));
      expect(iso(parc1.dataInicioParcela)).toBe('2026-09-21');
      expect(iso(parc1.dataCompra)).toBe('2026-07-21');
    });

    it('não reancora para trás quando a compra é posterior ao vencimento', async () => {
      // Fatura em aberto (vence 08/09) com compra de 20/09, já do próximo
      // ciclo: a data original é a melhor informação e deve ser preservada.
      const ws = XLSX.utils.aoa_to_sheet([
        [undefined, 'Cartão', undefined, undefined, undefined, undefined, 'Valor', undefined, 'Vencimento'],
        [undefined, 'Visa - final 5572', undefined, undefined, undefined, undefined, 100, undefined, '08/09/2026'],
        [],
        [undefined, 'Data', 'Lançamento', 'Parcelamento', 'Valor', undefined, 'Titularidade'],
        [undefined, '20/09/2026', 'Compra Recente', '', '50.00', undefined, 'Titular'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fatura');
      const buf = Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));

      prisma.expense.findFirst.mockResolvedValue(null);
      prisma.expense.create.mockClear();

      await service.commitImport('t1', 'pessoal1', 'card1', buf, 'fatura.xlsx', 'AUTO', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);

      const created = prisma.expense.create.mock.calls[0][0];
      expect(created.data.dataPagamento.toISOString().slice(0, 10)).toBe('2026-09-20');
    });

  describe('commitImport — decisions', () => {    it('decision.skip ignora a transação (não cria expense)', async () => {
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
        [{ externalId: skipId, action: 'skip' }], null, TEST_OWNER_REQUESTER
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
        }], null, TEST_OWNER_REQUESTER
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
        [{ externalId: ext, action: 'link', linkToExpenseId: 'tgt1' }], null, TEST_OWNER_REQUESTER
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
        [{ externalId: ext, action: 'link', linkToExpenseId: 'tgt2' }], null, TEST_OWNER_REQUESTER
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
        'user-abc', TEST_OWNER_REQUESTER
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
      await service.commitImport('t1', 'pessoal1', 'card1', Buffer.from(ofx), 'f.ofx', 'OFX', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);

      const createdCall = prisma.expense.create.mock.calls[0][0];
      expect(createdCall.data.createdByUserId).toBeNull();
    });

    it('ignora ACL de link hidden para externalId duplicado/skip sem criar despesa', async () => {
      const ofx = buildOfx(
        ofxFor('20260429', 100, 'DUPLICADA HIDDEN', 'DUP-HIDDEN'),
        ofxFor('20260430', 200, 'SKIP HIDDEN', 'SKIP-HIDDEN'),
      );
      const preview = await service.previewImport(
        't1',
        'pessoal1',
        'card1',
        Buffer.from(ofx),
        'f.ofx',
        'OFX',
      );
      const duplicateId = preview.preview.find((item) =>
        item.merchant.includes('DUPLICADA'),
      )!.externalId;
      const skippedId = preview.preview.find((item) =>
        item.merchant.includes('SKIP'),
      )!.externalId;
      prisma.expense.findMany.mockImplementation(({ where }: any) => {
        if (where.externalId) return Promise.resolve([{ externalId: duplicateId }]);
        if (where.id) {
          return Promise.resolve([
            {
              id: 'hidden-target',
              tenantId: 't1',
              projectId: 'hidden-project',
              project: {
                id: 'hidden-project',
                tenantId: 't1',
                type: 'REFORMA',
              },
            },
          ]);
        }
        return Promise.resolve([]);
      });
      prisma.expense.create.mockClear();
      prisma.crossProjectSettlement.upsert.mockClear();

      await expect(
        service.commitImport(
          't1',
          'pessoal1',
          'card1',
          Buffer.from(ofx),
          'f.ofx',
          'OFX',
          undefined,
          undefined,
          [
            {
              externalId: duplicateId,
              action: 'link',
              linkToExpenseId: 'hidden-target',
            },
            {
              externalId: skippedId,
              action: 'skip',
              linkToExpenseId: 'hidden-target',
            },
          ],
          null,
          RESTRICTED_IMPORT_REQUESTER,
        ),
      ).resolves.toEqual(expect.objectContaining({ inserted: 0 }));
      expect(prisma.expense.create).not.toHaveBeenCalled();
      expect(prisma.crossProjectSettlement.upsert).not.toHaveBeenCalled();
    });

    it('bloqueia link hidden processável antes da primeira escrita', async () => {
      const ofx = buildOfx(
        ofxFor('20260429', 100, 'PROCESSADA HIDDEN', 'PROC-HIDDEN'),
      );
      const preview = await service.previewImport(
        't1',
        'pessoal1',
        'card1',
        Buffer.from(ofx),
        'f.ofx',
        'OFX',
      );
      const externalId = preview.preview[0].externalId;
      prisma.expense.findMany.mockImplementation(({ where }: any) => {
        if (where.externalId) return Promise.resolve([]);
        if (where.id) {
          return Promise.resolve([
            {
              id: 'hidden-target',
              tenantId: 't1',
              projectId: 'hidden-project',
              project: {
                id: 'hidden-project',
                tenantId: 't1',
                type: 'REFORMA',
              },
            },
          ]);
        }
        return Promise.resolve([]);
      });
      prisma.creditCardStatementImport.create.mockClear();
      prisma.expense.create.mockClear();

      await expect(
        service.commitImport(
          't1',
          'pessoal1',
          'card1',
          Buffer.from(ofx),
          'f.ofx',
          'OFX',
          undefined,
          undefined,
          [
            {
              externalId,
              action: 'link',
              linkToExpenseId: 'hidden-target',
            },
          ],
          null,
          RESTRICTED_IMPORT_REQUESTER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.creditCardStatementImport.create).not.toHaveBeenCalled();
      expect(prisma.expense.create).not.toHaveBeenCalled();
    });
  });

  describe('suggestLinks', () => {
    it('usa override em PARCELADO 1x e mantém fallback para A_VISTA', async () => {
      prisma.expense.findMany
        .mockResolvedValueOnce([
          {
            id: 'card-expense',
            titulo: 'Compra importada',
            fornecedor: 'Loja',
            valorTotal: 50000,
            dataPagamento: new Date('2026-04-29'),
            dataInicioParcela: null,
            createdAt: new Date('2026-04-29'),
            status: 'PAGO',
            cardLast4: '1234',
            formaPagamento: 'A_VISTA',
            quantidadeParcela: null,
            linkedExpenseId: null,
            tipoDespesa: 'OUTROS',
            seriesKey: null,
          },
        ])
        .mockResolvedValueOnce(plannedMatcherExpenses('PARCELADO'));
      prisma.project.findMany.mockResolvedValue([
        { id: 'casa1', name: 'Casa', type: 'CASA' },
      ]);

      const [result] = await service.suggestLinks('t1', 'pessoal1', 'card1');

      expect(result.suggestions.find((suggestion) => suggestion.expenseId === 'exp-override')).toMatchObject({
        data: '2026-04-29T00:00:00.000Z',
        installmentCurrent: 1,
        installmentTotal: 1,
      });
      expect(result.suggestions.find((suggestion) => suggestion.expenseId === 'exp-avista')).toMatchObject({
        data: '2026-04-28T00:00:00.000Z',
        installmentCurrent: null,
        installmentTotal: null,
      });
    });
  });
});
