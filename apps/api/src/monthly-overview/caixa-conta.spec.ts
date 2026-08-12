import {
  computeCaixaConta,
  type CaixaContaAccount,
  type CaixaContaExpense,
  type CaixaContaReceipt,
} from './monthly-overview.service';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('computeCaixaConta — reconciliação §10', () => {
  it('caixa hoje = saldo inicial + lançamentos realizados da conta (resgate entra, aplicação sai, futuro fora)', () => {
    const accounts: CaixaContaAccount[] = [
      { openingBalanceCents: 1_428_597, openingBalanceDate: d('2025-12-31') }, // R$ 14.285,97
    ];
    // Apenas lançamentos com bankLast4 (o chamador já filtra). Sinais: despesa −, recebimento +.
    const expenses: CaixaContaExpense[] = [
      { valorTotal: 7_925_000, status: 'PAGO', dataPagamento: d('2026-03-10'), createdAt: d('2026-03-10') }, // aplicação −79.250
      { valorTotal: 5_000_000, status: 'PAGO', dataPagamento: d('2026-02-01'), createdAt: d('2026-02-01') }, // despesa qualquer −50.000
      { valorTotal: 2_500, status: 'PLANEJADO', dataPagamento: d('2026-07-03'), createdAt: d('2026-06-01') }, // SEGURO futuro −25 (NÃO entra)
    ];
    const receipts: CaixaContaReceipt[] = [
      { valor: 5_665_303, status: 'EM_CAIXA', data: d('2026-02-11') }, // RESGATE CDB DI +56.653,03
      { valor: 8_000_000, status: 'EM_CAIXA', data: d('2026-02-27') }, // salário +80.000
      { valor: 1_000_000, status: 'PREVISTO', data: d('2026-06-30') }, // previsto +10.000 (NÃO entra)
    ];

    const r = computeCaixaConta(accounts, expenses, receipts);

    // 14.285,97 − 79.250 − 50.000 + 56.653,03 + 80.000 = 21.689,00
    expect(r.hoje).toBe(1_428_597 - 7_925_000 - 5_000_000 + 5_665_303 + 8_000_000);
    expect(r.hoje).toBe(2_168_900);
    expect(r.saldoInicial).toBe(1_428_597);
    expect(r.temSaldoInicial).toBe(true);
  });

  it('série porMes é acumulada e parte do saldo inicial; ignora não-realizados', () => {
    const accounts: CaixaContaAccount[] = [{ openingBalanceCents: 100_000, openingBalanceDate: d('2025-12-31') }];
    const expenses: CaixaContaExpense[] = [
      { valorTotal: 30_000, status: 'PAGO', dataPagamento: d('2026-02-10'), createdAt: d('2026-02-10') },
    ];
    const receipts: CaixaContaReceipt[] = [
      { valor: 50_000, status: 'EM_CAIXA', data: d('2026-01-15') },
      { valor: 90_000, status: 'PREVISTO', data: d('2026-03-15') }, // ignorado
    ];

    const r = computeCaixaConta(accounts, expenses, receipts);

    expect(r.porMes).toEqual([
      { mes: '2026-01', caixa: 150_000 }, // 100k + 50k
      { mes: '2026-02', caixa: 120_000 }, // − 30k
    ]);
    expect(r.hoje).toBe(120_000);
  });

  it('deduz somente paidParcelas de um parcelado e usa a data efetiva no porMes', () => {
    const r = computeCaixaConta(
      [{ openingBalanceCents: 1_000_000, openingBalanceDate: d('2026-01-01') }],
      [
        {
          valorTotal: 360_000,
          status: 'PLANEJADO',
          formaPagamento: 'PARCELADO',
          quantidadeParcela: 6,
          dataInicioParcela: d('2026-06-10'),
          dataPagamento: null,
          paidParcelas: '[0]',
          installmentDateOverrides: '{"0":"2026-07-20"}',
          createdAt: d('2026-05-01'),
        },
      ],
      [],
    );

    expect(r.hoje).toBe(940_000);
    expect(r.porMes).toEqual([{ mes: '2026-07', caixa: 940_000 }]);
  });

  // Relógio fixo: os testes de corte por "hoje" precisam de uma âncora determinística
  // (rule #22 do repo — data fixa + filtro por new Date() = bomba-relógio no CI em UTC).
  // Injetamos `today` no 4º parâmetro de computeCaixaConta em vez de depender do relógio real.
  const HOJE = d('2026-08-11');

  // BUG §10 (caixa real): para PARCELADO/QUINZENAL, `status:'PAGO'` no root distribuía
  // TODAS as parcelas — inclusive as futuras — no caixa realizado, sem nenhuma evidência
  // bancária de que saíram da conta. A expectativa ANTIGA deste teste (hoje = -360.000 e
  // porMes com 6 meses, incluindo futuros) CODIFICAVA o bug como correto. O caixa "hoje" é
  // saldo REALIZADO (docs/cockpit-caixa-real.md §10): só entra a ocorrência com data <= hoje.
  it('root PAGO NÃO realiza parcelas futuras — reproduz o dreno de R$3.600 em vez de R$600', () => {
    // Repro exato do PO: despesa bancária R$3.600 em 6×, só a 1ª parcela debitada,
    // root marcado PAGO. Com início em 01/08 e hoje 11/08, só a parcela 08-01 já caiu.
    const r = computeCaixaConta(
      [{ openingBalanceCents: 0, openingBalanceDate: d('2026-01-01') }],
      [
        {
          valorTotal: 360_000, // R$3.600
          status: 'PAGO',
          formaPagamento: 'PARCELADO',
          quantidadeParcela: 6, // R$600 por parcela
          dataInicioParcela: d('2026-08-01'),
          dataPagamento: null,
          paidParcelas: null,
          installmentDateOverrides: null,
          createdAt: d('2026-07-01'),
        },
      ],
      [],
      HOJE,
    );

    // Só a 1ª parcela (08-01 <= 08-11) é realizada: caixa cai R$600, não R$3.600.
    expect(r.hoje).toBe(-60_000);
    expect(r.porMes).toEqual([{ mes: '2026-08', caixa: -60_000 }]);
  });

  it('root PAGO: parcelas passadas entram, futuras ficam de fora do porMes (histórico permanece)', () => {
    // Início 10/06, mensal, hoje 11/08 → realizadas: 06-10, 07-10, 08-10 (3 de 6).
    // As parcelas 09-10, 10-10, 11-10 são FUTURAS: não entram em `hoje` nem no sparkline.
    const r = computeCaixaConta(
      [{ openingBalanceCents: 0, openingBalanceDate: d('2026-01-01') }],
      [
        {
          valorTotal: 360_000,
          status: 'PAGO',
          formaPagamento: 'PARCELADO',
          quantidadeParcela: 6,
          dataInicioParcela: d('2026-06-10'),
          dataPagamento: null,
          paidParcelas: null,
          installmentDateOverrides: null,
          createdAt: d('2026-05-01'),
        },
      ],
      [],
      HOJE,
    );

    expect(r.hoje).toBe(-180_000); // 3 × -60.000
    expect(r.porMes).toEqual([
      { mes: '2026-06', caixa: -60_000 },
      { mes: '2026-07', caixa: -120_000 },
      { mes: '2026-08', caixa: -180_000 },
    ]);
  });

  it('QUINZENAL root PAGO não drena o caixa por quinzenas futuras (mão de obra REFORMA R$8.000/quinzena)', () => {
    // Cenário medido em produção: série quinzenal de R$8.000 com root PAGO drenava o caixa
    // por quinzenas sem movimento correspondente no extrato. Início 20/07, hoje 11/08 →
    // realizadas: 20/07 e 04/08; 19/08, 03/09, 18/09, 03/10 são futuras.
    const r = computeCaixaConta(
      [{ openingBalanceCents: 0, openingBalanceDate: d('2026-01-01') }],
      [
        {
          valorTotal: 4_800_000, // 6 × R$8.000
          status: 'PAGO',
          formaPagamento: 'QUINZENAL',
          quantidadeParcela: 6,
          dataInicioParcela: d('2026-07-20'),
          dataPagamento: null,
          paidParcelas: null,
          installmentDateOverrides: null,
          createdAt: d('2026-07-01'),
        },
      ],
      [],
      HOJE,
    );

    expect(r.hoje).toBe(-1_600_000); // 2 × -800.000, não -4.800.000
    expect(r.porMes).toEqual([
      { mes: '2026-07', caixa: -800_000 },
      { mes: '2026-08', caixa: -1_600_000 },
    ]);
  });

  it('despesa simples PAGO com data futura NÃO entra no caixa de hoje; a passada entra', () => {
    const r = computeCaixaConta(
      [{ openingBalanceCents: 500_000, openingBalanceDate: d('2026-01-01') }],
      [
        // PAGO no futuro (agendado): ainda não saiu do banco → fora do caixa realizado.
        { valorTotal: 100_000, status: 'PAGO', dataPagamento: d('2026-12-25'), createdAt: d('2026-08-01') },
        // PAGO no passado: entra normalmente.
        { valorTotal: 30_000, status: 'PAGO', dataPagamento: d('2026-07-05'), createdAt: d('2026-07-05') },
      ],
      [],
      HOJE,
    );

    expect(r.hoje).toBe(500_000 - 30_000); // 470.000 — a futura de 100.000 NÃO conta
    expect(r.porMes).toEqual([{ mes: '2026-07', caixa: 470_000 }]);
  });

  it('recebimento EM_CAIXA com data futura NÃO entra no caixa de hoje', () => {
    const r = computeCaixaConta(
      [{ openingBalanceCents: 0, openingBalanceDate: d('2026-01-01') }],
      [],
      [
        { valor: 100_000, status: 'EM_CAIXA', data: d('2026-12-25') }, // futuro: não creditou ainda
        { valor: 20_000, status: 'EM_CAIXA', data: d('2026-06-01') }, // passado: entra
      ],
      HOJE,
    );

    expect(r.hoje).toBe(20_000); // só o crédito passado
    expect(r.porMes).toEqual([{ mes: '2026-06', caixa: 20_000 }]);
  });

  it('paidParcelas é evidência explícita: parcela marcada paga conta mesmo com data futura', () => {
    // Distinção do fix: root PAGO é fraco (sem evidência por-parcela) e é cortado por hoje;
    // paidParcelas é a afirmação manual de que o dinheiro saiu — respeitada mesmo se datada
    // no futuro (pré-pagamento). Aqui a parcela 0 (futura, 20/12) está em paidParcelas.
    const r = computeCaixaConta(
      [{ openingBalanceCents: 1_000_000, openingBalanceDate: d('2026-01-01') }],
      [
        {
          valorTotal: 360_000,
          status: 'PLANEJADO',
          formaPagamento: 'PARCELADO',
          quantidadeParcela: 6,
          dataInicioParcela: d('2026-08-01'),
          dataPagamento: null,
          paidParcelas: '[0]',
          installmentDateOverrides: '{"0":"2026-12-20"}',
          createdAt: d('2026-07-01'),
        },
      ],
      [],
      HOJE,
    );

    expect(r.hoje).toBe(940_000); // 1.000.000 − 60.000 (parcela 0 paga, ainda que datada 12/20)
    expect(r.porMes).toEqual([{ mes: '2026-12', caixa: 940_000 }]);
  });

  it('mantém despesas de pagamento único como um movimento integral', () => {
    const r = computeCaixaConta(
      [{ openingBalanceCents: 500_000, openingBalanceDate: d('2026-01-01') }],
      [
        {
          valorTotal: 360_000,
          status: 'PAGO',
          formaPagamento: 'A_VISTA',
          quantidadeParcela: null,
          dataInicioParcela: null,
          dataPagamento: d('2026-06-10'),
          paidParcelas: '[0]',
          installmentDateOverrides: '{"0":"2026-07-20"}',
          createdAt: d('2026-05-01'),
        },
      ],
      [],
    );

    expect(r.hoje).toBe(140_000);
    expect(r.porMes).toEqual([{ mes: '2026-06', caixa: 140_000 }]);
  });

  it('INVARIANTE I1: aporte (INVESTIMENTOS) PAGO pela conta REDUZ o caixa hoje — neutro-de-consumo NÃO altera §10', () => {
    // computeCaixaConta é type-agnóstico: soma TODA despesa PAGO da conta como saída,
    // sem olhar tipoDespesa/neutralidade. Marcar INVESTIMENTOS neutro-de-consumo no
    // cockpit NÃO pode mudar isto — o dinheiro saiu do checking.
    const r = computeCaixaConta(
      [{ openingBalanceCents: 20_000_000, openingBalanceDate: d('2026-01-01') }],
      [{ valorTotal: 11_249_094, status: 'PAGO', dataPagamento: d('2026-06-05'), createdAt: d('2026-06-05') }],
      [],
    );
    expect(r.hoje).toBe(20_000_000 - 11_249_094); // 8.750.906 — caixa CAI
  });

  it('INVARIANTE: resgate (RESGATE) EM_CAIXA AUMENTA o caixa hoje (crédito real na conta)', () => {
    const r = computeCaixaConta(
      [{ openingBalanceCents: 0, openingBalanceDate: d('2026-01-01') }],
      [],
      [{ valor: 11_322_065, status: 'EM_CAIXA', data: d('2026-06-20') }],
    );
    expect(r.hoje).toBe(11_322_065);
  });
});
