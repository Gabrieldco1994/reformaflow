import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileLaunchSheet } from './MobileLaunchSheet';
import { getExpenseOptions } from '../../expenses/_types';

vi.mock('../../expenses/_hooks/useCategorySuggestion', () => ({
  useCategorySuggestion: () => ({ suggestion: null, isFetching: false }),
}));

describe('MobileLaunchSheet', () => {
  it('enables launch when value is informed and submits card payload', async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn(async () => undefined);

    render(
      <MobileLaunchSheet
        open
        onClose={vi.fn()}
        onLaunch={onLaunch}
        launching={false}
        accounts={[{ id: 'acc-1', nickname: 'Conta Itaú', last4: '4247' }]}
        cards={[{ id: 'card-1', nickname: 'Master', last4: '5876', closingDay: 5, dueDay: 12 }]}
        recentDescriptions={['Mercado Zaffari']}
        projectType="PESSOAL"
      />,
    );

    expect(screen.getByRole('button', { name: 'Lançar despesa' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: '3' }));
    await user.click(screen.getByRole('button', { name: 'Origem Master •5876' }));
    await user.click(screen.getByRole('button', { name: '3x' }));
    await user.click(screen.getByRole('button', { name: 'Mercado Zaffari' }));

    const launchButton = screen.getByRole('button', { name: 'Lançar despesa' });
    expect(launchButton).toBeEnabled();

    await user.click(launchButton);

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        valor: 1.23,
        creditCardId: 'card-1',
        quantidadeParcela: 3,
        titulo: 'Mercado Zaffari',
      }),
    );
  });

  it('always shows the expense-type pill and lets the user change it (bug 2)', async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn(async () => undefined);

    render(
      <MobileLaunchSheet
        open
        onClose={vi.fn()}
        onLaunch={onLaunch}
        launching={false}
        accounts={[{ id: 'acc-1', nickname: 'Conta Itaú', last4: '4247' }]}
        cards={[]}
        recentDescriptions={['Mercado Zaffari']}
        projectType="PESSOAL"
      />,
    );

    // Sem descrição → sem pill (logo, sem "trocar").
    expect(screen.queryByRole('button', { name: 'trocar' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '5' }));
    await user.click(screen.getByRole('button', { name: 'Mercado Zaffari' }));

    // Sem sugestão da Maria → a pill mostra "Outros", nunca silencioso.
    expect(screen.getByRole('button', { name: 'trocar' })).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => /tipo:\s*outros/i.test(el?.textContent ?? '') && el?.tagName === 'SPAN'),
    ).toBeInTheDocument();

    // Trocar abre o seletor com as opções de PESSOAL.
    const options = getExpenseOptions('PESSOAL');
    await user.click(screen.getByRole('button', { name: 'trocar' }));
    await user.click(screen.getByRole('button', { name: options[0].label }));

    await user.click(screen.getByRole('button', { name: 'Lançar despesa' }));

    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ tipoDespesa: options[0].value }),
    );
  });
});
