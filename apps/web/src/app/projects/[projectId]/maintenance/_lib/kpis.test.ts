import { describe, expect, it } from 'vitest';
import { computeMaintenanceKpis } from './kpis';

const logs = [
  { id: '1', tipo: 'PNEUS', dataRealizada: '2026-01-10', dataProxima: '2026-08-01', custo: 40_000 },
  { id: '2', tipo: 'OLEO', dataRealizada: '2026-07-01', dataProxima: undefined, custo: 15_000 },
  { id: '3', tipo: 'FREIOS', dataRealizada: '2025-12-01', dataProxima: '2026-01-01', custo: 90_000 }, // ano anterior, próxima já passou
];

describe('computeMaintenanceKpis', () => {
  it('counts only future-or-today dataProxima as pending', () => {
    const k = computeMaintenanceKpis(logs as any, new Date(2026, 6, 15));
    expect(k.pendingCount).toBe(1); // só o item 1 (2026-08-01 >= hoje); item 3 (2026-01-01) já passou
  });
  it('sums cost and count only for dataRealizada in the current year', () => {
    const k = computeMaintenanceKpis(logs as any, new Date(2026, 6, 15));
    expect(k.doneThisYearCount).toBe(2); // itens 1 e 2 (2026); item 3 é 2025
    expect(k.accumulatedCostCents).toBe(55_000);
  });
  it('boundary: dataProxima exactly today counts as pending', () => {
    const k = computeMaintenanceKpis(
      [{ ...logs[0], dataProxima: '2026-06-15' }] as any,
      new Date(2026, 5, 15),
    );
    expect(k.pendingCount).toBe(1);
  });
  it('empty logs → zeroed KPIs', () => {
    expect(computeMaintenanceKpis([], new Date())).toEqual({
      pendingCount: 0,
      doneThisYearCount: 0,
      accumulatedCostCents: 0,
    });
  });
});
