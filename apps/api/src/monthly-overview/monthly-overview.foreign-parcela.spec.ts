import { Test, TestingModule } from '@nestjs/testing';
import { MonthlyOverviewService } from './monthly-overview.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';

describe('MonthlyOverviewService.getAccountView — origem POR PARCELA (P3) + compat', () => {
  let service: MonthlyOverviewService;
  let prisma: any;

  const tenantId = 'tenant-1';
  const projectId = 'pessoal-1';
  const foreignId = 'foreign-1';

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL', deletedAt: null }),
        findMany: jest.fn().mockResolvedValue([{ id: projectId, name: 'Pessoal', type: 'PESSOAL' }]),
      },
      bankAccount: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
      expense: { findMany: jest.fn(), create: jest.fn() },
      receipt: { findMany: jest.fn().mockResolvedValue([]) },
      cashFlowEntry: { findMany: jest.fn().mockResolvedValue([]) },
      creditCard: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'card-1', tenantId, projectId, nickname: 'Nubank', last4: '1111', closingDay: 20, dueDay: 28, limitTotalCents: 100000, limitAvailableCents: 50000 },
        ]),
        findFirst: jest.fn(),
      },
      crossProjectSettlement: { findMany: jest.fn().mockResolvedValue([]) }, // NOVA query esperada
      rateioAllocation: { findMany: jest.fn().mockResolvedValue([]) },
      invoiceAdjustment: { findMany: jest.fn().mockResolvedValue([]) },
      bankStatementImport: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyOverviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: CardInvoiceSettlementService, useValue: { settleInvoice: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();
    service = module.get(MonthlyOverviewService);
  });
  afterEach(() => jest.useRealTimers());

  // Foreign QUINZENAL 10x a partir de 2026-06-04: idx0=06-04, idx1=06-19 (ambos em junho).
  const foreignQuinzenal = () => ({
    id: foreignId, tenantId, projectId: 'reforma-1', tipoDespesa: 'OUTROS', titulo: 'Piso', fornecedor: 'Loja',
    valor: 10000, valorTotal: 100000, formaPagamento: 'QUINZENAL', dataPagamento: null,
    dataInicioParcela: new Date('2026-06-04T00:00:00.000Z'), quantidadeParcela: 10, status: 'PLANEJADO',
    cardLast4: null, bankLast4: null, importId: null, createdAt: new Date('2026-06-01T00:00:00.000Z'),
    linkedExpenseId: null, settledByExpenseId: null, settlesInvoiceKey: null, paidParcelas: '[0]',
    project: { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' },
  });
  const mirrorCard = () => ({
    id: 'mirror-card', tenantId, projectId, tipoDespesa: 'OUTROS', titulo: 'Piso 1/10', fornecedor: 'Loja',
    valor: 10000, valorTotal: 10000, formaPagamento: 'A_VISTA', dataPagamento: new Date('2026-06-04T00:00:00.000Z'),
    dataInicioParcela: null, quantidadeParcela: null, status: 'PAGO', cardLast4: '1111', bankLast4: null,
    importId: null, createdAt: new Date('2026-06-04T00:00:00.000Z'), linkedExpenseId: foreignId,
    settledByExpenseId: null, settlesInvoiceKey: null, paidParcelas: null,
    project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
  });

  it('P3: parcela quitada por CARTÃO é suprimida; as demais permanecem em faltaPagar no vencimento', async () => {
    prisma.expense.findMany.mockResolvedValue([foreignQuinzenal(), mirrorCard()]);
    prisma.crossProjectSettlement.findMany.mockResolvedValue([
      { tenantId, targetExpenseId: foreignId, parcelaIndex: 0, sourceExpenseId: 'mirror-card', realValor: 10000, plannedValor: 10000, plannedStatus: 'PLANEJADO' },
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, '2026-06');

    // getAccountView DEVE ter consultado crossProjectSettlement.
    expect(prisma.crossProjectSettlement.findMany).toHaveBeenCalled();

    const ids = res.saidas.map((s: any) => s.id);
    // idx0 (quitada por cartão) NÃO aparece como saída de conta (fatura cobre).
    expect(ids).not.toContain(`${foreignId}#0`);
    // idx1 (NÃO quitada) permanece em faltaPagar no seu vencimento (06-19), valor 10000.
    const p1 = res.saidas.find((s: any) => s.id === `${foreignId}#1`);
    expect(p1).toBeDefined();
    expect(p1.valor).toBe(10000);
    expect(p1.editavel).toBe(false);
    // contrato P7: carrega parcelaIndex + foreignExpenseId p/ o front abrir a quitação.
    expect(p1.parcelaIndex).toBe(1);
    expect(p1.foreignExpenseId).toBe(foreignId);
    // faltaPagar inclui a parcela não quitada (money NÃO some).
    expect(res.faltaPagarMes).toBeGreaterThanOrEqual(10000);
  });

  it('P3: parcela quitada por CONTA (espelho bank) — espelho conta no caixa, demais pendentes', async () => {
    const mirrorBank = { ...mirrorCard(), id: 'mirror-bank', cardLast4: null, bankLast4: '4247' };
    prisma.bankAccount.findMany.mockResolvedValue([
      { id: 'acc-1', openingBalanceCents: 0, openingBalanceDate: null, last4: '4247', nickname: 'Conta', institution: 'Banco' },
    ]);
    prisma.expense.findMany.mockResolvedValue([foreignQuinzenal(), mirrorBank]);
    prisma.crossProjectSettlement.findMany.mockResolvedValue([
      { tenantId, targetExpenseId: foreignId, parcelaIndex: 0, sourceExpenseId: 'mirror-bank', realValor: 10000, plannedValor: 10000, plannedStatus: 'PLANEJADO' },
    ]);

    const res: any = await service.getAccountView(tenantId, projectId, '2026-06');
    const ids = res.saidas.map((s: any) => s.id);
    // idx0 já representada pelo espelho bank em accountExpenseList (id do próprio espelho), não re-emitida como #0.
    expect(ids).not.toContain(`${foreignId}#0`);
    expect(ids).toContain('mirror-bank');
    // idx1 permanece pendente.
    expect(ids).toContain(`${foreignId}#1`);
  });

  it('COMPAT: espelho linkado SEM crossProjectSettlement (link manual legado) usa caminho agregado sem quebrar', async () => {
    // PIX RMD manual: mirror bank à-vista linkado, ZERO settlement. Foreign à-vista.
    prisma.bankAccount.findMany.mockResolvedValue([
      { id: 'acc-1', openingBalanceCents: 0, openingBalanceDate: null, last4: '4247', nickname: 'Conta', institution: 'Banco' },
    ]);
    const foreignAvista = {
      ...foreignQuinzenal(), formaPagamento: 'A_VISTA', quantidadeParcela: null, dataInicioParcela: null,
      dataPagamento: new Date('2026-06-10T00:00:00.000Z'), valorTotal: 5000, paidParcelas: null,
    };
    const mirrorBankLegacy = {
      ...mirrorCard(), id: 'mirror-legacy', cardLast4: null, bankLast4: '4247', valorTotal: 5000,
      dataPagamento: new Date('2026-06-10T00:00:00.000Z'), linkedExpenseId: foreignId,
    };
    prisma.expense.findMany.mockResolvedValue([foreignAvista, mirrorBankLegacy]);
    prisma.crossProjectSettlement.findMany.mockResolvedValue([]); // legado: sem settlement

    const res: any = await service.getAccountView(tenantId, projectId, '2026-06');
    const ids = res.saidas.map((s: any) => s.id);
    // NÃO deve emitir linha por-parcela (#) para o foreign legado à-vista...
    expect(ids.some((id: string) => typeof id === 'string' && id.startsWith(`${foreignId}#`))).toBe(false);
    // ...e o espelho bank aparece uma única vez em accountExpenseList (sem dupla contagem).
    expect(ids.filter((id: string) => id === 'mirror-legacy')).toHaveLength(1);
  });

  // ── DADOS REAIS DE PRODUÇÃO (Infra+Eletrica+Hidraulica+Demolição) ────────────
  // Valores exatos capturados de prod em 2026-07-03:
  //   alvo REFORMA cmow625mr… : QUINZENAL 80.000 em 10x (8.000/parcela),
  //     dataInicioParcela 2026-06-08, paidParcelas [0,1,2], status PLANEJADO.
  //   3 espelhos PAGO na conta Itaú ••3636: 05/06 (idx0), 23/06 (idx1), 03/07 (idx2).
  // O caminho POR PARCELA (feature nova) deve: suprimir 0/1/2 (já quitadas),
  // manter 3 (23/07) pendente com o VALOR DA PARCELA (8.000, nunca 80.000),
  // e nunca alterar o valorTotal do alvo. Nada pode se perder.
  describe('PROD Infra: quinzenal 80k/10, 3 parcelas quitadas por conta', () => {
    const TARGET = 'cmow625mr00fmb3i5uh8l1oc2';
    const infraTarget = () => ({
      id: TARGET, tenantId, projectId: 'reforma-1', tipoDespesa: 'MAO_DE_OBRA',
      titulo: 'Infra+Eletrica+Hidraulica+Demolição', fornecedor: 'Julio',
      valor: 8000000, valorTotal: 8000000, formaPagamento: 'QUINZENAL', dataPagamento: null,
      dataInicioParcela: new Date('2026-06-08T00:00:00.000Z'), quantidadeParcela: 10, status: 'PLANEJADO',
      cardLast4: null, bankLast4: '3636', importId: null, createdAt: new Date('2026-05-08T00:18:02.115Z'),
      linkedExpenseId: null, settledByExpenseId: null, settlesInvoiceKey: null, paidParcelas: '[0,1,2]',
      project: { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' },
    });
    const mirror = (id: string, iso: string) => ({
      id, tenantId, projectId, tipoDespesa: 'MAO_DE_OBRA', titulo: 'Infra parcela', fornecedor: 'Julio',
      valor: 800000, valorTotal: 800000, formaPagamento: 'A_VISTA', dataPagamento: new Date(iso),
      dataInicioParcela: null, quantidadeParcela: null, status: 'PAGO', cardLast4: null, bankLast4: '3636',
      importId: null, createdAt: new Date(iso), linkedExpenseId: TARGET,
      settledByExpenseId: null, settlesInvoiceKey: null, paidParcelas: null,
      project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
    });

    beforeEach(() => {
      jest.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
      prisma.bankAccount.findMany.mockResolvedValue([
        { id: 'acc-itau', openingBalanceCents: 0, openingBalanceDate: null, last4: '3636', nickname: 'Itau', institution: 'ITAU' },
      ]);
      prisma.expense.findMany.mockResolvedValue([
        infraTarget(),
        mirror('cmq4d7gi3003xnyrxo7zv2u15', '2026-06-05T00:00:00.000Z'),
        mirror('cmqs2iu02000d1qim0idsmmxq', '2026-06-23T00:00:00.000Z'),
        mirror('cmr5dpgse004msp281c76qqwn', '2026-07-03T00:00:00.000Z'),
      ]);
      prisma.crossProjectSettlement.findMany.mockResolvedValue([
        { tenantId, targetExpenseId: TARGET, parcelaIndex: 0, sourceExpenseId: 'cmq4d7gi3003xnyrxo7zv2u15', realValor: 800000, plannedValor: 800000, plannedStatus: 'PLANEJADO' },
        { tenantId, targetExpenseId: TARGET, parcelaIndex: 1, sourceExpenseId: 'cmqs2iu02000d1qim0idsmmxq', realValor: 800000, plannedValor: 800000, plannedStatus: 'PLANEJADO' },
        { tenantId, targetExpenseId: TARGET, parcelaIndex: 2, sourceExpenseId: 'cmr5dpgse004msp281c76qqwn', realValor: 800000, plannedValor: 800000, plannedStatus: 'PLANEJADO' },
      ]);
    });

    it('parcela 3 (23/07) pendente com VALOR DA PARCELA (8.000), parcelaIndex+foreignExpenseId; 0/1/2 suprimidas', async () => {
      const res: any = await service.getAccountView(tenantId, projectId, '2026-07');
      const ids = res.saidas.map((s: any) => s.id);

      // parcelas quitadas (0,1,2) NÃO reaparecem como linhas #.
      expect(ids).not.toContain(`${TARGET}#0`);
      expect(ids).not.toContain(`${TARGET}#1`);
      expect(ids).not.toContain(`${TARGET}#2`);

      // parcela 3 (23/07) pendente, valor 8.000 (NÃO 80.000), com contrato P7.
      const p3 = res.saidas.find((s: any) => s.id === `${TARGET}#3`);
      expect(p3).toBeDefined();
      expect(p3.valor).toBe(800000);
      expect(p3.parcelaIndex).toBe(3);
      expect(p3.foreignExpenseId).toBe(TARGET);
      expect(p3.realizado).toBe(false);
      expect(p3.data.slice(0, 10)).toBe('2026-07-23');
    });

    it('nenhuma linha do alvo excede o valor de UMA parcela (valorTotal 80.000 nunca vaza)', async () => {
      const res: any = await service.getAccountView(tenantId, projectId, '2026-07');
      const doAlvo = res.saidas.filter(
        (s: any) => s.foreignExpenseId === TARGET || String(s.id).startsWith(`${TARGET}#`),
      );
      for (const s of doAlvo) expect(s.valor).toBeLessThanOrEqual(800000);
    });

    it('os 3 espelhos foram debitados do caixa (Σ = 24.000; nada se perde) e o de julho aparece 1×', async () => {
      const res: any = await service.getAccountView(tenantId, projectId, '2026-07');
      // Saldo inicial 0 − 3 espelhos PAGO de 8.000 = -24.000 → prova que os 3
      // movimentos entraram no caixa (nenhum sumiu, nenhum contado em dobro).
      expect(res.caixaHoje).toBe(-2400000);
      // O espelho de julho (03/07) aparece exatamente uma vez como realizado.
      const julho = res.saidas.filter((s: any) => s.id === 'cmr5dpgse004msp281c76qqwn');
      expect(julho).toHaveLength(1);
      expect(julho[0].realizado).toBe(true);
      // Só a parcela 3 pendente de julho pesa em faltaPagar (8.000).
      expect(res.faltaPagarMes).toBe(800000);
    });
  });

  // ── #306: parcela marcada paga (paidParcelas) SEM nenhum crossProjectSettlement
  // (caso real de prod: setParcelaStatus direto no projeto de origem, sem passar
  // pelo vínculo/rateio/conciliação do PESSOAL) não pode sumir do consolidado.
  describe('#306: parcela paga sem settlement/vínculo não some do consolidado', () => {
    const TARGET2 = 'foreign-306';
    const target = (paidParcelas: string | null) => ({
      id: TARGET2, tenantId, projectId: 'reforma-1', tipoDespesa: 'MAO_DE_OBRA',
      titulo: 'Infra 306', fornecedor: 'Julio',
      valor: 800000, valorTotal: 8000000, formaPagamento: 'QUINZENAL', dataPagamento: null,
      dataInicioParcela: new Date('2026-06-08T00:00:00.000Z'), quantidadeParcela: 10, status: 'PLANEJADO',
      cardLast4: null, bankLast4: null, importId: null, createdAt: new Date('2026-05-08T00:00:00.000Z'),
      linkedExpenseId: null, settledByExpenseId: null, settlesInvoiceKey: null, paidParcelas,
      project: { id: 'reforma-1', name: 'Reforma', type: 'REFORMA' },
    });
    // Espelho PESSOAL (vínculo simples do #276, sem rateio e sem settlement) que
    // classifica a origem como 'bank' — é o que existe no caso real de prod
    // (a despesa em si não carrega bankLast4; quem carrega é o espelho vinculado).
    // Data fora de qualquer range testado para não poluir accountExpenseList.
    const bankEspelho = {
      id: 'espelho-306', tenantId, projectId, tipoDespesa: 'MAO_DE_OBRA', titulo: 'Infra 306 (vínculo)',
      fornecedor: 'Julio', valor: 8000000, valorTotal: 8000000, formaPagamento: 'A_VISTA',
      dataPagamento: new Date('2026-01-01T00:00:00.000Z'), dataInicioParcela: null, quantidadeParcela: null,
      status: 'PLANEJADO', cardLast4: null, bankLast4: '3636', importId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'), linkedExpenseId: TARGET2,
      settledByExpenseId: null, settlesInvoiceKey: null, paidParcelas: null,
      project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
    };

    beforeEach(() => {
      jest.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
      prisma.bankAccount.findMany.mockResolvedValue([
        { id: 'acc-itau', openingBalanceCents: 0, openingBalanceDate: null, last4: '3636', nickname: 'Itau', institution: 'ITAU' },
      ]);
      prisma.crossProjectSettlement.findMany.mockResolvedValue([]);
    });

    it('parcela paga via paidParcelas SEM settlement: aparece REALIZADA, não vaza pro faltaPagar mas conta em saiuMes', async () => {
      prisma.expense.findMany.mockResolvedValue([target('[0,1,2,3]'), bankEspelho]);
      const res: any = await service.getAccountView(tenantId, projectId, '2026-07');
      const p2 = res.saidas.find((s: any) => s.id === `${TARGET2}#2`);
      const p3 = res.saidas.find((s: any) => s.id === `${TARGET2}#3`);
      expect(p2).toBeDefined();
      expect(p2.realizado).toBe(true);
      expect(p2.status).toBe('PAGO');
      expect(p2.valor).toBe(800000);
      expect(p2.origem).toEqual({ tipo: 'conta', bankLast4: '3636' });
      expect(p3).toBeDefined();
      expect(p3.realizado).toBe(true);
      // Já pagas: não pesam em faltaPagarMes...
      expect(res.faltaPagarMes).toBe(0);
      // ...mas o dinheiro não some: conta em saiuMes (2 parcelas de 8.000).
      expect(res.saiuMes).toBe(1600000);
    });

    it('parcela futura ainda não paga continua pendente normalmente (regressão zero)', async () => {
      prisma.expense.findMany.mockResolvedValue([target('[0,1,2,3]'), bankEspelho]);
      const res: any = await service.getAccountView(tenantId, projectId, '2026-08');
      const p4 = res.saidas.find((s: any) => s.id === `${TARGET2}#4`);
      expect(p4).toBeDefined();
      expect(p4.realizado).toBe(false);
      expect(p4.status).toBe('PLANEJADO');
      expect(res.faltaPagarMes).toBeGreaterThanOrEqual(800000);
    });

    it('parcela quitada por settlement continua suprimida mesmo com paidParcelas também marcado (dedupe intacto)', async () => {
      const mirror306 = {
        id: 'mirror-306', tenantId, projectId, tipoDespesa: 'MAO_DE_OBRA', titulo: 'Infra 306 parcela',
        fornecedor: 'Julio', valor: 800000, valorTotal: 800000, formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-06-08T00:00:00.000Z'), dataInicioParcela: null, quantidadeParcela: null,
        status: 'PAGO', cardLast4: null, bankLast4: '3636', importId: null,
        createdAt: new Date('2026-06-08T00:00:00.000Z'), linkedExpenseId: TARGET2,
        settledByExpenseId: null, settlesInvoiceKey: null, paidParcelas: null,
        project: { id: projectId, name: 'Pessoal', type: 'PESSOAL' },
      };
      prisma.expense.findMany.mockResolvedValue([target('[0]'), mirror306]);
      prisma.crossProjectSettlement.findMany.mockResolvedValue([
        { tenantId, targetExpenseId: TARGET2, parcelaIndex: 0, sourceExpenseId: 'mirror-306', realValor: 800000, plannedValor: 800000, plannedStatus: 'PLANEJADO' },
      ]);
      const res: any = await service.getAccountView(tenantId, projectId, '2026-06');
      const p0 = res.saidas.find((s: any) => s.id === `${TARGET2}#0`);
      expect(p0).toBeUndefined(); // suprimida pelo settlement — minha mudança não duplica
    });

    it('origin "none" (sem cartão/conta vinculados): parcela paga aparece realizada como carteira', async () => {
      // Sem espelho nenhum (nem bankEspelho) → classifyForeignOrigin cai em 'none'.
      prisma.expense.findMany.mockResolvedValue([target('[0]')]);
      const res: any = await service.getAccountView(tenantId, projectId, '2026-06');
      const p0 = res.saidas.find((s: any) => s.id === `${TARGET2}#0`);
      expect(p0).toBeDefined();
      expect(p0.realizado).toBe(true);
      expect(p0.status).toBe('PAGO');
      expect(p0.origem).toEqual({ tipo: 'carteira' });
    });
  });
});
