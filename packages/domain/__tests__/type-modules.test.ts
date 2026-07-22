import { describe, it, expect } from 'vitest';
import {
  TYPE_MODULES,
  UNIVERSAL_MODULE,
  projectTypeHasModule,
  userHasAnyModuleForType,
  PROJECT_NAV,
} from '../src/config';
import { ProjectType } from '../src/enums';

describe('TYPE_MODULES (single source of truth for the access gate)', () => {
  it('covers every ProjectType with a non-empty list', () => {
    for (const t of Object.values(ProjectType)) {
      expect(Array.isArray(TYPE_MODULES[t])).toBe(true);
      expect(TYPE_MODULES[t].length).toBeGreaterThan(0);
    }
  });

  // Locks the EXACT server+client gate. Because this map is now the single
  // source of truth both the web AND the API enforce, any edit that widens a
  // type (adds a module) silently widens the auth gate — this snapshot fails
  // loudly so that change is a conscious one, reviewed on its own merits.
  it('LOCK: exact per-type contents (auth gate must not drift silently)', () => {
    expect(TYPE_MODULES).toEqual({
      REFORMA: [
        'dashboard',
        'expenses',
        'receipts',
        'cashFlow',
        'schedule',
        'floorPlans',
        'simulation',
        'priceCompare',
        'rooms',
        'creditCards',
        'pendencias',
      ],
      COMPRA: ['dashboard', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'priceCompare'],
      PESSOAL: [
        'dashboard',
        'expenses',
        'receipts',
        'cashFlow',
        'creditCards',
        'bankAccounts',
        'monthlyOverview',
        'pendencias',
      ],
      CASA: ['dashboard', 'recurringBills', 'maintenance', 'reminders', 'expenses', 'financing'],
      CARRO: ['dashboard', 'carInfo', 'vehicleDocuments', 'recurringBills', 'maintenance', 'reminders', 'expenses'],
      PLANTAS: ['dashboard', 'maintenance', 'reminders', 'plantsAi'],
    });
  });

  it('INVARIANT: every rendered nav row (PROJECT_NAV[type].module) is gated by TYPE_MODULES[type]', () => {
    for (const t of Object.values(ProjectType)) {
      const gate = TYPE_MODULES[t] as string[];
      for (const nav of PROJECT_NAV[t]) {
        expect(
          gate.includes(nav.module),
          `PROJECT_NAV[${t}] renders "${nav.slug}" gated on module "${nav.module}" which is NOT in TYPE_MODULES[${t}]`,
        ).toBe(true);
      }
    }
  });
});

describe('UNIVERSAL_MODULE (dashboard) contract — the #98 ratoeira', () => {
  it('the universal module is a member of every type gate', () => {
    for (const t of Object.values(ProjectType)) {
      expect(projectTypeHasModule(t, UNIVERSAL_MODULE)).toBe(true);
    }
  });

  it('owning ONLY the universal module never grants a project type', () => {
    for (const t of Object.values(ProjectType)) {
      expect(userHasAnyModuleForType(t, [UNIVERSAL_MODULE])).toBe(false);
    }
  });
});

describe('projectTypeHasModule', () => {
  it('true for a gated module, false for a non-gated one', () => {
    expect(projectTypeHasModule('PESSOAL', 'monthlyOverview')).toBe(true);
    expect(projectTypeHasModule('COMPRA', 'rooms')).toBe(false);
  });

  it('unknown type -> false, no throw', () => {
    expect(projectTypeHasModule('NOPE', 'expenses')).toBe(false);
  });
});

describe('userHasAnyModuleForType (shared web+api gate)', () => {
  // Regression guards for the exact web-behavior deltas of #98:
  it('REFORMA: creditCards alone qualifies (web now matches the API gate)', () => {
    expect(userHasAnyModuleForType('REFORMA', ['creditCards'])).toBe(true);
  });

  it('COMPRA: creditCards alone qualifies (web now matches the API gate)', () => {
    expect(userHasAnyModuleForType('COMPRA', ['creditCards'])).toBe(true);
  });

  it('PLANTAS: dashboard alone does NOT qualify (fixes prior web over-grant)', () => {
    expect(userHasAnyModuleForType('PLANTAS', ['dashboard'])).toBe(false);
  });

  it('unchanged cases still hold (a real gated module qualifies)', () => {
    expect(userHasAnyModuleForType('PESSOAL', ['expenses'])).toBe(true);
    expect(userHasAnyModuleForType('CASA', ['maintenance'])).toBe(true);
    expect(userHasAnyModuleForType('CARRO', ['carInfo'])).toBe(true);
  });

  it('no owned modules -> false; unknown type -> false, no throw', () => {
    expect(userHasAnyModuleForType('REFORMA', [])).toBe(false);
    expect(userHasAnyModuleForType('NOPE', ['expenses'])).toBe(false);
  });
});
