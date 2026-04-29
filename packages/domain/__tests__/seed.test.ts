import { describe, it, expect } from 'vitest';
import { roomWorkTypeMatrix, TOTAL_BUDGET_ITEMS, defaultContractorMilestones } from '../src/seed';

describe('roomWorkTypeMatrix (seed)', () => {
  it('contém 14 ambientes', () => {
    expect(roomWorkTypeMatrix).toHaveLength(14);
  });

  it('gera exatamente 87 BudgetItems (como na planilha)', () => {
    expect(TOTAL_BUDGET_ITEMS).toBe(87);
  });

  it('Cozinha tem 9 tipos de obra', () => {
    const cozinha = roomWorkTypeMatrix.find(r => r.name === 'Cozinha');
    expect(cozinha?.workTypes).toHaveLength(9);
  });

  it('Hall/Corredor tem 4 tipos de obra', () => {
    const hall = roomWorkTypeMatrix.find(r => r.name === 'Hall/Corredor');
    expect(hall?.workTypes).toHaveLength(4);
  });

  it('Geral (casa toda) tem 4 tipos: Esquadrias, Mão de obra, Taxas, Contingência', () => {
    const geral = roomWorkTypeMatrix.find(r => r.name === 'Geral (casa toda)');
    expect(geral?.workTypes).toHaveLength(4);
  });
});

describe('defaultContractorMilestones', () => {
  it('contém 4 marcos de pagamento', () => {
    expect(defaultContractorMilestones).toHaveLength(4);
  });

  it('percentuais somam 100%', () => {
    const total = defaultContractorMilestones.reduce((s, m) => s + m.percentage, 0);
    expect(total).toBeCloseTo(1.0);
  });
});
