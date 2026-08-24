import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileLaunchModeSheet } from './MobileLaunchModeSheet';

describe('MobileLaunchModeSheet', () => {
  it('não renderiza nada quando fechado', () => {
    const { container } = render(
      <MobileLaunchModeSheet open={false} onClose={vi.fn()} onPick={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra despesa/planejar/recebimento/fatura-extrato e emite pick', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={onPick} />);

    expect(screen.getByRole('button', { name: /^Despesa Teclado rápido/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Planejar/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Recebimento/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Voz/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fatura \/ Extrato/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Despesa Teclado rápido/i }));
    expect(onPick).toHaveBeenCalledWith('despesa');

    await user.click(screen.getByRole('button', { name: /Planejar/ }));
    expect(onPick).toHaveBeenCalledWith('planejar');

    await user.click(screen.getByRole('button', { name: /Recebimento/ }));
    expect(onPick).toHaveBeenCalledWith('recebimento');

    await user.click(screen.getByRole('button', { name: /^Voz/ }));
    expect(onPick).toHaveBeenCalledWith('voz');
  });

  it('esconde Voz sem suporte do navegador', () => {
    render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={vi.fn()} voiceSupported={false} />);
    expect(screen.queryByRole('button', { name: /^Voz/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Despesa Teclado rápido/i })).toBeInTheDocument();
  });

  it('Fatura / Extrato abre a sub-tela e emite fatura/extrato; Voltar retorna à raiz', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={onPick} />);

    await user.click(screen.getByRole('button', { name: /Fatura \/ Extrato/ }));
    // Sub-tela: some o modo Despesa, aparecem as duas fontes.
    expect(screen.queryByRole('button', { name: /^Despesa Teclado rápido/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fatura do cartão/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Fatura do cartão/ }));
    expect(onPick).toHaveBeenCalledWith('fatura');

    // Reabre Fatura / Extrato e testa Voltar → raiz mostra Despesa de novo.
    await user.click(screen.getByRole('button', { name: /Extrato bancário/ }));
    expect(onPick).toHaveBeenCalledWith('extrato');
    await user.click(screen.getByRole('button', { name: /Voltar/ }));
    expect(screen.getByRole('button', { name: /^Despesa Teclado rápido/i })).toBeInTheDocument();
  });

  it('marca Despesa e Recebimento com data-journey-action para rastreamento de jornada', () => {
    const { container } = render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={vi.fn()} />);

    // Despesa tem marker de jornada
    const despesaBtn = container.querySelector('[data-journey-action="expense.new"]');
    expect(despesaBtn).toBeInTheDocument();
    expect(despesaBtn?.textContent).toMatch(/Despesa/);

    // Recebimento tem marker de jornada (antes deste fix, estava ausente em mobile)
    const recebimentoBtn = container.querySelector('[data-journey-action="receipt.new"]');
    expect(recebimentoBtn).toBeInTheDocument();
    expect(recebimentoBtn?.textContent).toMatch(/Recebimento/);
  });

  describe('Accessibility', () => {
    it('announces dialog and maintains focus containment', async () => {
      render(
        <MobileLaunchModeSheet open onClose={vi.fn()} onPick={vi.fn()} />,
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'mobile-launch-mode-title');
      expect(screen.getByRole('heading', { name: /Como quer lançar/ })).toHaveAttribute(
        'id',
        'mobile-launch-mode-title',
      );
    });

    it('closes dialog when Escape is pressed', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      render(
        <MobileLaunchModeSheet open onClose={onClose} onPick={vi.fn()} />,
      );

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
    });

    it('contains Tab focus within dialog', async () => {
      const user = userEvent.setup();

      render(
        <MobileLaunchModeSheet open onClose={vi.fn()} onPick={vi.fn()} />,
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

      // Tab several times and verify focus stays within dialog
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

    it('restores focus to trigger element when closed', () => {
      const { rerender } = render(
        <>
          <button id="trigger-button">Open Mode Sheet</button>
          <MobileLaunchModeSheet open={false} onClose={vi.fn()} onPick={vi.fn()} />
        </>,
      );

      const triggerButton = screen.getByRole('button', { name: 'Open Mode Sheet' });

      // Focus trigger button
      triggerButton.focus();
      expect(document.activeElement).toBe(triggerButton);

      // Rerender with dialog open
      rerender(
        <>
          <button id="trigger-button">Open Mode Sheet</button>
          <MobileLaunchModeSheet open onClose={vi.fn()} onPick={vi.fn()} />
        </>,
      );

      expect(document.activeElement).not.toBe(triggerButton);

      // Rerender with dialog closed — focus should be restored
      const onClose = vi.fn();
      rerender(
        <>
          <button id="trigger-button">Open Mode Sheet</button>
          <MobileLaunchModeSheet open={false} onClose={onClose} onPick={vi.fn()} />
        </>,
      );

      expect(document.activeElement).toBe(triggerButton);
    });
  });
});
