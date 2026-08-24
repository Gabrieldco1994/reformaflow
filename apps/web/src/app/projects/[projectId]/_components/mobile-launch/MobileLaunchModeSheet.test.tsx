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
});
