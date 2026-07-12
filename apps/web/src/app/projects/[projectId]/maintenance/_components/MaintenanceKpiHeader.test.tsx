import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MaintenanceKpiHeader } from './MaintenanceKpiHeader';

describe('MaintenanceKpiHeader', () => {
  it('shows pending/doneThisYear counts and accumulated cost via moneyGlance', () => {
    render(
      <MaintenanceKpiHeader
        pendingCount={1}
        doneThisYearCount={2}
        accumulatedCostCents={55_000}
      />,
    );

    expect(screen.getByRole('article', { name: 'Pendentes' })).toHaveTextContent('1');
    expect(screen.getByRole('article', { name: 'Feitas no ano' })).toHaveTextContent('2');
    expect(screen.getByText('R$ 550')).toBeInTheDocument();
  });

  it('empty/zeroed KPIs render without crashing or NaN', () => {
    render(
      <MaintenanceKpiHeader pendingCount={0} doneThisYearCount={0} accumulatedCostCents={0} />,
    );

    expect(screen.getByRole('article', { name: 'Pendentes' })).toHaveTextContent('0');
    expect(screen.getByRole('article', { name: 'Feitas no ano' })).toHaveTextContent('0');
    expect(screen.getByText('R$ 0')).toBeInTheDocument();
  });
});
