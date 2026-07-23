import { describe, expect, it } from 'vitest';
import { buildOnboardingMariaPrompts } from './build-onboarding-maria-prompts';

describe('buildOnboardingMariaPrompts', () => {
  it('deriva o primeiro chip da categoria real da despesa', () => {
    expect(
      buildOnboardingMariaPrompts({ tipoDespesa: 'SUPERMERCADO', categoriaLabel: 'Supermercado' }),
    ).toEqual([
      'Quanto já gastei em Supermercado este mês?',
      'Como está meu caixa este mês?',
      'Onde meu dinheiro está indo?',
    ]);
  });

  it('omite o chip de categoria quando não há label', () => {
    expect(
      buildOnboardingMariaPrompts({ tipoDespesa: 'OUTROS', categoriaLabel: '' }),
    ).toEqual(['Como está meu caixa este mês?', 'Onde meu dinheiro está indo?']);
  });

  it('trata label só-espaços como ausente', () => {
    expect(
      buildOnboardingMariaPrompts({ tipoDespesa: 'OUTROS', categoriaLabel: '   ' }).length,
    ).toBe(2);
  });
});
