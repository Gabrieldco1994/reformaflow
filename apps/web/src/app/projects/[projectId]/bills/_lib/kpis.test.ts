import { describe, expect, it } from 'vitest';
import { computeBillsKpis } from './kpis';

const bills = [
  { id: '1', nome: 'Luz', valor: 20_000, categoria: 'LUZ', frequencia: 'MENSAL', diaVencimento: 28, status: 'ATIVO' },
  { id: '2', nome: 'Seguro', valor: 120_000, categoria: 'SEGURO', frequencia: 'ANUAL', diaVencimento: 5, status: 'ATIVO' },
  { id: '3', nome: 'Streaming', valor: 5_000, categoria: 'STREAMING', frequencia: 'MENSAL', diaVencimento: 10, status: 'PAUSADO' },
] as const;

describe('computeBillsKpis', () => {
  it('sums only ATIVO bills with frequency multiplier, rounded to whole cents', () => {
    const kpis = computeBillsKpis(bills as any, new Date(2026, 6, 25));
    // 20_000 (mensal) + round(120_000/12=10_000) = 30_000; PAUSADO excluído
    expect(kpis.totalMensalCents).toBe(30_000);
  });
  it('counts dueSoon and overdue independently of the paused bill', () => {
    const kpis = computeBillsKpis(bills as any, new Date(2026, 6, 25));
    expect(kpis.dueSoonCount).toBe(1); // Luz, dia 28
    expect(kpis.overdueCount).toBe(1); // Seguro, dia 5
  });
  it('empty set returns all-zero KPIs (no crash, no NaN)', () => {
    expect(computeBillsKpis([], new Date())).toEqual({ totalMensalCents: 0, dueSoonCount: 0, overdueCount: 0 });
  });
});
