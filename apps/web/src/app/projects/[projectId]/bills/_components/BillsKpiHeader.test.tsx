import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BillsKpiHeader } from './BillsKpiHeader';

describe('BillsKpiHeader', () => {
  it('shows total mensal via moneyGlance and the raw dueSoon/overdue counts', () => {
    render(<BillsKpiHeader totalMensalCents={30_000} dueSoonCount={1} overdueCount={0} />);

    expect(screen.getByText('R$ 300')).toBeInTheDocument();

    const overdueTile = screen.getByRole('article', { name: 'Atrasadas' });
    expect(overdueTile).toHaveTextContent('0');
    expect(overdueTile.innerHTML).not.toContain('D92D20'); // sem tone negativo

    const dueSoonTile = screen.getByRole('article', { name: 'Próximas a vencer' });
    expect(dueSoonTile).toHaveTextContent('1');
  });

  it('marks the overdue tile with negative tone only when overdueCount > 0', () => {
    const { rerender } = render(
      <BillsKpiHeader totalMensalCents={30_000} dueSoonCount={1} overdueCount={0} />,
    );
    expect(screen.getByRole('article', { name: 'Atrasadas' }).innerHTML).not.toContain('D92D20');

    rerender(<BillsKpiHeader totalMensalCents={30_000} dueSoonCount={1} overdueCount={2} />);
    const overdueTile = screen.getByRole('article', { name: 'Atrasadas' });
    expect(overdueTile).toHaveTextContent('2');
    expect(overdueTile.innerHTML).toContain('D92D20');
  });
});
