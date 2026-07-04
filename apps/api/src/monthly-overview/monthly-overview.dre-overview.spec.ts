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

  describe('anual.saldoAcumuladoSerie (eixo caixa, reconciliado com caixaHoje)', () => {
    const accountView = {
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
      saidas: [],
      comprasCartao: [],
      entradas: [],
      ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
    } as any;

    // Fixture base (eixo caixa): mai receb 8000 / desp 7600; jun receb 10000 /
    // desp 6500 (moradia 3000 + cartão 2500 no mês da fatura + guardado 1000).
    // Neutro (PAGAMENTO_FATURA_CARTAO) e espelho (linkedExpenseId) são excluídos.
    const baseCashFlow = [
      {
        id: 'rec-may', tipo: 'RECEBIMENTO', valor: 8_000,
        data: new Date('2026-05-02T00:00:00.000Z'), status: 'EM_CAIXA',
        expense: null, receipt: { id: 'rec-may', tipo: 'SALARIO', descricao: 'Salário', bankLast4: '4247' },
      },
      {
        id: 'exp-may', tipo: 'DESPESA', valor: 7_600,
        data: new Date('2026-05-05T00:00:00.000Z'), status: 'PAGO',
        expense: { id: 'exp-may', tipoDespesa: 'MORADIA', titulo: 'Aluguel', fornecedor: 'Imob', cardLast4: null, bankLast4: '4247', linkedExpenseId: null },
        receipt: null,
      },
      {
        id: 'rec-jun', tipo: 'RECEBIMENTO', valor: 10_000,
        data: new Date('2026-06-02T00:00:00.000Z'), status: 'EM_CAIXA',
        expense: null, receipt: { id: 'rec-jun', tipo: 'SALARIO', descricao: 'Salário', bankLast4: '4247' },
      },
      {
        id: 'exp-jun-moradia', tipo: 'DESPESA', valor: 3_000,
        data: new Date('2026-06-03T00:00:00.000Z'), status: 'PAGO',
        expense: { id: 'exp-jun-moradia', tipoDespesa: 'MORADIA', titulo: 'Aluguel', fornecedor: 'Imob', cardLast4: null, bankLast4: '4247', linkedExpenseId: null },
        receipt: null,
      },
      {
        id: 'exp-jun-card', tipo: 'DESPESA', valor: 2_500,
        data: new Date('2026-06-04T00:00:00.000Z'), status: 'PAGO',
        expense: { id: 'exp-jun-card', tipoDespesa: 'ALIMENTACAO', titulo: 'Restaurante', fornecedor: 'Rest', cardLast4: '1111', bankLast4: null, linkedExpenseId: null },
        receipt: null,
      },
      {
        id: 'exp-jun-guardado', tipo: 'DESPESA', valor: 1_000,
        data: new Date('2026-06-05T00:00:00.000Z'), status: 'PAGO',
        expense: { id: 'exp-jun-guardado', tipoDespesa: 'INVESTIMENTOS', titulo: 'Reserva', fornecedor: null, cardLast4: null, bankLast4: '4247', linkedExpenseId: null },
        receipt: null,
      },
      {
        id: 'exp-jun-neutral', tipo: 'DESPESA', valor: 2_000,
        data: new Date('2026-06-06T00:00:00.000Z'), status: 'PAGO',
        expense: { id: 'exp-jun-neutral', tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', titulo: 'Pgto fatura', fornecedor: null, cardLast4: '1111', bankLast4: '4247', linkedExpenseId: null },
        receipt: null,
      },
      {
        id: 'espelho', tipo: 'DESPESA', valor: 9_999,
        data: new Date('2026-06-07T00:00:00.000Z'), status: 'PAGO',
        expense: { id: 'espelho', tipoDespesa: 'MORADIA', titulo: 'Espelho', fornecedor: null, cardLast4: null, bankLast4: '4247', linkedExpenseId: 'target-123' },
        receipt: null,
      },
    ];

    const runWith = async (entries: any[]) => {
      jest.spyOn(service, 'getAccountView').mockResolvedValue({ ...accountView });
      prisma.creditCard.findMany.mockResolvedValue([
        { last4: '1111', nickname: 'Nubank', closingDay: 10, dueDay: 20 },
      ]);
      prisma.cashFlowEntry.findMany.mockResolvedValue(entries);
      return service.getDreOverview(tenantId, projectId, { month: '2026-06', year: '2026' });
    };
    const byMes = (res: any, mes: string) =>
      res.anual.saldoAcumuladoSerie.find((r: any) => r.mes === mes);

    it('(a) reconciliação: saldoRealizado do mês corrente == caixaHoje', async () => {
      const res = await runWith(baseCashFlow);
      const jun = byMes(res, '2026-06');
      expect(jun.saldoRealizado).toBe(757_629);
      expect(jun.saldoRealizado).toBe(res.mensal.contaCorrente.caixaHoje);
      expect(res.anual.caixaHoje).toBe(757_629);
    });

    it('(b) saldo inicial = caixaHoje − fluxo realizado líquido jan..mês corrente', async () => {
      const res = await runWith(baseCashFlow);
      expect(res.anual.saldoAcumuladoOpening).toBe(753_729);
      expect(byMes(res, '2026-01').saldoRealizado).toBe(753_729);
      expect(byMes(res, '2026-04').saldoRealizado).toBe(753_729);
      expect(byMes(res, '2026-05').saldoRealizado).toBe(754_129); // +400
    });

    it('(c) composição realizada mensal no eixo caixa (cartão no mês da fatura)', async () => {
      const res = await runWith(baseCashFlow);
      const may = byMes(res, '2026-05');
      expect(may.recebimentosRealizados).toBe(8_000);
      expect(may.despesasRealizadas).toBe(7_600);
      const jun = byMes(res, '2026-06');
      expect(jun.recebimentosRealizados).toBe(10_000);
      expect(jun.despesasRealizadas).toBe(6_500); // 3000 + 2500(cartão) + 1000(guardado)
    });

    it('(f) guardado conta como saída de caixa (incluído em despesas)', async () => {
      const res = await runWith(baseCashFlow);
      // Se guardado fosse excluído, seria 5_500 — trava a decisão de eixo caixa.
      expect(byMes(res, '2026-06').despesas).toBe(6_500);
      expect(byMes(res, '2026-06').despesasRealizadas).toBe(6_500);
    });

    it('(e) meses futuros: realizado null, projetado presente', async () => {
      const res = await runWith(baseCashFlow);
      for (const mes of ['2026-07', '2026-08', '2026-12']) {
        const row = byMes(res, mes);
        expect(row.saldoRealizado).toBeNull();
        expect(row.recebimentosRealizados).toBeNull();
        expect(row.despesasRealizadas).toBeNull();
        expect(typeof row.saldoProjetado).toBe('number');
        expect(typeof row.recebimentos).toBe('number');
      }
      expect(byMes(res, '2026-06').saldoRealizado).not.toBeNull();
    });

    it('(g) payload serie/mensal existente inalterado (só aditivo)', async () => {
      const res = await runWith(baseCashFlow);
      expect(res.anual.serie).toHaveLength(12);
      expect(res.anual.totalEntrou).toBe(18_000);
      expect(res.anual.resultadoAcumulado).toBe(3_900);
      expect(res.mensal.resultado).toBe(3_500);
      expect(res.anual.serie[0]).not.toHaveProperty('saldoRealizado');
    });

    it('(d) projetado acumula previstos que o realizado omite', async () => {
      const entries = [
        ...baseCashFlow,
        {
          id: 'exp-jul-previsto', tipo: 'DESPESA', valor: 4_000,
          data: new Date('2026-07-10T00:00:00.000Z'), status: 'PLANEJADO',
          expense: { id: 'exp-jul-previsto', tipoDespesa: 'MORADIA', titulo: 'Aluguel jul', fornecedor: 'Imob', cardLast4: null, bankLast4: '4247', linkedExpenseId: null },
          receipt: null,
        },
      ];
      const res = await runWith(entries);
      const jul = byMes(res, '2026-07');
      expect(jul.saldoRealizado).toBeNull();
      expect(jul.despesas).toBe(4_000);
      expect(jul.saldoProjetado).toBe(byMes(res, '2026-06').saldoProjetado - 4_000);
    });

    it('compra no cartão após o fechamento cai no mês da fatura (eixo caixa), não na competência', async () => {
      const entries = [
        ...baseCashFlow,
        {
          id: 'exp-card-roll', tipo: 'DESPESA', valor: 900,
          data: new Date('2026-06-15T00:00:00.000Z'), status: 'PAGO',
          expense: { id: 'exp-card-roll', tipoDespesa: 'ALIMENTACAO', titulo: 'Mercado', fornecedor: 'Mercado', cardLast4: '1111', bankLast4: null, linkedExpenseId: null },
          receipt: null,
        },
      ];
      const res = await runWith(entries);
      // fechamento dia 10; compra dia 15 → fatura de julho (mês de caixa)
      expect(byMes(res, '2026-06').despesas).toBe(6_500);
      expect(byMes(res, '2026-07').despesas).toBeGreaterThanOrEqual(900);
      // a serie de competência (intacta) ainda contabiliza em junho → eixos independentes
      const junComp = res.anual.serie.find((s: any) => s.mes === '2026-06');
      expect(junComp?.projecaoDespesa).toBeGreaterThanOrEqual(900);
    });
  });
});
