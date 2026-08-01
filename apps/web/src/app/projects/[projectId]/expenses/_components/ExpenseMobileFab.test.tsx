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

  // O painel da jornada é `fixed bottom` em z-70 e o FAB em z-30: sem descontar
  // a altura do painel, a jornada mandava lançar a primeira despesa e tapava o
  // único botão que faz isso no mobile.
  it('sobe acima do painel da jornada, descontando a altura publicada por ele', () => {
    render(<ExpenseMobileFab activeTab="despesas" onClick={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Nova despesa' });
    expect(button.className).toContain('var(--journey-panel-h,0px)');
  });
});
