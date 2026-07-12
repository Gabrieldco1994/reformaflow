import { describe, expect, it } from 'vitest';
import { daysUntilDue, isBillDueSoon, isBillOverdue } from './recurring-bill-status';

describe('isBillOverdue', () => {
  it('is true when today is strictly past the due day', () => {
    expect(isBillOverdue(10, new Date(2026, 6, 15))).toBe(true);
  });
  it('is false exactly on the due day (boundary)', () => {
    expect(isBillOverdue(15, new Date(2026, 6, 15))).toBe(false);
  });
  it('is false before the due day', () => {
    expect(isBillOverdue(20, new Date(2026, 6, 15))).toBe(false);
  });
});

describe('daysUntilDue', () => {
  it('clamps month-end (dia 31) to the shorter month (Fev não-bissexto)', () => {
    expect(daysUntilDue(31, new Date(2026, 1, 1))).toBe(27); // Fev/2026 tem 28 dias
  });
});

describe('isBillDueSoon', () => {
  it('is true within the 7-day window and not yet overdue', () => {
    expect(isBillDueSoon(28, new Date(2026, 6, 25), 7)).toBe(true);
  });
  it('is false when already overdue this cycle (overdue takes precedence)', () => {
    expect(isBillDueSoon(5, new Date(2026, 6, 25), 7)).toBe(false);
  });
  it('is true on the boundary day 0 (due today)', () => {
    expect(isBillDueSoon(25, new Date(2026, 6, 25), 7)).toBe(true);
  });
});
