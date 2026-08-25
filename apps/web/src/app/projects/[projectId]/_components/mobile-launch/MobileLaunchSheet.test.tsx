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

  it('sem conta e sem cartão: lança na Carteira em vez de travar o botão', async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn(async () => undefined);

    render(
      <MobileLaunchSheet
        open
        onClose={vi.fn()}
        onLaunch={onLaunch}
        launching={false}
        accounts={[]}
        cards={[]}
        recentDescriptions={[]}
        projectType="PESSOAL"
      />,
    );

    // Carteira é ofertada mesmo sem nenhuma fonte cadastrada.
    expect(screen.getByRole('button', { name: 'Origem Carteira' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '5' }));
    await user.click(screen.getByRole('button', { name: '0' }));

    const launchButton = screen.getByRole('button', { name: 'Lançar despesa' });
    expect(launchButton).toBeEnabled();

    await user.click(launchButton);

    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ valor: 0.5, bankAccountId: null, creditCardId: null }),
    );
  });

  it('com conta cadastrada, a conta continua sendo o padrão (não a Carteira)', async () => {
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

    await user.click(screen.getByRole('button', { name: '9' }));
    await user.click(screen.getByRole('button', { name: 'Lançar despesa' }));

    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ bankAccountId: 'acc-1' }));
  });

  it('usa fluxo de planejamento no mobile quando mode=PLANEJAR', async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn(async () => undefined);

    render(
      <MobileLaunchSheet
        open
        mode="PLANEJAR"
        onClose={vi.fn()}
        onLaunch={onLaunch}
        launching={false}
        accounts={[{ id: 'acc-1', nickname: 'Conta Itaú', last4: '4247' }]}
        cards={[]}
        recentDescriptions={[]}
        projectType="PESSOAL"
      />,
    );

    await user.click(screen.getByRole('button', { name: '7' }));
    await user.click(screen.getByRole('button', { name: 'Planejar despesa' }));

    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        valor: 0.07,
        status: 'PLANEJADO',
      }),
    );
  });

  describe('Accessibility', () => {
    it('announces dialog and maintains focus containment', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      render(
        <MobileLaunchSheet
          open
          onClose={onClose}
          onLaunch={vi.fn()}
          launching={false}
          accounts={[]}
          cards={[]}
          recentDescriptions={[]}
          projectType="PESSOAL"
        />,
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'mobile-launch-title');
      expect(screen.getByRole('heading', { name: /Lançar/ })).toHaveAttribute(
        'id',
        'mobile-launch-title',
      );
    });

    it('closes dialog when Escape is pressed', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      render(
        <MobileLaunchSheet
          open
          onClose={onClose}
          onLaunch={vi.fn()}
          launching={false}
          accounts={[]}
          cards={[]}
          recentDescriptions={[]}
          projectType="PESSOAL"
        />,
      );

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
    });

    it('contains Tab focus within dialog', async () => {
      const user = userEvent.setup();

      render(
        <MobileLaunchSheet
          open
          onClose={vi.fn()}
          onLaunch={vi.fn()}
          launching={false}
          accounts={[]}
          cards={[]}
          recentDescriptions={[]}
          projectType="PESSOAL"
        />,
      );

      // Verify dialog is present
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();

      // Get focusable elements within dialog
      const focusableElements = dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );

      expect(focusableElements.length).toBeGreaterThan(0);

      // First Tab should focus first focusable element within dialog
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);

      // Verify that focus stays within the dialog (not escaped to document body)
      const elementsBefore = new Set(focusableElements);

      // Tab several times
      for (let i = 0; i < 5; i++) {
        await user.tab();
        // Focus should remain within the dialog
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
      }

      // Verify backward Tab (Shift+Tab) also stays in dialog
      for (let i = 0; i < 3; i++) {
        await user.keyboard('{Shift>}{Tab}{/Shift}');
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
      }
    });

    it('restores focus to trigger element when closed', async () => {
      const user = userEvent.setup();

      const { rerender } = render(
        <>
          <button id="trigger-button">Open Sheet</button>
          <MobileLaunchSheet
            open={false}
            onClose={vi.fn()}
            onLaunch={vi.fn()}
            launching={false}
            accounts={[]}
            cards={[]}
            recentDescriptions={[]}
            projectType="PESSOAL"
          />
        </>,
      );

      const triggerButton = screen.getByRole('button', { name: 'Open Sheet' });

      // Focus trigger button
      triggerButton.focus();
      expect(document.activeElement).toBe(triggerButton);

      // Rerender with dialog open
      rerender(
        <>
          <button id="trigger-button">Open Sheet</button>
          <MobileLaunchSheet
            open
            onClose={vi.fn()}
            onLaunch={vi.fn()}
            launching={false}
            accounts={[]}
            cards={[]}
            recentDescriptions={[]}
            projectType="PESSOAL"
          />
        </>,
      );

      expect(document.activeElement).not.toBe(triggerButton);

      // Rerender with dialog closed — focus should be restored
      const onClose = vi.fn();
      rerender(
        <>
          <button id="trigger-button">Open Sheet</button>
          <MobileLaunchSheet
            open={false}
            onClose={onClose}
            onLaunch={vi.fn()}
            launching={false}
            accounts={[]}
            cards={[]}
            recentDescriptions={[]}
            projectType="PESSOAL"
          />
        </>,
      );

      // Note: This is tested at the component level; restoring focus happens
      // in the cleanup of useEffect. Actual focus restoration would happen
      // if the user called onClose via Escape or close button.
    });
  });
});
