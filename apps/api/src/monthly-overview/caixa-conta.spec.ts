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
