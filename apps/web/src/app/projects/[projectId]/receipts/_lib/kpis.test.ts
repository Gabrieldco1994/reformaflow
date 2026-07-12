import { describe, expect, it } from 'vitest';
import { computeReceiptsKpis } from './kpis';

const receipts = [
  { id: 'a', valor: 10_000, data: '2026-07-05', status: 'EM_CAIXA' },
  { id: 'b', valor: 5_000, data: '2026-07-20', status: 'PREVISTO' },
  { id: 'c', valor: 8_000, data: '2026-02-01', status: 'EM_CAIXA' }, // mesmo ano, mês anterior
  { id: 'd', valor: 3_000, data: '2025-12-01', status: 'EM_CAIXA' }, // ano anterior, fora do YTD
];

describe('computeReceiptsKpis', () => {
  it('splits current-month received vs forecast', () => {
    const k = computeReceiptsKpis(receipts as any, new Date(2026, 6, 25));
    expect(k.monthReceivedCents).toBe(10_000);
    expect(k.monthForecastCents).toBe(5_000);
  });
  it('YTD sums only EM_CAIXA within the current calendar year', () => {
    const k = computeReceiptsKpis(receipts as any, new Date(2026, 6, 25));
    expect(k.ytdCents).toBe(18_000); // a + c, não soma d (2025) nem b (PREVISTO)
  });
  it('empty receipts → zeroed KPIs, no NaN/undefined', () => {
    expect(computeReceiptsKpis([], new Date())).toEqual({
      monthReceivedCents: 0,
      monthForecastCents: 0,
      ytdCents: 0,
    });
  });
});
