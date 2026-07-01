import { describe, it, expect } from 'vitest';
import { getProjectNavModules, ProjectType, type NavModule } from '@reformaflow/domain';
import { getMobilePrimary } from './mobile-nav';

describe('getMobilePrimary', () => {
  it('curates PESSOAL primary to [monthly, conta, expenses] with 8 in secondary (incl. dre)', () => {
    const visible = getProjectNavModules(ProjectType.PESSOAL);
    const { primary, secondary } = getMobilePrimary('PESSOAL', visible);

    expect(primary.map((m) => m.slug)).toEqual(['monthly', 'conta', 'expenses']);

    // Full PESSOAL nav has 11 modules → 8 remain in secondary.
    expect(secondary).toHaveLength(8);
    expect(secondary.map((m) => m.slug)).toEqual([
      'dre',
      'receipts',
      'metas',
      'planning',
      'budget-allocation',
      'cash-flow',
      'credit-cards',
      'bank-accounts',
    ]);
    expect(secondary.some((m) => m.slug === 'dre')).toBe(true);
  });

  it('non-PESSOAL type takes first 3 in nav order, rest in secondary', () => {
    const visible = getProjectNavModules(ProjectType.REFORMA);
    const { primary, secondary } = getMobilePrimary('REFORMA', visible);

    expect(primary.map((m) => m.slug)).toEqual(['dashboard', 'expenses', 'receipts']);
    expect(secondary.map((m) => m.slug)).toEqual([
      'cash-flow',
      'schedule',
      'pendencias',
      'floor-plans',
      'simulation',
    ]);
  });

  it('handles the <3 visible modules boundary without crashing', () => {
    const visible: NavModule[] = [
      { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard' },
      { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses' },
    ];
    const { primary, secondary } = getMobilePrimary('COMPRA', visible);

    expect(primary.map((m) => m.slug)).toEqual(['dashboard', 'expenses']);
    expect(secondary).toHaveLength(0);
  });

  it('PESSOAL curation filters out slugs missing from visibleNav', () => {
    // Only monthly + expenses visible (conta filtered out by permissions).
    const visible: NavModule[] = getProjectNavModules(ProjectType.PESSOAL).filter((m) =>
      ['monthly', 'expenses', 'dre'].includes(m.slug),
    );
    const { primary, secondary } = getMobilePrimary('PESSOAL', visible);

    expect(primary.map((m) => m.slug)).toEqual(['monthly', 'expenses']);
    expect(secondary.map((m) => m.slug)).toEqual(['dre']);
  });
});
