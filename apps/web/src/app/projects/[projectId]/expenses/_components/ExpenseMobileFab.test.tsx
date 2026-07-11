import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExpenseMobileFab } from './ExpenseMobileFab';

describe('ExpenseMobileFab', () => {
  it('offers an accessible 44px touch target and invokes its callback once', () => {
    const onClick = vi.fn();
    render(<ExpenseMobileFab activeTab="despesas" onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Nova despesa' });
    expect(button.className).toContain('min-h-[44px]');
    expect(button.className).toContain('min-w-[44px]');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is absent from Compráveis', () => {
    render(<ExpenseMobileFab activeTab="compraveis" onClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Nova despesa' })).not.toBeInTheDocument();
  });
});
