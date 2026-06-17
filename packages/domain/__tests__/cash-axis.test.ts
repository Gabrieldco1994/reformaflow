import { describe, it, expect } from 'vitest';
import { buildCashAxis, type CashAxisEntry, type CardConfig } from '../src';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

const cards: CardConfig[] = [
  { last4: '1234', closingDay: 28, dueDay: 7 }, // fecha 28, vence 07 (mês seguinte)
];

describe('buildCashAxis', () => {
  it('compra de cartão cai no mês de VENCIMENTO, não no mês da compra', () => {
    const entries: CashAxisEntry[] = [
      { tipo: 'DESPESA', categoria: 'COMPRAS_VAREJO', valor: 10000, data: utc(2026, 1, 15), cardLast4: '1234' },
    ];
    const out = buildCashAxis(entries, cards);
    // compra 15/jan fecha 28/jan, vence 07/fev → caixa em 2026-02
    expect(out.porMes['2026-02']?.faturaCartao).toBe(10000);
    expect(out.porMes['2026-02']?.total).toBe(10000);
    expect(out.porMes['2026-01']).toBeUndefined();
  });

  it('pagamento de fatura (categoria neutra) NÃO é contado (evita dupla contagem)', () => {
    const entries: CashAxisEntry[] = [
      { tipo: 'DESPESA', categoria: 'PAGAMENTO_FATURA_CARTAO', valor: 50000, data: utc(2026, 2, 7), cardLast4: null },
    ];
    const out = buildCashAxis(entries, cards);
    expect(out.porMes['2026-02']).toBeUndefined();
  });

  it('MOVIMENTACAO_INTERNA (neutra) NÃO é contada', () => {
    const entries: CashAxisEntry[] = [
      { tipo: 'DESPESA', categoria: 'MOVIMENTACAO_INTERNA', valor: 30000, data: utc(2026, 2, 1), cardLast4: null },
    ];
    const out = buildCashAxis(entries, cards);
    expect(out.porMes['2026-02']).toBeUndefined();
  });

  it('débito de conta (sem cartão) permanece na COMPETÊNCIA', () => {
    const entries: CashAxisEntry[] = [
      { tipo: 'DESPESA', categoria: 'AGUA', valor: 8000, data: utc(2026, 1, 20), cardLast4: null },
    ];
    const out = buildCashAxis(entries, cards);
    expect(out.porMes['2026-01']?.debitos).toBe(8000);
    expect(out.porMes['2026-01']?.faturaCartao).toBe(0);
    expect(out.porMes['2026-01']?.total).toBe(8000);
  });

  it('combina fatura de cartão e débito de conta no mesmo mês de caixa', () => {
    const entries: CashAxisEntry[] = [
      // cartão: compra 15/jan → vence fev
      { tipo: 'DESPESA', categoria: 'COMPRAS_VAREJO', valor: 10000, data: utc(2026, 1, 15), cardLast4: '1234' },
      // conta: competência fev
      { tipo: 'DESPESA', categoria: 'AGUA', valor: 8000, data: utc(2026, 2, 3), cardLast4: null },
    ];
    const out = buildCashAxis(entries, cards);
    expect(out.porMes['2026-02']?.faturaCartao).toBe(10000);
    expect(out.porMes['2026-02']?.debitos).toBe(8000);
    expect(out.porMes['2026-02']?.total).toBe(18000);
  });

  it('cartão sem configuração de fechamento cai na competência mas conta como fatura', () => {
    const entries: CashAxisEntry[] = [
      { tipo: 'DESPESA', categoria: 'COMPRAS_VAREJO', valor: 5000, data: utc(2026, 4, 10), cardLast4: '9999' },
    ];
    const out = buildCashAxis(entries, []); // nenhum cartão configurado
    expect(out.porMes['2026-04']?.faturaCartao).toBe(5000);
  });

  it('ignora RECEBIMENTOS (cash-axis é eixo de saídas)', () => {
    const entries: CashAxisEntry[] = [
      { tipo: 'RECEBIMENTO', categoria: null, valor: 100000, data: utc(2026, 2, 1), cardLast4: null },
    ];
    const out = buildCashAxis(entries, cards);
    expect(out.porMes['2026-02']).toBeUndefined();
  });

  it('produz detalhamento por cartão para o tooltip (qual fatura)', () => {
    const entries: CashAxisEntry[] = [
      { tipo: 'DESPESA', categoria: 'COMPRAS_VAREJO', valor: 10000, data: utc(2026, 1, 15), cardLast4: '1234', parcela: '1/3', subcategoria: 'Loja X' },
    ];
    const out = buildCashAxis(entries, cards);
    expect(out.detalhePorCartao).toContainEqual({
      mes: '2026-02',
      cardLast4: '1234',
      valor: 10000,
      itens: [{ descricao: 'Loja X', parcela: '1/3', valor: 10000 }],
    });
  });
});
