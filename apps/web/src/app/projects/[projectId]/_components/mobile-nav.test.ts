import { describe, expect, it } from 'vitest';
import {
  getProjectNavModules,
  ProjectType,
  type NavModule,
} from '@reformaflow/domain';
import { getMobilePrimary, isPathActive } from './mobile-nav';

const NON_PERSONAL_MATRIX = [
  {
    type: ProjectType.REFORMA,
    primary: ['dashboard', 'expenses', 'receipts'],
    secondary: [
      'cash-flow',
      'schedule',
      'pendencias',
      'floor-plans',
      'simulation',
    ],
  },
  {
    type: ProjectType.COMPRA,
    primary: ['dashboard', 'expenses', 'receipts'],
    secondary: ['cash-flow'],
  },
  {
    type: ProjectType.CASA,
    primary: ['dashboard', 'bills', 'expenses'],
    secondary: ['maintenance', 'reminders'],
  },
  {
    type: ProjectType.CARRO,
    primary: ['dashboard', 'car-info', 'bills'],
    secondary: ['expenses', 'maintenance', 'reminders'],
  },
  {
    type: ProjectType.PLANTAS,
    primary: ['dashboard', 'plants-ai', 'plants'],
    secondary: ['maintenance', 'reminders'],
  },
] as const;

describe('getMobilePrimary', () => {
  it('keeps only monthly in the PESSOAL primary slot and every other visible module in secondary', () => {
    const visible = getProjectNavModules(ProjectType.PESSOAL);
    const { primary, secondary } = getMobilePrimary(
      ProjectType.PESSOAL,
      visible,
    );

    expect(primary.map((module) => module.slug)).toEqual(['monthly']);
    expect(secondary.map((module) => module.slug)).toEqual([
      'conta',
      'dre',
      'neutros',
      'expenses',
      'receipts',
      'metas',
      'planning',
      'budget-allocation',
      'cash-flow',
      'credit-cards',
      'bank-accounts',
    ]);
  });

  it.each(NON_PERSONAL_MATRIX)(
    'partitions the complete $type navigation matrix in project order',
    ({ type, primary: expectedPrimary, secondary: expectedSecondary }) => {
      const visible = getProjectNavModules(type);
      const { primary, secondary } = getMobilePrimary(type, visible);

      expect(primary.map((module) => module.slug)).toEqual(expectedPrimary);
      expect(secondary.map((module) => module.slug)).toEqual(expectedSecondary);
    },
  );

  it('backfills primary slots only from the permission-filtered visible modules', () => {
    const visible = getProjectNavModules(ProjectType.REFORMA).filter(
      (module) => !['expenses', 'cash-flow'].includes(module.slug),
    );

    const { primary, secondary } = getMobilePrimary(
      ProjectType.REFORMA,
      visible,
    );

    expect(primary.map((module) => module.slug)).toEqual([
      'dashboard',
      'receipts',
      'schedule',
    ]);
    expect(secondary.map((module) => module.slug)).toEqual([
      'pendencias',
      'floor-plans',
      'simulation',
    ]);
    expect([...primary, ...secondary]).toEqual(visible);
  });

  it('keeps visible PESSOAL conta and expenses modules in secondary', () => {
    const visible = getProjectNavModules(ProjectType.PESSOAL).filter((module) =>
      ['monthly', 'conta', 'dre', 'expenses'].includes(module.slug),
    );

    const { primary, secondary } = getMobilePrimary(
      ProjectType.PESSOAL,
      visible,
    );

    expect(primary.map((module) => module.slug)).toEqual(['monthly']);
    expect(secondary.map((module) => module.slug)).toEqual([
      'conta',
      'dre',
      'expenses',
    ]);
  });

  it('does not synthesize a PESSOAL primary when monthly is not visible', () => {
    const visible = getProjectNavModules(ProjectType.PESSOAL).filter((module) =>
      ['conta', 'expenses'].includes(module.slug),
    );

    const { primary, secondary } = getMobilePrimary(
      ProjectType.PESSOAL,
      visible,
    );

    expect(primary).toEqual([]);
    expect(secondary).toEqual(visible);
  });

  it.each([0, 1, 2])(
    'renders only the %i permission-filtered modules available below the three-slot boundary',
    (count) => {
      const visible: NavModule[] = getProjectNavModules(
        ProjectType.COMPRA,
      ).slice(0, count);

      const { primary, secondary } = getMobilePrimary(
        ProjectType.COMPRA,
        visible,
      );

      expect(primary).toEqual(visible);
      expect(secondary).toEqual([]);
    },
  );
});

describe('isPathActive', () => {
  const plantsHref = '/projects/p1/plants';

  it('matches an exact route and its nested segments', () => {
    expect(isPathActive(plantsHref, plantsHref)).toBe(true);
    expect(isPathActive(`${plantsHref}/abc`, plantsHref)).toBe(true);
  });

  it('does not match a sibling slug that merely shares a prefix', () => {
    expect(isPathActive('/projects/p1/plants-ai', plantsHref)).toBe(false);
  });
});
