import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FeedbackStep } from './FeedbackStep';

const apiPostMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => apiPostMock(...args) },
}));

describe('FeedbackStep', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
  });

  it('tocar numa estrela seleciona a nota (1-5 estrelas preenchidas até ela)', () => {
    render(<FeedbackStep onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '4 estrelas' }));
    expect(screen.getByText('Fácil')).toBeInTheDocument();
  });

  it('envia rating + mensagem para o MESMO recurso /feedback e chama onDone', async () => {
    apiPostMock.mockResolvedValue({ ok: true });
    const onDone = vi.fn();
    render(<FeedbackStep onDone={onDone} />);

    fireEvent.click(screen.getByRole('button', { name: '5 estrelas' }));
    fireEvent.change(screen.getByPlaceholderText(/quer contar mais/i), {
      target: { value: 'Achei ótimo!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /enviar e concluir/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/feedback', {
      message: 'Achei ótimo!',
      rating: 5,
    }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('"Pular" avança sem enviar nada', () => {
    const onDone = vi.fn();
    render(<FeedbackStep onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pular' }));
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('erro de rede não trava a conclusão (feedback é acessório)', async () => {
    apiPostMock.mockRejectedValue(new Error('network'));
    const onDone = vi.fn();
    render(<FeedbackStep onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: '3 estrelas' }));
    fireEvent.click(screen.getByRole('button', { name: /enviar e concluir/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
