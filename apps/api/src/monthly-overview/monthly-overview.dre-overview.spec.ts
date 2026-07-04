import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

describe('MonthlyOverviewService.getDreOverview', () => {
  let service: MonthlyOverviewService;
  let prisma: any;

  const tenantId = 'tenant-1';
  const projectId = 'pessoal-1';

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    prisma = {
      project: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL', deletedAt: null }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: projectId }, { id: 'reforma-1' }]),
      },
      cashFlowEntry: { findMany: jest.fn() },
      creditCard: { findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CardInvoiceSettlementService,
          useValue: { settleInvoice: jest.fn().mockResolvedValue({ settledExpenses: 0, settledParcelas: 0 }) },
        },
      ],
    }).compile();

    service = module.get<MonthlyOverviewService>(MonthlyOverviewService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('monta mensal/anual sem contar neutros e agrupa fatura em linha única na conta corrente', async () => {
    jest.spyOn(service, 'getAccountView').mockResolvedValue({
      mesSelecionado: '2026-06',
      caixaHoje: 757_629,
      entrouMes: 10_000,
      saiuMes: 3_000,
      faltaPagarMes: 2_500,
      recebimentosPrevistosMes: 10_000,
      sobraPrevista: 764_629,
      devoCartaoTotal: 2_500,
      cartoes: [],
      contas: [],
      saidas: [
        {
          id: null,
          kind: 'saida',
          descricao: 'Fatura Nubank ••1111',
          data: '2026-06-20T00:00:00.000Z',
          forma: 'cartao',
          valor: 2_500,
          realizado: false,
          status: 'PLANEJADO',
          cardLast4: '1111',
          bankLast4: null,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          isInvoice: true,
          editavel: false,
          dueMonth: '2026-06',
          projetoOrigem: null,
        },
        {
          id: 'exp-jun-moradia',
          kind: 'saida',
          descricao: 'Aluguel',
          data: '2026-06-03T00:00:00.000Z',
          forma: 'debito',
          valor: 3_000,
          realizado: true,
          status: 'PAGO',
          cardLast4: null,
          bankLast4: '4247',
          tipoDespesa: 'MORADIA',
          isInvoice: false,
          editavel: true,
          dueMonth: null,
          projetoOrigem: null,
        },
      ],
      comprasCartao: [],
      entradas: [
        {
          id: 'rec-jun',
          kind: 'entrada',
          descricao: 'Salário',
          data: '2026-06-02T00:00:00.000Z',
          tipo: 'salario',
          valor: 10_000,
          bankLast4: '4247',
          status: 'EM_CAIXA',
        },
      ],
      ticketMedio: {
        valor: 0,
        nCompras: 0,
        totalCompras: 0,
        serie6m: [],
        media6m: 0,
        deltaVsMediaPct: null,
      },
    } as any);

    prisma.creditCard.findMany.mockResolvedValue([
      { last4: '1111', nickname: 'Nubank', closingDay: 10, dueDay: 20 },
    ]);

    prisma.cashFlowEntry.findMany.mockResolvedValue([
      {
        id: 'rec-may',
        tipo: 'RECEBIMENTO',
        valor: 8_000,
        data: new Date('2026-05-02T00:00:00.000Z'),
        status: 'EM_CAIXA',
        expense: null,
        receipt: { id: 'rec-may', tipo: 'SALARIO', descricao: 'Salário', bankLast4: '4247' },
      },
      {
        id: 'exp-may',
        tipo: 'DESPESA',
        valor: 7_600,
        data: new Date('2026-05-05T00:00:00.000Z'),
        status: 'PAGO',
        expense: {
          id: 'exp-may',
          tipoDespesa: 'MORADIA',
          titulo: 'Aluguel',
          fornecedor: 'Imobiliária',
          cardLast4: null,
          bankLast4: '4247',
          linkedExpenseId: null,
        },
        receipt: null,
      },
      {
        id: 'rec-jun',
        tipo: 'RECEBIMENTO',
        valor: 10_000,
        data: new Date('2026-06-02T00:00:00.000Z'),
        status: 'EM_CAIXA',
        expense: null,
        receipt: { id: 'rec-jun', tipo: 'SALARIO', descricao: 'Salário', bankLast4: '4247' },
      },
      {
        id: 'exp-jun-moradia',
        tipo: 'DESPESA',
        valor: 3_000,
        data: new Date('2026-06-03T00:00:00.000Z'),
        status: 'PAGO',
        expense: {
          id: 'exp-jun-moradia',
          tipoDespesa: 'MORADIA',
          titulo: 'Aluguel',
          fornecedor: 'Imobiliária',
          cardLast4: null,
          bankLast4: '4247',
          linkedExpenseId: null,
        },
        receipt: null,
      },
      {
        id: 'exp-jun-card',
        tipo: 'DESPESA',
        valor: 2_500,
        data: new Date('2026-06-04T00:00:00.000Z'),
        status: 'PAGO',
        expense: {
          id: 'exp-jun-card',
          tipoDespesa: 'ALIMENTACAO',
          titulo: 'Restaurante',
          fornecedor: 'Restaurante',
          cardLast4: '1111',
          bankLast4: null,
          linkedExpenseId: null,
        },
        receipt: null,
      },
      {
        id: 'exp-jun-guardado',
        tipo: 'DESPESA',
        valor: 1_000,
        data: new Date('2026-06-05T00:00:00.000Z'),
        status: 'PAGO',
        expense: {
          id: 'exp-jun-guardado',
          tipoDespesa: 'INVESTIMENTOS',
          titulo: 'Reserva',
          fornecedor: null,
          cardLast4: null,
          bankLast4: '4247',
          linkedExpenseId: null,
        },
        receipt: null,
      },
      {
        id: 'exp-jun-neutral',
        tipo: 'DESPESA',
        valor: 2_000,
        data: new Date('2026-06-06T00:00:00.000Z'),
        status: 'PAGO',
        expense: {
          id: 'exp-jun-neutral',
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          titulo: 'Pagamento fatura',
          fornecedor: null,
          cardLast4: '1111',
          bankLast4: '4247',
          linkedExpenseId: null,
        },
        receipt: null,
      },
      {
        id: 'espelho',
        tipo: 'DESPESA',
        valor: 9_999,
        data: new Date('2026-06-07T00:00:00.000Z'),
        status: 'PAGO',
        expense: {
          id: 'espelho',
          tipoDespesa: 'MORADIA',
          titulo: 'Espelho',
          fornecedor: null,
          cardLast4: null,
          bankLast4: '4247',
          linkedExpenseId: 'target-123',
        },
        receipt: null,
      },
    ]);

    const res = await service.getDreOverview(tenantId, projectId, {
      month: '2026-06',
      year: '2026',
    });

    expect(res.mensal.totalEntrou).toBe(10_000);
    expect(res.mensal.despesaTotal).toBe(5_500); // moradia + compra no cartão
    expect(res.mensal.guardado).toEqual([{ label: 'Investimentos', valor: 1_000 }]);
    expect(res.mensal.totalSaiuMaisGuardou).toBe(6_500);
    expect(res.mensal.resultado).toBe(3_500);

    const grupoFaturas = res.mensal.saidasCaixa.find(
      (group: any) => group.group === 'Faturas de cartão',
    );
    expect(grupoFaturas).toBeTruthy();
    if (!grupoFaturas) {
      throw new Error('Grupo de faturas deveria existir');
    }
    expect(grupoFaturas.items).toHaveLength(1);
    expect(grupoFaturas.items[0].label).toContain('Fatura Nubank');
    expect(grupoFaturas.items[0].valor).toBe(2_500);
    expect(res.mensal.contaCorrente).toEqual({
      caixaHoje: 757_629,
      entrouMes: 10_000,
      saiuMes: 3_000,
      faltaPagarMes: 2_500,
      recebimentosPrevistosMes: 10_000,
      sobraPrevista: 764_629,
      despesaTotal: 5_500,
    });

    expect(
      res.mensal.saidas.some((group: any) =>
        group.items.some((item: any) => /fatura/i.test(item.label)),
      ),
    ).toBe(false);

    expect(res.anual.totalEntrou).toBe(18_000);
    expect(res.anual.totalSaiu).toBe(13_100);
    expect(res.anual.resultadoAcumulado).toBe(3_900);
    expect(
      res.anual.serie.some((item: any) => item.mes === '2026-05' && item.isCritical),
    ).toBe(true);
  });

  describe('anual.saldoAcumuladoSerie (fonte: getAccountView por mês, inclui cross-project)', () => {
    // beforeEach fixa o relógio em 2026-06-15 => realizedUntil = 6 (junho).
    const CAIXA_HOJE = 100_000;
    type MV = { entrou: number; saiu: number; falta: number; receb: number };

    // Jan..Jun realizados (falta=0 => projetado==realizado no passado);
    // Ago carrega um DÉBITO CROSS-PROJECT (REFORMA 5_000) dentro de faltaPagar,
    // além do cartão 3_000 => faltaPagar Ago = 8_000. É a prova do bug.
    const baseMonthData: Record<string, MV> = {
      '2026-01': { entrou: 20_000, saiu: 5_000, falta: 0, receb: 0 },
      '2026-02': { entrou: 10_000, saiu: 8_000, falta: 0, receb: 0 },
      '2026-03': { entrou: 10_000, saiu: 3_000, falta: 0, receb: 0 },
      '2026-04': { entrou: 5_000, saiu: 5_000, falta: 0, receb: 0 },
      '2026-05': { entrou: 8_000, saiu: 2_000, falta: 0, receb: 0 },
      '2026-06': { entrou: 10_000, saiu: 4_000, falta: 0, receb: 0 },
      '2026-07': { entrou: 0, saiu: 0, falta: 3_000, receb: 0 },
      '2026-08': { entrou: 0, saiu: 0, falta: 8_000, receb: 0 }, // 3_000 cartão + 5_000 REFORMA
      '2026-09': { entrou: 0, saiu: 0, falta: 0, receb: 0 },
      '2026-10': { entrou: 0, saiu: 0, falta: 0, receb: 0 },
      '2026-11': { entrou: 0, saiu: 0, falta: 0, receb: 0 },
      '2026-12': { entrou: 0, saiu: 0, falta: 0, receb: 0 },
    };

    const viewFor = (month: string, data: Record<string, MV> = baseMonthData) => {
      const m = data[month] ?? { entrou: 0, saiu: 0, falta: 0, receb: 0 };
      return {
        mesSelecionado: month,
        caixaHoje: CAIXA_HOJE,
        entrouMes: m.entrou,
        saiuMes: m.saiu,
        faltaPagarMes: m.falta,
        recebimentosPrevistosMes: m.receb,
        sobraPrevista: CAIXA_HOJE - m.falta + m.receb,
        devoCartaoTotal: 0,
        cartoes: [],
        contas: [],
        saidas: [],
        comprasCartao: [],
        entradas: [],
        ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
      } as any;
    };

    const runAnnual = async (
      data: Record<string, MV> = baseMonthData,
      params: { month: string; year: string } = { month: '2026-06', year: '2026' },
    ) => {
      const spy = jest
        .spyOn(service, 'getAccountView')
        .mockImplementation(async (_t: string, _p: string, month?: string) => viewFor(month as string, data));
      prisma.creditCard.findMany.mockResolvedValue([]);
      prisma.cashFlowEntry.findMany.mockResolvedValue([]); // série NÃO folda mais `normalized`
      const res = await service.getDreOverview(tenantId, projectId, params);
      return { res, spy };
    };
    const byMes = (res: any, mes: string) =>
      res.anual.saldoAcumuladoSerie.find((r: any) => r.mes === mes);

    it('(design) chama getAccountView 1x por mês do ano (12x)', async () => {
      const { spy } = await runAnnual();
      expect(spy).toHaveBeenCalledTimes(12);
      for (const m of Object.keys(baseMonthData)) {
        expect(spy).toHaveBeenCalledWith(tenantId, projectId, m);
      }
    });

    it('(a) reconciliação: saldoRealizado do mês corrente == caixaHoje; opening calibrado', async () => {
      const { res } = await runAnnual();
      expect(res.anual.caixaHoje).toBe(100_000);
      expect(res.anual.saldoAcumuladoOpening).toBe(64_000); // 100_000 − ΣnetReal(jan..jun)=36_000
      expect(byMes(res, '2026-06').saldoRealizado).toBe(100_000);
      expect(byMes(res, '2026-06').saldoRealizado).toBe(res.mensal.contaCorrente.caixaHoje);
    });

    it('(b) acúmulo realizado usa entrou−saiu do account-view', async () => {
      const { res } = await runAnnual();
      expect(byMes(res, '2026-01').saldoRealizado).toBe(79_000);
      expect(byMes(res, '2026-03').saldoRealizado).toBe(88_000);
      expect(byMes(res, '2026-05').saldoRealizado).toBe(94_000);
      const jun = byMes(res, '2026-06');
      expect(jun.recebimentosRealizados).toBe(10_000); // = entrouMes
      expect(jun.despesasRealizadas).toBe(4_000); // = saiuMes
      expect(jun.recebimentos).toBe(10_000); // entrou + recebPrev(0)
      expect(jun.despesas).toBe(4_000); // saiu + falta(0)
    });

    it('(c) CROSS-PROJECT: débito de outro projeto entra em despesas/saldoProjetado do mês futuro', async () => {
      const { res } = await runAnnual();
      const ago = byMes(res, '2026-08');
      expect(ago.saldoRealizado).toBeNull();
      expect(ago.despesas).toBe(8_000); // 3_000 cartão + 5_000 REFORMA (folding antigo daria 3_000)
      expect(ago.recebimentos).toBe(0);
      expect(ago.despesasRealizadas).toBeNull();
      // Jul projetado 97_000 → Ago 89_000: queda de 8_000, inclui o cross-project.
      expect(byMes(res, '2026-07').saldoProjetado).toBe(97_000);
      expect(ago.saldoProjetado).toBe(89_000);
      expect(byMes(res, '2026-07').saldoProjetado - ago.saldoProjetado).toBe(8_000);
    });

    it('(d) meses futuros: realizado null, projetado presente e numérico', async () => {
      const { res } = await runAnnual();
      for (const mes of ['2026-07', '2026-08', '2026-12']) {
        const row = byMes(res, mes);
        expect(row.saldoRealizado).toBeNull();
        expect(row.recebimentosRealizados).toBeNull();
        expect(row.despesasRealizadas).toBeNull();
        expect(typeof row.saldoProjetado).toBe('number');
        expect(typeof row.despesas).toBe('number');
      }
      expect(byMes(res, '2026-06').saldoRealizado).not.toBeNull();
    });

    it('(e) sem pendências no passado: projetado == realizado até o mês corrente', async () => {
      const { res } = await runAnnual();
      expect(byMes(res, '2026-06').saldoProjetado).toBe(100_000);
      expect(byMes(res, '2026-06').saldoProjetado).toBe(byMes(res, '2026-06').saldoRealizado);
    });

    it('(f) overdue no passado NÃO clampa: projetado abaixo do realizado e propaga até dezembro', async () => {
      const baselineDec = byMes((await runAnnual()).res, '2026-12').saldoProjetado; // 89_000
      const data = { ...baseMonthData, '2026-01': { entrou: 20_000, saiu: 5_000, falta: 10_000, receb: 0 } };
      const { res } = await runAnnual(data);
      expect(byMes(res, '2026-01').saldoRealizado).toBe(79_000); // realizado ignora overdue
      expect(byMes(res, '2026-01').saldoProjetado).toBe(69_000); // 64_000 + (20_000 − 15_000)
      expect(byMes(res, '2026-01').saldoProjetado).toBeLessThan(byMes(res, '2026-01').saldoRealizado);
      expect(byMes(res, '2026-12').saldoProjetado).toBe(baselineDec - 10_000); // propaga, sem clamp
    });

    it('(g) mensal/competência/serie intactos (só a fonte da série de saldo mudou)', async () => {
      const { res } = await runAnnual();
      expect(res.anual.serie).toHaveLength(12);
      expect(res.anual.serie[0]).not.toHaveProperty('saldoRealizado');
      expect(res.mensal.contaCorrente.caixaHoje).toBe(100_000);
      expect(res.anual.saldoAcumuladoSerie).toHaveLength(12);
    });

    it('(h) boundary ano futuro: realizedUntil=0 ⇒ realizado null e opening == caixaHoje', async () => {
      const data2027: Record<string, MV> = { '2027-01': { entrou: 0, saiu: 0, falta: 2_000, receb: 0 } };
      const { res } = await runAnnual(data2027, { month: '2027-01', year: '2027' });
      expect(res.anual.saldoAcumuladoOpening).toBe(100_000); // = caixaHoje
      for (const row of res.anual.saldoAcumuladoSerie) {
        expect(row.saldoRealizado).toBeNull();
        expect(typeof row.saldoProjetado).toBe('number');
      }
      expect(byMes(res, '2027-01').saldoProjetado).toBe(98_000); // 100_000 − falta 2_000
    });
  });
});
