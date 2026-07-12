import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SimulationHero } from './SimulationHero';

describe('SimulationHero', () => {
  it('renders the simulated saldo and a positive Delta when simulation beats the real projected saldo', () => {
    render(<SimulationHero previsaoSaldo={500_000} realProjectedSaldoCents={400_000} />);
    expect(screen.getByText('R$ 5 mil')).toBeInTheDocument();
    expect(screen.getByText(/melhorou/)).toBeInTheDocument();
  });

  it('renders a negative Delta when simulation is worse than the real projected saldo', () => {
    render(<SimulationHero previsaoSaldo={300_000} realProjectedSaldoCents={400_000} />);
    expect(screen.getByText(/piorou/)).toBeInTheDocument();
  });

  it('falls back to zero baseline when there is no real cash-flow data yet', () => {
    render(<SimulationHero previsaoSaldo={500_000} realProjectedSaldoCents={undefined} />);
    expect(screen.getByText(/melhorou/)).toBeInTheDocument();
  });
});
