import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileLaunchSheet } from './MobileLaunchSheet';

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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Parcelas' }), '3');
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

  it('mostra categorias direto, preenche o título pela categoria e revela o resto em "ver todas"', async () => {
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
        recentDescriptions={[]}
        projectType="PESSOAL"
      />,
    );

    await user.click(screen.getByRole('button', { name: '5' }));

    // Categoria aparece direto como tile (sem digitar nada).
    const supermercado = screen.getByRole('button', { name: 'Categoria Supermercado' });
    // Categoria fora do atalho só aparece em "ver todas".
    expect(screen.queryByRole('button', { name: 'Categoria Faxineira' })).not.toBeInTheDocument();

    await user.click(supermercado);
    expect(supermercado).toHaveAttribute('aria-pressed', 'true');

    // Título é preenchido pela categoria escolhida, por trás.
    expect(screen.getByText(/Lança como/)).toHaveTextContent('Supermercado');

    // "ver todas" revela as demais categorias de PESSOAL.
    await user.click(screen.getByRole('button', { name: 'ver todas' }));
    expect(screen.getByRole('button', { name: 'Categoria Faxineira' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Lançar despesa' }));

    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ tipoDespesa: 'SUPERMERCADO', titulo: 'Supermercado' }),
    );
  });
});
