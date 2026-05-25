import { describe, it, expect } from 'vitest';
import { projectMonthlyExpenses, ProjectionGroup } from '../src/calculations/monthly-projection';

const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

const mkGroup = (id: string, total: number, entries: { data: string; valor: number }[]): ProjectionGroup => ({
  groupId: id,
  totalValor: total,
  entries,
  isMulti: entries.length > 1,
});

describe('projectMonthlyExpenses', () => {
  it('sem override: usa datas reais dos entries (Projetado == Real)', () => {
    const groups = [
      mkGroup('g1', 60000, [
        { data: '2026-01-10', valor: 10000 },
        { data: '2026-02-10', valor: 10000 },
        { data: '2026-03-10', valor: 10000 },
        { data: '2026-04-10', valor: 10000 },
        { data: '2026-05-10', valor: 10000 },
        { data: '2026-06-10', valor: 10000 },
      ]),
    ];
    const result = projectMonthlyExpenses({
      monthList: months,
      groups,
      excludes: new Set(),
      payConfigs: {},
    });

    expect(result['2026-01']).toBe(10000);
    expect(result['2026-06']).toBe(10000);
    expect(Object.values(result).reduce((s, v) => s + v, 0)).toBe(60000);
  });

  it('sem override: respeita gaps mensais (não redistribui)', () => {
    const groups = [
      mkGroup('g1', 30000, [
        { data: '2026-01-10', valor: 10000 },
        { data: '2026-03-10', valor: 10000 }, // pula fev
        { data: '2026-05-10', valor: 10000 },
      ]),
    ];
    const result = projectMonthlyExpenses({
      monthList: months,
      groups,
      excludes: new Set(),
      payConfigs: {},
    });
    expect(result['2026-01']).toBe(10000);
    expect(result['2026-02']).toBe(0);
    expect(result['2026-03']).toBe(10000);
    expect(result['2026-04']).toBe(0);
    expect(result['2026-05']).toBe(10000);
  });

  it('exclui despesas marcadas como excludes', () => {
    const groups = [
      mkGroup('keep', 10000, [{ data: '2026-01-10', valor: 10000 }]),
      mkGroup('skip', 50000, [{ data: '2026-01-10', valor: 50000 }]),
    ];
    const result = projectMonthlyExpenses({
      monthList: months,
      groups,
      excludes: new Set(['skip']),
      payConfigs: {},
    });
    expect(result['2026-01']).toBe(10000);
  });

  it('com payConfig.valor: redistribui o novo total nas parcelas originais', () => {
    const groups = [
      mkGroup('g1', 30000, [
        { data: '2026-01-10', valor: 10000 },
        { data: '2026-02-10', valor: 10000 },
        { data: '2026-03-10', valor: 10000 },
      ]),
    ];
    const result = projectMonthlyExpenses({
      monthList: months,
      groups,
      excludes: new Set(),
      payConfigs: { g1: { valor: '600.00' } }, // R$ 600 = 60000 cents
    });
    expect(result['2026-01']).toBe(20000);
    expect(result['2026-02']).toBe(20000);
    expect(result['2026-03']).toBe(20000);
  });

  it('com payConfig.parcelas: muda número de parcelas a partir do mês original', () => {
    const groups = [
      mkGroup('g1', 60000, [{ data: '2026-01-10', valor: 60000 }]),
    ];
    const result = projectMonthlyExpenses({
      monthList: months,
      groups,
      excludes: new Set(),
      payConfigs: { g1: { mode: 'parcelado', parcelas: '6' } },
    });
    expect(result['2026-01']).toBe(10000);
    expect(result['2026-06']).toBe(10000);
    expect(Object.values(result).reduce((s, v) => s + v, 0)).toBe(60000);
  });

  it('com payConfig.inicio: desloca para outro mês', () => {
    const groups = [
      mkGroup('g1', 30000, [{ data: '2026-01-10', valor: 30000 }]),
    ];
    const result = projectMonthlyExpenses({
      monthList: months,
      groups,
      excludes: new Set(),
      payConfigs: { g1: { mode: 'avista', inicio: '2026-04' } },
    });
    expect(result['2026-01']).toBe(0);
    expect(result['2026-04']).toBe(30000);
  });

  it('inclui extras avista no mês de início', () => {
    const result = projectMonthlyExpenses({
      monthList: months,
      groups: [],
      excludes: new Set(),
      payConfigs: {},
      extras: [{ valor: 500, mode: 'avista', parcelas: '1', inicio: '2026-03' }],
    });
    expect(result['2026-03']).toBe(50000);
  });

  it('inclui extras parcelados distribuídos a partir do início', () => {
    const result = projectMonthlyExpenses({
      monthList: months,
      groups: [],
      excludes: new Set(),
      payConfigs: {},
      extras: [{ valor: 600, mode: 'parcelado', parcelas: '3', inicio: '2026-02' }],
    });
    expect(result['2026-02']).toBe(20000);
    expect(result['2026-03']).toBe(20000);
    expect(result['2026-04']).toBe(20000);
  });

  it('arredondamento: resto vai para a última parcela', () => {
    const groups = [
      mkGroup('g1', 10000, [{ data: '2026-01-10', valor: 10000 }]),
    ];
    const result = projectMonthlyExpenses({
      monthList: months,
      groups,
      excludes: new Set(),
      payConfigs: { g1: { mode: 'parcelado', parcelas: '3' } },
    });
    // 10000 / 3 = 3333 (floor), resto = 1
    expect(result['2026-01']).toBe(3333);
    expect(result['2026-02']).toBe(3333);
    expect(result['2026-03']).toBe(3334);
    expect(result['2026-01'] + result['2026-02'] + result['2026-03']).toBe(10000);
  });
});
