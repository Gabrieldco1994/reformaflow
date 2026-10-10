import { describe, expect, it } from 'vitest';
import { formatDateOnly, formatDueMonth, formatInstantBRT } from './import-format';

describe('import formatters', () => {
  it('prints a date-only exactly, in any process timezone', () => {
    expect(formatDateOnly('2026-09-20')).toBe('20/09/2026');
    expect(formatDateOnly('2026-09-20T00:00:00.000Z')).toBeNull();
    expect(formatDateOnly(null)).toBeNull();
  });

  it('converts an instant to BRT, crossing midnight backwards', () => {
    expect(formatInstantBRT('2026-09-20T02:30:00.000Z')).toBe('19/09/2026 às 23:30');
    expect(formatInstantBRT('2026-09-20T15:05:00.000Z')).toBe('20/09/2026 às 12:05');
    expect(formatInstantBRT('2026-09-20')).toBeNull();
    expect(formatInstantBRT(undefined)).toBeNull();
  });

  it('prints an invoice due month', () => {
    expect(formatDueMonth('2026-10')).toBe('10/2026');
    expect(formatDueMonth('2026-13')).toBeNull();
    expect(formatDueMonth(null)).toBeNull();
  });
});
