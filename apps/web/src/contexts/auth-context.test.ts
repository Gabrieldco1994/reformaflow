import { describe, expect, it } from 'vitest';
import { ALL_MODULES } from './auth-context';

describe('ALL_MODULES finance entry', () => {
  it('labels the unchanged financialDashboard slug as Financeiro', () => {
    expect(ALL_MODULES.filter(({ slug }) => slug === 'financialDashboard')).toEqual([
      { slug: 'financialDashboard', label: 'Financeiro' },
    ]);
  });
});
