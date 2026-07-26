import { describe, it, expect } from 'vitest';
import {
  PESSOAL_JOURNEY_CATALOG,
  foldLegacyStepOverrides,
  type StepOverride,
} from '../src/config/pessoal-journey';

describe('PESSOAL_JOURNEY_CATALOG', () => {
  it('contém funding exatamente uma vez', () => {
    const keys = PESSOAL_JOURNEY_CATALOG.map((s) => s.key);
    expect(keys.filter((k) => k === 'funding')).toHaveLength(1);
  });

  it('não contém bank nem card', () => {
    const keys = PESSOAL_JOURNEY_CATALOG.map((s) => s.key);
    expect(keys).not.toContain('bank');
    expect(keys).not.toContain('card');
  });

  it('funding possui fixedBranch com todos os campos obrigatórios', () => {
    const funding = PESSOAL_JOURNEY_CATALOG.find((s) => s.key === 'funding');
    expect(funding).toBeDefined();
    expect(funding!.fixedBranch).toMatchObject({
      conditionLabel: expect.any(String),
      ifTrue: expect.any(String),
      ifFalse: expect.any(String),
      rejoinsAt: 'receipt',
    });
  });

  it('funding.skippableByDefault = true', () => {
    const funding = PESSOAL_JOURNEY_CATALOG.find((s) => s.key === 'funding');
    expect(funding!.skippableByDefault).toBe(true);
  });
});

describe('foldLegacyStepOverrides', () => {
  it('override funding explícito vence e remove bank/card', () => {
    const overrides: StepOverride[] = [
      { key: 'bank', order: 1, enabled: true, skippable: false },
      { key: 'card', order: 2, enabled: true, skippable: true },
      { key: 'funding', order: 0, enabled: true, skippable: true, label: 'Override' },
    ];
    const result = foldLegacyStepOverrides(overrides);
    expect(result.filter((o) => o.key === 'bank')).toHaveLength(0);
    expect(result.filter((o) => o.key === 'card')).toHaveLength(0);
    expect(result.find((o) => o.key === 'funding')?.label).toBe('Override');
  });

  it('sem bank nem card, retorna overrides inalterados', () => {
    const overrides: StepOverride[] = [
      { key: 'expense', order: 3, enabled: true },
    ];
    expect(foldLegacyStepOverrides(overrides)).toEqual(overrides);
  });

  it('folding legado: order = min(bank.order, card.order)', () => {
    const overrides: StepOverride[] = [
      { key: 'bank', order: 3, enabled: true },
      { key: 'card', order: 1, enabled: true },
    ];
    const result = foldLegacyStepOverrides(overrides);
    expect(result.find((o) => o.key === 'funding')?.order).toBe(1);
  });

  it('folding legado: enabled = OR(bank.enabled, card.enabled)', () => {
    const cases: Array<[boolean, boolean, boolean]> = [
      [false, false, false],
      [true, false, true],
      [false, true, true],
      [true, true, true],
    ];
    for (const [be, ce, expected] of cases) {
      const result = foldLegacyStepOverrides([
        { key: 'bank', enabled: be },
        { key: 'card', enabled: ce },
      ]);
      expect(result.find((o) => o.key === 'funding')?.enabled).toBe(expected);
    }
  });

  it('folding legado: skippable = AND(bank.skippable, card.skippable)', () => {
    const cases: Array<[boolean, boolean, boolean]> = [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ];
    for (const [bs, cs, expected] of cases) {
      const result = foldLegacyStepOverrides([
        { key: 'bank', skippable: bs },
        { key: 'card', skippable: cs },
      ]);
      expect(result.find((o) => o.key === 'funding')?.skippable).toBe(expected);
    }
  });

  it('label/subtitle: primeiro override habilitado não-vazio (bank antes de card)', () => {
    const overrides: StepOverride[] = [
      { key: 'bank', enabled: true, label: 'Conta', subtitle: 'sub-bank' },
      { key: 'card', enabled: true, label: 'Cartão', subtitle: 'sub-card' },
    ];
    const result = foldLegacyStepOverrides(overrides);
    const f = result.find((o) => o.key === 'funding');
    expect(f?.label).toBe('Conta');
    expect(f?.subtitle).toBe('sub-bank');
  });

  it('label/subtitle: card usado quando bank está desabilitado', () => {
    const overrides: StepOverride[] = [
      { key: 'bank', enabled: false, label: 'Conta' },
      { key: 'card', enabled: true, label: 'Cartão', subtitle: 'sub-card' },
    ];
    const result = foldLegacyStepOverrides(overrides);
    const f = result.find((o) => o.key === 'funding');
    expect(f?.label).toBe('Cartão');
  });

  it('apenas bank presente: sintetiza funding com dados do bank', () => {
    const overrides: StepOverride[] = [
      { key: 'bank', order: 2, enabled: true, skippable: false },
    ];
    const result = foldLegacyStepOverrides(overrides);
    expect(result.find((o) => o.key === 'bank')).toBeUndefined();
    const f = result.find((o) => o.key === 'funding');
    expect(f).toMatchObject({ key: 'funding', order: 2, enabled: true, skippable: false });
  });

  it('jornadas não-PESSOAL: foldLegacyStepOverrides não altera listas sem bank/card', () => {
    const reforma: StepOverride[] = [{ key: 'expense', order: 1, enabled: true }];
    expect(foldLegacyStepOverrides(reforma)).toEqual(reforma);
  });

  it('linhas legadas tornam-se inertes após existir funding na lista', () => {
    const overrides: StepOverride[] = [
      { key: 'funding', enabled: true },
      { key: 'bank', enabled: true, label: 'Legado' },
      { key: 'card', enabled: true },
    ];
    const result = foldLegacyStepOverrides(overrides);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('funding');
    expect(result[0].label).toBeUndefined(); // funding original sem label
  });
});
