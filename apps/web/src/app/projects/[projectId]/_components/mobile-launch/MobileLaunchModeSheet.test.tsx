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

  it('mostra os 3 modos e emite o pick de Escrito/Voz', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={onPick} />);

    expect(screen.getByRole('button', { name: /Escrito/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Voz/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Foto/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Escrito/ }));
    expect(onPick).toHaveBeenCalledWith('escrito');

    await user.click(screen.getByRole('button', { name: /^Voz/ }));
    expect(onPick).toHaveBeenCalledWith('voz');
  });

  it('esconde Voz sem suporte do navegador', () => {
    render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={vi.fn()} voiceSupported={false} />);
    expect(screen.queryByRole('button', { name: /^Voz/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Escrito/ })).toBeInTheDocument();
  });

  it('Foto abre a sub-tela e emite fatura/extrato; Voltar retorna à raiz', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<MobileLaunchModeSheet open onClose={vi.fn()} onPick={onPick} />);

    await user.click(screen.getByRole('button', { name: /Foto/ }));
    // Sub-tela: some o modo Escrito, aparecem as duas fontes.
    expect(screen.queryByRole('button', { name: /Escrito/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Foto da fatura/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Foto da fatura/ }));
    expect(onPick).toHaveBeenCalledWith('fatura');

    // Reabre Foto e testa Voltar → raiz mostra Escrito de novo.
    await user.click(screen.getByRole('button', { name: /Foto do extrato/ }));
    expect(onPick).toHaveBeenCalledWith('extrato');
    await user.click(screen.getByRole('button', { name: /Voltar/ }));
    expect(screen.getByRole('button', { name: /Escrito/ })).toBeInTheDocument();
  });
});
