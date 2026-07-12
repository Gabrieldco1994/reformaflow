import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileTabBar } from './MobileTabBar';

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

describe('MobileTabBar', () => {
  it('renders the fixed tabs Hoje, Lançar and Maria', () => {
    render(
      <MobileTabBar
        basePath="/projects/p1"
        pathname="/projects/p1/monthly"
        onOpenLaunch={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: 'Hoje' })).toHaveAttribute('href', '/projects/p1/monthly');
    expect(screen.getByRole('button', { name: 'Lançar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Maria' })).toHaveAttribute('href', '/projects/p1/maria');
  });

  it('calls onOpenLaunch when the center FAB is clicked', async () => {
    const user = userEvent.setup();
    const onOpenLaunch = vi.fn();

    render(
      <MobileTabBar
        basePath="/projects/p1"
        pathname="/projects/p1/monthly"
        onOpenLaunch={onOpenLaunch}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Lançar' }));
    expect(onOpenLaunch).toHaveBeenCalledTimes(1);
  });
});
