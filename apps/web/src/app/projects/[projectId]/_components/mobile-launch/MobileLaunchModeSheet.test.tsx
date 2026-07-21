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

  it('mostra despesa/planejar/recebimento/foto e emite pick', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={onPick} />);

    expect(screen.getByRole('button', { name: /^Despesa Teclado rápido/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Planejar/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Recebimento/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Voz/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Foto/ })).toBeInTheDocument();

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

  it('Foto abre a sub-tela e emite fatura/extrato; Voltar retorna à raiz', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={onPick} />);

    await user.click(screen.getByRole('button', { name: /Foto/ }));
    // Sub-tela: some o modo Despesa, aparecem as duas fontes.
    expect(screen.queryByRole('button', { name: /^Despesa Teclado rápido/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Foto da fatura/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Foto da fatura/ }));
    expect(onPick).toHaveBeenCalledWith('fatura');

    // Reabre Foto e testa Voltar → raiz mostra Despesa de novo.
    await user.click(screen.getByRole('button', { name: /Foto do extrato/ }));
    expect(onPick).toHaveBeenCalledWith('extrato');
    await user.click(screen.getByRole('button', { name: /Voltar/ }));
    expect(screen.getByRole('button', { name: /^Despesa Teclado rápido/i })).toBeInTheDocument();
  });
});
