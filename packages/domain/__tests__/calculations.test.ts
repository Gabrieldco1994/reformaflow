import { describe, it, expect } from 'vitest';
import {
  calculateBalance,
  calculatePercentConsumed,
  calculateBudgetStatus,
  calculateReleasedAmount,
  calculateRollingBalance,
  calculateActual,
  calculateContingencySuggestion,
  computeCashFlowEntries,
} from '../src/calculations';
import { BudgetStatus, CashFlowType, CashFlowStatus } from '../src/enums';
import type { CashFlowEntry } from '../src/types';

describe('calculateBalance', () => {
  it('retorna saldo positivo quando previsto > realizado', () => {
    expect(calculateBalance(10000, 3000)).toBe(7000);
  });

  it('retorna saldo negativo quando realizado > previsto (estourado)', () => {
    expect(calculateBalance(5000, 7000)).toBe(-2000);
  });

  it('retorna zero quando previsto = realizado', () => {
    expect(calculateBalance(5000, 5000)).toBe(0);
  });

  it('retorna zero quando ambos são zero', () => {
    expect(calculateBalance(0, 0)).toBe(0);
  });
});

describe('calculatePercentConsumed', () => {
  it('calcula percentual corretamente', () => {
    expect(calculatePercentConsumed(10000, 8000)).toBe(0.8);
  });

  it('retorna 0 quando previsto é zero (proteção divisão por zero)', () => {
    expect(calculatePercentConsumed(0, 5000)).toBe(0);
  });

  it('retorna > 1 quando estourado', () => {
    expect(calculatePercentConsumed(5000, 6000)).toBe(1.2);
  });

  it('retorna 0 quando realizado é zero', () => {
    expect(calculatePercentConsumed(10000, 0)).toBe(0);
  });
});

describe('calculateBudgetStatus', () => {
  it('retorna "-" quando previsto é zero', () => {
    expect(calculateBudgetStatus(0, 0)).toBe('-');
    expect(calculateBudgetStatus(0, 1000)).toBe('-');
  });

  it('retorna OVER_BUDGET quando % > 100%', () => {
    expect(calculateBudgetStatus(5000, 5001)).toBe(BudgetStatus.OVER_BUDGET);
    expect(calculateBudgetStatus(1000, 2000)).toBe(BudgetStatus.OVER_BUDGET);
  });

  it('retorna WARNING quando 80% <= % <= 100%', () => {
    expect(calculateBudgetStatus(10000, 8000)).toBe(BudgetStatus.WARNING);
    expect(calculateBudgetStatus(10000, 9500)).toBe(BudgetStatus.WARNING);
    expect(calculateBudgetStatus(10000, 10000)).toBe(BudgetStatus.WARNING);
  });

  it('retorna OK quando % < 80%', () => {
    expect(calculateBudgetStatus(10000, 7999)).toBe(BudgetStatus.OK);
    expect(calculateBudgetStatus(10000, 0)).toBe(BudgetStatus.OK);
    expect(calculateBudgetStatus(10000, 5000)).toBe(BudgetStatus.OK);
  });
});

describe('calculateReleasedAmount', () => {
  it('calcula valor liberado corretamente', () => {
    expect(calculateReleasedAmount(20000, 0.3)).toBeCloseTo(6000);
  });

  it('retorna 0 quando % concluído é 0', () => {
    expect(calculateReleasedAmount(20000, 0)).toBe(0);
  });

  it('retorna valor total quando 100% concluído', () => {
    expect(calculateReleasedAmount(20000, 1)).toBe(20000);
  });
});

describe('calculateRollingBalance', () => {
  it('calcula saldo acumulado com entradas e saídas', () => {
    const entries = [
      { type: CashFlowType.INCOME, amount: 30000 },
      { type: CashFlowType.EXPENSE, amount: 5000 },
      { type: CashFlowType.EXPENSE, amount: 3000 },
      { type: CashFlowType.INCOME, amount: 10000 },
    ];
    expect(calculateRollingBalance(entries)).toEqual([30000, 25000, 22000, 32000]);
  });

  it('retorna array vazio para lista vazia', () => {
    expect(calculateRollingBalance([])).toEqual([]);
  });

  it('pode resultar em saldo negativo', () => {
    const entries = [
      { type: CashFlowType.EXPENSE, amount: 5000 },
      { type: CashFlowType.EXPENSE, amount: 3000 },
    ];
    expect(calculateRollingBalance(entries)).toEqual([-5000, -8000]);
  });
});

describe('computeCashFlowEntries', () => {
  it('adiciona rollingBalance a cada entrada', () => {
    const entries: CashFlowEntry[] = [
      {
        id: '1', projectId: 'p1', roomId: null, workTypeId: null,
        plannedDate: new Date(), effectiveDate: null,
        description: 'Aporte', type: CashFlowType.INCOME,
        amount: 30000, status: CashFlowStatus.EXECUTED,
        createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      },
      {
        id: '2', projectId: 'p1', roomId: null, workTypeId: null,
        plannedDate: new Date(), effectiveDate: null,
        description: 'Pagamento empreiteiro', type: CashFlowType.EXPENSE,
        amount: 6000, status: CashFlowStatus.EXECUTED,
        createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      },
    ];
    const result = computeCashFlowEntries(entries);
    expect(result[0]!.rollingBalance).toBe(30000);
    expect(result[1]!.rollingBalance).toBe(24000);
  });
});

describe('calculateActual', () => {
  it('soma purchases e milestones', () => {
    expect(calculateActual(3500, 6000)).toBe(9500);
  });

  it('retorna 0 quando ambos são 0', () => {
    expect(calculateActual(0, 0)).toBe(0);
  });
});

describe('calculateContingencySuggestion', () => {
  it('sugere 15% por padrão', () => {
    expect(calculateContingencySuggestion(100000)).toBe(15000);
  });

  it('limita mínimo em 10%', () => {
    expect(calculateContingencySuggestion(100000, 0.05)).toBe(10000);
  });

  it('limita máximo em 20%', () => {
    expect(calculateContingencySuggestion(100000, 0.30)).toBe(20000);
  });
});
