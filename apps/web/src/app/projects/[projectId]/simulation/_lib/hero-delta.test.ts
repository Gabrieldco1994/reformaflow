import { describe, it, expect } from 'vitest';
import { computeSimulationDelta } from './hero-delta';

describe('computeSimulationDelta', () => {
  it('computes delta as simulated saldo minus real projected saldo (positive = simulation is better)', () => {
    expect(computeSimulationDelta({ previsaoSaldo: 500_000 }, 400_000)).toBe(100_000);
  });

  it('boundary: equal values → delta 0 (not shown as good nor bad)', () => {
    expect(computeSimulationDelta({ previsaoSaldo: 400_000 }, 400_000)).toBe(0);
  });

  it('negative delta when simulation is worse than real', () => {
    expect(computeSimulationDelta({ previsaoSaldo: 300_000 }, 400_000)).toBe(-100_000);
  });

  it('handles absent real cash-flow (no entries) as zero baseline, not throwing', () => {
    expect(computeSimulationDelta({ previsaoSaldo: 500_000 }, undefined)).toBe(500_000);
  });
});
