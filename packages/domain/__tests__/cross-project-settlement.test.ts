import { describe, it, expect } from 'vitest';
import {
  parsePaidParcelas,
  sumSettlementDeltas,
  effectiveValorTotal,
  applyParcelaOverrides,
} from '../src';

describe('parsePaidParcelas', () => {
  it('retorna [] para null/undefined/JSON inválido', () => {
    expect(parsePaidParcelas(null, 3)).toEqual([]);
    expect(parsePaidParcelas(undefined, 3)).toEqual([]);
    expect(parsePaidParcelas('not-json', 3)).toEqual([]);
    expect(parsePaidParcelas('{"a":1}', 3)).toEqual([]);
  });

  it('aceita só inteiros no range [0,n), sem duplicados, ordenados', () => {
    expect(parsePaidParcelas('[2,0,0,1]', 3)).toEqual([0, 1, 2]);
    expect(parsePaidParcelas('[3,5,-1,1]', 3)).toEqual([1]); // 3,5,-1 fora do range
    expect(parsePaidParcelas('[1.5,"x",2]', 3)).toEqual([2]); // não-inteiros descartados
  });
});

describe('sumSettlementDeltas', () => {
  it('soma (real − planned) de cada liquidação', () => {
    expect(sumSettlementDeltas([])).toBe(0);
    expect(
      sumSettlementDeltas([
        { realValor: 11000, plannedValor: 10000 }, // +1000
        { realValor: 9500, plannedValor: 10000 }, // -500
      ]),
    ).toBe(500);
  });
});

describe('effectiveValorTotal', () => {
  it('valor efetivo = planejado + Σ deltas (real substitui planejado por parcela)', () => {
    // alvo planejado 30000 (3x 10000); parcela 0 real = 11000
    expect(
      effectiveValorTotal(30000, [{ realValor: 11000, plannedValor: 10000 }]),
    ).toBe(31000);
  });

  it('sem liquidações, efetivo == planejado', () => {
    expect(effectiveValorTotal(30000, [])).toBe(30000);
  });
});

describe('applyParcelaOverrides', () => {
  it('substitui o valor das parcelas liquidadas, preservando as demais', () => {
    const planned = [10000, 10000, 10000];
    const out = applyParcelaOverrides(planned, { 0: 11000 });
    expect(out).toEqual([11000, 10000, 10000]);
    // não muta o array original
    expect(planned).toEqual([10000, 10000, 10000]);
  });

  it('ignora índices fora do range', () => {
    const out = applyParcelaOverrides([10000, 10000], { 5: 999, 0: 12000 });
    expect(out).toEqual([12000, 10000]);
  });

  it('aceita Map como overrides', () => {
    const out = applyParcelaOverrides([100, 100, 100], new Map([[1, 250]]));
    expect(out).toEqual([100, 250, 100]);
  });
});
