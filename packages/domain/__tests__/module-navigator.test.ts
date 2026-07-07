import { describe, it, expect } from 'vitest';
import {
  PROJECT_NAV,
  getProjectNavModules,
  splitMobileNav,
} from '../src/config/module-navigator';
import { ProjectType } from '../src/enums';

describe('getProjectNavModules', () => {
  it('PESSOAL first module is Cockpit (slug "monthly")', () => {
    expect(getProjectNavModules(ProjectType.PESSOAL)[0].slug).toBe('monthly');
  });

  it('non-PESSOAL types open on dashboard first', () => {
    for (const t of [
      ProjectType.REFORMA,
      ProjectType.COMPRA,
      ProjectType.CASA,
      ProjectType.CARRO,
    ]) {
      expect(getProjectNavModules(t)[0].slug).toBe('dashboard');
    }
  });

  it('every nav module carries a non-empty slug, label, iconName and module gate', () => {
    for (const t of Object.values(ProjectType)) {
      for (const m of getProjectNavModules(t)) {
        expect(typeof m.slug).toBe('string');
        expect(m.slug.length).toBeGreaterThan(0);
        expect(m.label.length).toBeGreaterThan(0);
        expect(m.iconName.length).toBeGreaterThan(0);
        expect(m.module.length).toBeGreaterThan(0);
      }
    }
  });

  it('reproduces legacy FEATURE_NAV ordering for PESSOAL (no nav regression)', () => {
    expect(getProjectNavModules(ProjectType.PESSOAL).map((m) => m.slug)).toEqual([
      'monthly',
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

  it('reproduces legacy FEATURE_NAV ordering for REFORMA', () => {
    expect(getProjectNavModules(ProjectType.REFORMA).map((m) => m.slug)).toEqual([
      'dashboard',
      'expenses',
      'receipts',
      'cash-flow',
      'schedule',
      'pendencias',
      'floor-plans',
      'simulation',
    ]);
  });

  it('REFORMA nav has a pendencias entry right after schedule with module gate "pendencias"', () => {
    const nav = getProjectNavModules(ProjectType.REFORMA);
    const slugs = nav.map((m) => m.slug);
    const scheduleIdx = slugs.indexOf('schedule');
    expect(slugs[scheduleIdx + 1]).toBe('pendencias');
    const pend = nav.find((m) => m.slug === 'pendencias');
    expect(pend?.module).toBe('pendencias');
    expect(pend?.label).toBe('Pendências');
  });

  it('reproduces legacy FEATURE_NAV ordering for CASA', () => {
    expect(getProjectNavModules(ProjectType.CASA).map((m) => m.slug)).toEqual([
      'dashboard',
      'bills',
      'expenses',
      'maintenance',
      'reminders',
    ]);
  });

  it('reproduces legacy FEATURE_NAV ordering for CARRO', () => {
    expect(getProjectNavModules(ProjectType.CARRO).map((m) => m.slug)).toEqual([
      'dashboard',
      'car-info',
      'bills',
      'expenses',
      'maintenance',
      'reminders',
    ]);
  });

  it('COMPRA exposes exactly 4 modules', () => {
    expect(getProjectNavModules(ProjectType.COMPRA)).toHaveLength(4);
  });

  it('PESSOAL exposes 12 modules', () => {
    expect(getProjectNavModules(ProjectType.PESSOAL)).toHaveLength(12);
  });

  it('preserves the permission-gate slug used by the web auth-context (metas gates on expenses)', () => {
    const metas = getProjectNavModules(ProjectType.PESSOAL).find((m) => m.slug === 'metas');
    expect(metas?.module).toBe('expenses');
    const dre = getProjectNavModules(ProjectType.PESSOAL).find((m) => m.slug === 'dre');
    expect(dre?.module).toBe('monthlyOverview');
    const budget = getProjectNavModules(ProjectType.PESSOAL).find(
      (m) => m.slug === 'budget-allocation',
    );
    expect(budget?.module).toBe('dashboard');
  });

  it('returns an empty list for an unknown type without throwing', () => {
    // @ts-expect-error intentional invalid input
    expect(getProjectNavModules('NOPE')).toEqual([]);
  });

  it('PROJECT_NAV covers every ProjectType', () => {
    for (const t of Object.values(ProjectType)) {
      expect(Array.isArray(PROJECT_NAV[t])).toBe(true);
    }
  });
});

describe('splitMobileNav', () => {
  it('primary = first 4, secondary = rest (PESSOAL: 4 + 8)', () => {
    const { primary, secondary } = splitMobileNav(
      getProjectNavModules(ProjectType.PESSOAL),
      4,
    );
    expect(primary).toHaveLength(4);
    expect(secondary).toHaveLength(8);
  });

  it('supports a custom primary count of 3 (PESSOAL tab bar leaves a center slot: 3 + 9)', () => {
    const { primary, secondary } = splitMobileNav(
      getProjectNavModules(ProjectType.PESSOAL),
      3,
    );
    expect(primary.map((m) => m.slug)).toEqual(['monthly', 'conta', 'dre']);
    expect(secondary).toHaveLength(9);
  });

  it('type with exactly 4 modules yields empty secondary (no "Mais" needed)', () => {
    const { primary, secondary } = splitMobileNav(
      getProjectNavModules(ProjectType.COMPRA),
      4,
    );
    expect(primary).toHaveLength(4);
    expect(secondary).toHaveLength(0);
  });

  it('boundary: 0 modules -> both empty, no throw', () => {
    expect(splitMobileNav([], 4)).toEqual({ primary: [], secondary: [] });
  });

  it('boundary: primaryCount larger than list -> all primary, empty secondary', () => {
    const mods = getProjectNavModules(ProjectType.COMPRA);
    const { primary, secondary } = splitMobileNav(mods, 10);
    expect(primary).toHaveLength(4);
    expect(secondary).toHaveLength(0);
  });

  it('defaults to a primary count of 4 when omitted', () => {
    const { primary } = splitMobileNav(getProjectNavModules(ProjectType.PESSOAL));
    expect(primary).toHaveLength(4);
  });
});
