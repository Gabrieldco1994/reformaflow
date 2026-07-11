import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MobileExpenseGlance } from './MobileExpenseGlance';

describe('MobileExpenseGlance', () => {
  it('formats existing cents and reveals each exact value independently', () => {
    render(<MobileExpenseGlance status="ready" noCartao={2_069_638} naConta={150_050} />);
    const card = screen.getByRole('article', { name: 'No cartão' });
    const account = screen.getByRole('article', { name: 'Na conta' });
    expect(within(card).getByText('R$ 21 mil')).toBeInTheDocument();
    expect(within(account).getByText('R$ 1,5 mil')).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Mostrar valor exato' }));
    expect(within(card).getByText('R$ 20.696,38')).toBeInTheDocument();
    expect(within(account).queryByText('R$ 1.500,50')).not.toBeInTheDocument();

    fireEvent.click(within(account).getByRole('button', { name: 'Mostrar valor exato' }));
    expect(within(account).getByText('R$ 1.500,50')).toBeInTheDocument();
    expect(within(card).getByText('R$ 20.696,38')).toBeInTheDocument();
  });

  it('distinguishes valid zero from absent data', () => {
    render(<MobileExpenseGlance status="ready" noCartao={0} naConta={null} />);
    expect(
      within(screen.getByRole('article', { name: 'No cartão' })).getByText('R$ 0'),
    ).toBeInTheDocument();
    const unavailable = within(screen.getByRole('article', { name: 'Na conta' }));
    expect(unavailable.queryByText('R$ 0')).not.toBeInTheDocument();
    expect(unavailable.getByText('—')).toBeInTheDocument();
    expect(unavailable.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['loading', 'error'] as const)('does not render monetary values while %s', (status) => {
    render(<MobileExpenseGlance status={status} noCartao={2_069_638} naConta={150_050} />);
    expect(screen.queryByText('R$ 21 mil')).not.toBeInTheDocument();
    expect(screen.queryByText('R$ 1,5 mil')).not.toBeInTheDocument();
  });

  it('renders no Delta without supplied comparison data', () => {
    render(<MobileExpenseGlance status="ready" noCartao={10_000} naConta={20_000} />);
    expect(screen.queryByTestId('expense-glance-delta')).not.toBeInTheDocument();
  });
});
