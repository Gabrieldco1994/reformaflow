import { describe, it, expect } from 'vitest';
import { hasFeature, ProjectType, projectTypeHasModule } from '../src';

describe('gating — feature "recurrences" no PESSOAL', () => {
  it('PESSOAL habilita capacidade "recurrences" (PROJECT_FEATURES)', () => {
    expect(hasFeature(ProjectType.PESSOAL, 'recurrences' as any)).toBe(true);
  });
  it('PESSOAL autoriza o módulo "recurrences" (TYPE_MODULES)', () => {
    expect(projectTypeHasModule('PESSOAL', 'recurrences')).toBe(true);
  });
  it('"recurrences" é distinto do catálogo "recurringBills" — só PESSOAL tem', () => {
    expect(hasFeature(ProjectType.PESSOAL, 'recurrences' as any)).toBe(true);
    expect(hasFeature(ProjectType.CASA, 'recurrences' as any)).toBe(false);
    expect(hasFeature(ProjectType.CARRO, 'recurrences' as any)).toBe(false);
    expect(hasFeature(ProjectType.REFORMA, 'recurrences' as any)).toBe(false);
  });
  it('não confunde os mapas: PESSOAL não ganha "recurringBills" de brinde', () => {
    expect(hasFeature(ProjectType.PESSOAL, 'recurringBills')).toBe(false);
    expect(projectTypeHasModule('PESSOAL', 'recurringBills')).toBe(false);
  });
});
