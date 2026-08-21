import { describe, it, expect } from 'vitest';
import {
  PROJECT_NAV,
  getProjectNavModules,
  splitMobileNav,
  hasNavRoute,
} from '../src/config/module-navigator';
import { hasFeature } from '../src/config/project-features';
import { projectTypeHasModule } from '../src/config/type-modules';
import { ProjectType } from '../src/enums';

describe('hasNavRoute', () => {
  it('is false for CASA/CARRO "expenses" (issue #369: rota removida, feature preservada)', () => {
    expect(hasNavRoute(ProjectType.CASA, 'expenses')).toBe(false);
    expect(hasNavRoute(ProjectType.CARRO, 'expenses')).toBe(false);
  });

  it('is true for REFORMA/COMPRA "expenses" (não afetados pela dieta de CASA/CARRO)', () => {
    expect(hasNavRoute(ProjectType.REFORMA, 'expenses')).toBe(true);
    expect(hasNavRoute(ProjectType.COMPRA, 'expenses')).toBe(true);
  });

  it('U4-02 [TRAVA] PESSOAL: 4 slugs colapsados no hub não são mais rotas de nav', () => {
    for (const slug of ['expenses', 'receipts', 'credit-cards', 'bank-accounts']) {
      expect(hasNavRoute(ProjectType.PESSOAL, slug)).toBe(false);
    }
  });

  it('U4-02b [TRAVA] colapsados continuam em PROJECT_FEATURES e TYPE_MODULES', () => {
    // Capacidade e autorização preservadas — só a navegação colapsou no hub.
    expect(hasFeature(ProjectType.PESSOAL, 'expenses')).toBe(true);
    expect(hasFeature(ProjectType.PESSOAL, 'receipts')).toBe(true);
    expect(hasFeature(ProjectType.PESSOAL, 'creditCards')).toBe(true);
    expect(hasFeature(ProjectType.PESSOAL, 'bankAccounts')).toBe(true);
    expect(projectTypeHasModule(ProjectType.PESSOAL, 'expenses')).toBe(true);
    expect(projectTypeHasModule(ProjectType.PESSOAL, 'receipts')).toBe(true);
    expect(projectTypeHasModule(ProjectType.PESSOAL, 'creditCards')).toBe(true);
    expect(projectTypeHasModule(ProjectType.PESSOAL, 'bankAccounts')).toBe(true);
  });

  it('is true for slugs still present in CASA/CARRO nav (financing, bills, maintenance...)', () => {
    for (const slug of ['dashboard', 'bills', 'financing', 'maintenance', 'reminders']) {
      expect(hasNavRoute(ProjectType.CASA, slug)).toBe(true);
    }
  });

  it('is false for an unknown slug', () => {
    expect(hasNavRoute(ProjectType.CASA, 'nope-not-a-route')).toBe(false);
  });
});

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
      ProjectType.PLANTAS,
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

  it('U4-01 PESSOAL nav has exactly 9 items after hub collapse', () => {
    const slugs = getProjectNavModules(ProjectType.PESSOAL).map((m) => m.slug);
    expect(slugs).toEqual([
      'monthly',
      'conta',
      'dre',
      'neutros',
      'recorrentes',
      'metas',
      'planning',
      'planejador',
      'cash-flow',
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
      'price-compare',
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

  it('reproduces legacy FEATURE_NAV ordering for CASA (expenses removed: Avulsas em /bills é a superfície única)', () => {
    expect(getProjectNavModules(ProjectType.CASA).map((m) => m.slug)).toEqual([
      'dashboard',
      'bills',
      'financing',
      'maintenance',
      'reminders',
    ]);
  });

  it('includes vehicle documents and financing in the CARRO navigation (expenses removed: Avulsas em /bills é a superfície única)', () => {
    expect(getProjectNavModules(ProjectType.CARRO).map((m) => m.slug)).toEqual([
      'dashboard',
      'car-info',
      'bills',
      'vehicle-documents',
      'financing',
      'maintenance',
      'reminders',
    ]);
  });

  it('COMPRA expõe fluxo financeiro + monitoramento de preços (dieta #291: sem receipts/cashFlow)', () => {
    expect(getProjectNavModules(ProjectType.COMPRA).map((m) => m.slug)).toEqual([
      'dashboard',
      'expenses',
      'price-compare',
    ]);
  });

  it('PLANTAS exposes exactly 5 modules', () => {
    expect(getProjectNavModules(ProjectType.PLANTAS).map((m) => m.slug)).toEqual([
      'dashboard',
      'plants-ai',
      'plants',
      'maintenance',
      'reminders',
    ]);
  });

  it('PESSOAL exposes 9 modules (U4: 4 colapsados no hub)', () => {
    expect(getProjectNavModules(ProjectType.PESSOAL)).toHaveLength(9);
  });

  it('não descobre budget-allocation: virou histórico administrativo (#449 B2)', () => {
    // A rota continua existindo para deep-link de ADMIN; o que sai é a
    // DESCOBERTA. Enquanto a leitura exigir ADMIN não-convidado, um item de
    // menu visível a todo mundo seria uma CTA que só entrega 403.
    expect(
      getProjectNavModules(ProjectType.PESSOAL).some((m) => m.slug === 'budget-allocation'),
    ).toBe(false);
    expect(hasNavRoute(ProjectType.PESSOAL, 'budget-allocation')).toBe(false);
  });

  it('preserves the permission-gate slug used by the web auth-context (metas gates on expenses)', () => {
    const metas = getProjectNavModules(ProjectType.PESSOAL).find((m) => m.slug === 'metas');
    expect(metas?.module).toBe('expenses');
    const dre = getProjectNavModules(ProjectType.PESSOAL).find((m) => m.slug === 'dre');
    expect(dre?.module).toBe('monthlyOverview');
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
  it('primary = first 4, secondary = rest (PESSOAL: 4 + 5)', () => {
    const { primary, secondary } = splitMobileNav(
      getProjectNavModules(ProjectType.PESSOAL),
      4,
    );
    expect(primary).toHaveLength(4);
    expect(secondary).toHaveLength(5);
  });

  it('supports a custom primary count of 3 (PESSOAL tab bar leaves a center slot: 3 + 6)', () => {
    const { primary, secondary } = splitMobileNav(
      getProjectNavModules(ProjectType.PESSOAL),
      3,
    );
    expect(primary.map((m) => m.slug)).toEqual(['monthly', 'conta', 'dre']);
    expect(secondary).toHaveLength(6);
  });

  it('list with exactly 4 modules yields empty secondary (no "Mais" needed)', () => {
    const { primary, secondary } = splitMobileNav(
      getProjectNavModules(ProjectType.CASA).slice(0, 4),
      4,
    );
    expect(primary).toHaveLength(4);
    expect(secondary).toHaveLength(0);
  });

  it('boundary: 0 modules -> both empty, no throw', () => {
    expect(splitMobileNav([], 4)).toEqual({ primary: [], secondary: [] });
  });

  it('boundary: primaryCount larger than list -> all primary, empty secondary', () => {
    const mods = getProjectNavModules(ProjectType.CASA).slice(0, 4);
    const { primary, secondary } = splitMobileNav(mods, 10);
    expect(primary).toHaveLength(4);
    expect(secondary).toHaveLength(0);
  });

  it('defaults to a primary count of 4 when omitted', () => {
    const { primary } = splitMobileNav(getProjectNavModules(ProjectType.PESSOAL));
    expect(primary).toHaveLength(4);
  });
});
