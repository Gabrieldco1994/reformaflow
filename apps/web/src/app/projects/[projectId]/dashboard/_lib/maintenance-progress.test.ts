import { expect, test } from 'vitest';
import { computeMaintenanceProgress } from './maintenance-progress';

test('meio do intervalo → 50%, ainda faltam dias', () => {
  const result = computeMaintenanceProgress(
    '2026-06-01T00:00:00.000Z',
    '2026-06-31T00:00:00.000Z',
    new Date('2026-06-16T00:00:00.000Z'),
  );
  expect(result.percentComplete).toBe(50);
  expect(result.isOverdue).toBe(false);
  expect(result.daysUntil).toBeGreaterThan(0);
});

test('data prevista já passou → 100%, atrasada, dias negativos', () => {
  const result = computeMaintenanceProgress(
    '2026-06-01T00:00:00.000Z',
    '2026-06-15T00:00:00.000Z',
    new Date('2026-07-01T00:00:00.000Z'),
  );
  expect(result.percentComplete).toBe(100);
  expect(result.isOverdue).toBe(true);
  expect(result.daysUntil).toBeLessThan(0);
});

test('ainda não chegou a data da última manutenção (intervalo inválido) → 100%', () => {
  const result = computeMaintenanceProgress(
    '2026-08-01T00:00:00.000Z',
    '2026-07-01T00:00:00.000Z',
    new Date('2026-07-15T00:00:00.000Z'),
  );
  expect(result.percentComplete).toBe(100);
});

test('exatamente no início do intervalo → 0%', () => {
  const result = computeMaintenanceProgress(
    '2026-06-01T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
    new Date('2026-06-01T00:00:00.000Z'),
  );
  expect(result.percentComplete).toBe(0);
});
