import { describe, expect, it } from 'vitest';
import { ProjectType } from '../src/enums';
import {
  ONBOARDING_JOURNEY_DEFAULTS,
  resolveJourney,
} from '../src/config/onboarding-journey';

describe('resolveJourney', () => {
  it('sem nenhum override devolve a jornada padrão do tipo, na ordem do catálogo', () => {
    const resolved = resolveJourney(ProjectType.PESSOAL);
    expect(resolved.map((s) => s.key)).toEqual(
      ONBOARDING_JOURNEY_DEFAULTS[ProjectType.PESSOAL].map((s) => s.key),
    );
    expect(resolved.every((s) => s.enabled)).toBe(true);
  });

  it('reordena pelo campo order salvo pelo admin', () => {
    const resolved = resolveJourney(ProjectType.PESSOAL, [
      { stepKey: 'expense', order: 0 },
      { stepKey: 'funding', order: 1 },
    ]);
    expect(resolved.slice(0, 2).map((s) => s.key)).toEqual(['expense', 'funding']);
  });

  it('aplica enabled, skippable e textos sobrescritos', () => {
    const [step] = resolveJourney(ProjectType.CARRO, [
      {
        stepKey: 'car',
        order: 0,
        enabled: false,
        skippable: false,
        label: 'Meu carro',
        subtitle: 'Conta pra gente qual é o seu.',
      },
    ]);
    expect(step).toMatchObject({
      key: 'car',
      label: 'Meu carro',
      subtitle: 'Conta pra gente qual é o seu.',
      enabled: false,
      skippable: false,
    });
  });

  // O onboarding é a primeira experiência do usuário: configuração inválida
  // nunca pode derrubá-lo. Um override órfão (tela removida por um deploy)
  // precisa ser ignorado, não virar uma tela fantasma nem um crash.
  it('ignora override de tela que não existe mais no catálogo', () => {
    const resolved = resolveJourney(ProjectType.PLANTAS, [
      { stepKey: 'tela-que-nao-existe', order: 0, enabled: true },
    ]);
    expect(resolved.map((s) => s.key)).not.toContain('tela-que-nao-existe');
    expect(resolved.length).toBe(ONBOARDING_JOURNEY_DEFAULTS[ProjectType.PLANTAS].length);
  });

  it('texto em branco não apaga o default (cai no catálogo)', () => {
    const [step] = resolveJourney(ProjectType.CASA, [
      { stepKey: 'bill', subtitle: '   ', label: '' },
    ]);
    expect(step.label).toBe(ONBOARDING_JOURNEY_DEFAULTS[ProjectType.CASA][0].label);
    expect(step.subtitle).toBe(
      ONBOARDING_JOURNEY_DEFAULTS[ProjectType.CASA][0].defaultSubtitle,
    );
  });

  it('tela condicional (maria) mantém alwaysAvailable=false para o wizard decidir', () => {
    const maria = resolveJourney(ProjectType.PESSOAL).find((s) => s.key === 'maria-insight');
    expect(maria?.alwaysAvailable).toBe(false);
  });
});
