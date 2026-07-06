import { describe, it, expect } from 'vitest';
import {
  buildEmptyAssumptions,
  createScenarioFromAssumptions,
  clearScenarioValues,
} from './usePersonalPlanning';

describe('planning — novo plano nasce zerado', () => {
  it('buildEmptyAssumptions zera receitas, despesas, metas e crescimento', () => {
    const a = buildEmptyAssumptions(12);
    expect(a.monthlyIncomeCents).toBe(0);
    expect(a.monthlyExpenseCents).toBe(0);
    expect(a.targetMonthlySurplusCents).toBe(0);
    expect(a.incomeGrowthPct).toBe(0);
    expect(a.expenseGrowthPct).toBe(0);
    // Mantém as linhas de tipo de despesa (estrutura), todas em zero.
    expect(Object.keys(a.expenseByTypeCents).length).toBeGreaterThan(0);
    for (const v of Object.values(a.expenseByTypeCents)) expect(v).toBe(0);
  });

  it('monthsAhead é preservado (grade de meses) e clampeado a 3..36', () => {
    expect(buildEmptyAssumptions(24).monthsAhead).toBe(24);
    expect(buildEmptyAssumptions(1).monthsAhead).toBe(3);
    expect(buildEmptyAssumptions(99).monthsAhead).toBe(36);
  });

  it('createScenarioFromAssumptions com assumptions vazias → todos os meses e células em zero', () => {
    const s = createScenarioFromAssumptions('Novo', buildEmptyAssumptions(6), '2026-08');
    expect(s.name).toBe('Novo');
    expect(s.months.length).toBe(6);
    expect(s.months[0]).toBe('2026-08');
    // Nenhuma receita nem despesa em nenhum mês.
    for (const m of s.months) {
      expect(s.incomeByMonthCents[m]).toBe(0);
      const row = s.expenseByTypeByMonthCents[m] ?? {};
      for (const v of Object.values(row)) expect(v).toBe(0);
    }
    // Derivados também zerados.
    expect(s.assumptions.monthlyIncomeCents).toBe(0);
    expect(s.assumptions.monthlyExpenseCents).toBe(0);
    expect(s.assumptions.targetMonthlySurplusCents).toBe(0);
  });
});

describe('planning — limpar tudo (clearScenarioValues)', () => {
  it('zera entradas e despesas de todos os meses, mantendo meses e categorias', () => {
    // Cenário com valores em todas as células.
    const assumptions = buildEmptyAssumptions(3);
    assumptions.monthlyIncomeCents = 500_000;
    const codes = Object.keys(assumptions.expenseByTypeCents);
    for (const code of codes) assumptions.expenseByTypeCents[code] = 10_000;
    const s = createScenarioFromAssumptions('Cheio', assumptions, '2026-08');

    // Sanidade: começou com valores.
    expect(s.months.length).toBe(3);
    expect(s.incomeByMonthCents[s.months[0]!]).toBeGreaterThan(0);

    const cleared = clearScenarioValues(s);

    // Estrutura preservada.
    expect(cleared.months).toEqual(s.months);
    expect(cleared.expenseTypeOrder).toEqual(s.expenseTypeOrder);

    // Todos os valores zerados.
    for (const m of cleared.months) {
      expect(cleared.incomeByMonthCents[m]).toBe(0);
      const row = cleared.expenseByTypeByMonthCents[m] ?? {};
      expect(Object.keys(row).length).toBe(s.expenseTypeOrder.length);
      for (const v of Object.values(row)) expect(v).toBe(0);
    }

    // Derivados recomputados a zero.
    expect(cleared.assumptions.monthlyIncomeCents).toBe(0);
    expect(cleared.assumptions.monthlyExpenseCents).toBe(0);
  });
});
