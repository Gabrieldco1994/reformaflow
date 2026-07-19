import { describe, expect, it } from 'vitest';
import { buildPlanPayloads } from './useGenerateReceiptsPlan';

describe('buildPlanPayloads', () => {
  it('quebra o salário em adiantamento (dia 15) e fechamento (dia 30)', () => {
    const payloads = buildPlanPayloads({
      salary: 10_000,
      day15Pct: 40,
      months: 1,
      startMonth: '2026-06',
      dividends: 0,
      fixedIncome: 0,
    });

    expect(payloads).toEqual([
      { valor: 4_000, data: '2026-06-15', tipo: 'ADIANTAMENTO_SALARIO', status: 'PREVISTO' },
      { valor: 6_000, data: '2026-06-30', tipo: 'SALARIO', status: 'PREVISTO' },
    ]);
  });

  it('limita o dia ao último dia do mês (clamp de fevereiro)', () => {
    const payloads = buildPlanPayloads({
      salary: 5_000,
      day15Pct: 0,
      months: 1,
      startMonth: '2026-02',
      dividends: 0,
      fixedIncome: 0,
    });

    // day15Pct 0 → sem adiantamento; fechamento (100%) no dia 30 vira 28 (2026 não bissexto).
    expect(payloads).toEqual([
      { valor: 5_000, data: '2026-02-28', tipo: 'SALARIO', status: 'PREVISTO' },
    ]);
  });

  it('rola para o ano seguinte ao atravessar dezembro', () => {
    const payloads = buildPlanPayloads({
      salary: 0,
      day15Pct: 0,
      months: 2,
      startMonth: '2026-12',
      dividends: 1_000,
      fixedIncome: 0,
    });

    expect(payloads.map((p) => p.data)).toEqual(['2026-12-30', '2027-01-30']);
    expect(payloads.every((p) => p.tipo === 'DIVIDENDOS')).toBe(true);
  });

  it('inclui dividendos e juros de renda fixa junto do salário', () => {
    const payloads = buildPlanPayloads({
      salary: 8_000,
      day15Pct: 50,
      months: 1,
      startMonth: '2026-03',
      dividends: 500,
      fixedIncome: 250,
    });

    expect(payloads).toEqual([
      { valor: 4_000, data: '2026-03-15', tipo: 'ADIANTAMENTO_SALARIO', status: 'PREVISTO' },
      { valor: 4_000, data: '2026-03-30', tipo: 'SALARIO', status: 'PREVISTO' },
      { valor: 500, data: '2026-03-30', tipo: 'DIVIDENDOS', status: 'PREVISTO' },
      { valor: 250, data: '2026-03-30', tipo: 'JUROS_RENDA_FIXA', status: 'PREVISTO' },
    ]);
  });

  it('retorna vazio quando não há nenhuma renda', () => {
    expect(
      buildPlanPayloads({
        salary: 0,
        day15Pct: 40,
        months: 12,
        startMonth: '2026-06',
        dividends: 0,
        fixedIncome: 0,
      }),
    ).toEqual([]);
  });

  it('clampa meses < 1 para gerar ao menos um mês', () => {
    const payloads = buildPlanPayloads({
      salary: 0,
      day15Pct: 0,
      months: 0,
      startMonth: '2026-06',
      dividends: 1_000,
      fixedIncome: 0,
    });
    expect(payloads).toHaveLength(1);
  });
});
