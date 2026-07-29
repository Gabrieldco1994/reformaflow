import { describe, expect, it } from 'vitest';
import {
  computeMovementTotals,
  groupByMovementDay,
  groupByMovementMonth,
  originLast4FromKey,
} from './_lib';
import type { AccountViewMovimentacao } from './_types';

describe('groupByMovementDay', () => {
  it('keeps the input order and groups movements with the same UTC date', () => {
    const groups = groupByMovementDay([
      { id: 'a', data: '2026-07-17T00:00:00.000Z' },
      { id: 'b', data: '2026-07-17T18:00:00.000Z' },
      { id: 'c', data: '2026-07-16T00:00:00.000Z' },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({ day: '2026-07-17', movements: [{ id: 'a', data: '2026-07-17T00:00:00.000Z' }, { id: 'b', data: '2026-07-17T18:00:00.000Z' }] }),
      expect.objectContaining({ day: '2026-07-16', movements: [{ id: 'c', data: '2026-07-16T00:00:00.000Z' }] }),
    ]);
    expect(groups[0]?.label).toContain('17');
  });
});

describe('groupByMovementMonth', () => {
  it('agrupa por mês UTC preservando a ordem de entrada (visão anual)', () => {
    const groups = groupByMovementMonth([
      { id: 'a', data: '2026-07-17T00:00:00.000Z' },
      { id: 'b', data: '2026-07-02T18:00:00.000Z' },
      { id: 'c', data: '2026-06-30T00:00:00.000Z' },
    ]);

    expect(groups.map((g) => g.day)).toEqual(['2026-07', '2026-06']);
    expect(groups[0]?.movements).toHaveLength(2);
    expect(groups[1]?.movements).toHaveLength(1);
    expect(groups[0]?.label).toContain('julho');
  });

  it('não perde nenhum item: a soma dos grupos é o total de itens', () => {
    const items = Array.from({ length: 24 }, (_, index) => ({
      id: `i-${index}`,
      data: `2026-${String((index % 12) + 1).padStart(2, '0')}-1${index % 9}T00:00:00.000Z`,
    }));
    const groups = groupByMovementMonth(items);
    expect(groups.reduce((sum, g) => sum + g.movements.length, 0)).toBe(items.length);
    expect(new Set(groups.map((g) => g.day)).size).toBe(12);
  });
});

describe('originLast4FromKey', () => {
  it('extrai o last4 da chave de origem do gráfico anual (card:/conta:)', () => {
    expect(originLast4FromKey('card:1234')).toBe('1234');
    expect(originLast4FromKey('conta:5678')).toBe('5678');
  });

  it('devolve null para chave ausente ou fora do formato', () => {
    expect(originLast4FromKey(null)).toBeNull();
    expect(originLast4FromKey('')).toBeNull();
    expect(originLast4FromKey('carteira')).toBeNull();
  });
});

function saida(overrides: Partial<AccountViewMovimentacao> = {}): AccountViewMovimentacao {
  return {
    kind: 'saida',
    id: 'exp-1',
    descricao: 'Mercado',
    data: '2026-03-10T00:00:00.000Z',
    forma: 'pix',
    valor: 10_000,
    realizado: true,
    status: 'PAGO',
    cardLast4: null,
    bankLast4: '1234',
    tipoDespesa: 'MERCADO',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    ...overrides,
  } as AccountViewMovimentacao;
}

function entrada(overrides: Partial<AccountViewMovimentacao> = {}): AccountViewMovimentacao {
  return {
    kind: 'entrada',
    id: 'rec-1',
    descricao: 'Salário',
    data: '2026-03-05T00:00:00.000Z',
    tipo: 'salario',
    valor: 500_000,
    bankLast4: '1234',
    status: 'EM_CAIXA',
    ...overrides,
  } as AccountViewMovimentacao;
}

describe('computeMovementTotals', () => {
  it('soma saídas, entradas em caixa e previstas — aporte fica fora do total de saídas', () => {
    const totals = computeMovementTotals([
      saida(),
      saida({ id: 'exp-2', valor: 7_000, tipoDespesa: 'INVESTIMENTOS' }),
      entrada(),
      entrada({ id: 'rec-2', valor: 30_000, status: 'PREVISTO' }),
    ]);

    expect(totals).toEqual({
      totalSaidas: 10_000,
      totalEntradasRecebido: 500_000,
      totalEntradasPrevisto: 30_000,
    });
  });

  it('INVARIANTE ano == soma dos 12 meses: totais do ano = soma dos totais mensais', () => {
    const meses = Array.from({ length: 12 }, (_, index) => {
      const mes = String(index + 1).padStart(2, '0');
      return [
        saida({ id: `exp-${mes}`, data: `2026-${mes}-10T00:00:00.000Z`, valor: 10_000 + index }),
        // Carteira (sem cartão/conta): regra de ouro 14 — conta no total igual.
        saida({
          id: `carteira-${mes}`,
          data: `2026-${mes}-11T00:00:00.000Z`,
          valor: 5_000,
          bankLast4: null,
        }),
        entrada({ id: `rec-${mes}`, data: `2026-${mes}-05T00:00:00.000Z`, valor: 500_000 }),
        entrada({
          id: `rec-prev-${mes}`,
          data: `2026-${mes}-25T00:00:00.000Z`,
          valor: 20_000,
          status: 'PREVISTO',
        }),
      ];
    });

    const somaDosMeses = meses
      .map((items) => computeMovementTotals(items))
      .reduce(
        (acc, totals) => ({
          totalSaidas: acc.totalSaidas + totals.totalSaidas,
          totalEntradasRecebido: acc.totalEntradasRecebido + totals.totalEntradasRecebido,
          totalEntradasPrevisto: acc.totalEntradasPrevisto + totals.totalEntradasPrevisto,
        }),
        { totalSaidas: 0, totalEntradasRecebido: 0, totalEntradasPrevisto: 0 },
      );

    expect(computeMovementTotals(meses.flat())).toEqual(somaDosMeses);
  });
});

describe('groupByMovementDay — o mês não regride', () => {
  it('continua agrupando por dia depois da extração do agrupamento mensal', () => {
    const groups = groupByMovementDay([
      { id: 'a', data: '2026-07-17T00:00:00.000Z' },
      { id: 'b', data: '2026-07-16T00:00:00.000Z' },
    ]);
    expect(groups.map((g) => g.day)).toEqual(['2026-07-17', '2026-07-16']);
  });
});
