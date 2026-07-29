import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectType } from '@reformaflow/domain';
import { CarInfoStep } from './CarInfoStep';

const apiPutMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    put: (...args: unknown[]) => apiPutMock(...args),
  },
}));

describe('CarInfoStep', () => {
  beforeEach(() => {
    apiPutMock.mockReset();
  });

  it('"Criar e continuar" disabled with marca empty; enabled once marca has at least 1 character', () => {
    render(<CarInfoStep projectId="p1" projectType={ProjectType.CARRO} onDone={vi.fn()} onSkip={vi.fn()} />);
    const button = screen.getByRole('button', { name: /criar e continuar/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/marca/i), { target: { value: 'T' } });
    expect(button).not.toBeDisabled();
  });

  it('successful PUT /projects/:id/car-info calls onDone', async () => {
    apiPutMock.mockResolvedValue({});
    const onDone = vi.fn();
    render(<CarInfoStep projectId="p1" projectType={ProjectType.CARRO} onDone={onDone} onSkip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/marca/i), { target: { value: 'Toyota' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() =>
      expect(apiPutMock).toHaveBeenCalledWith(
        '/projects/p1/car-info',
        expect.objectContaining({ marca: 'Toyota' }),
      ),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('skip button calls onSkip without any api.put call, even with fields partially filled', () => {
    const onSkip = vi.fn();
    render(<CarInfoStep projectId="p1" projectType={ProjectType.CARRO} onDone={vi.fn()} onSkip={onSkip} />);
    fireEvent.change(screen.getByLabelText(/modelo/i), { target: { value: 'Corolla' } });
    fireEvent.click(screen.getByText(/pular por agora/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(apiPutMock).not.toHaveBeenCalled();
  });

  it('api error keeps the step visible, shows inline error text, does not call onDone', async () => {
    apiPutMock.mockRejectedValue(new Error('Erro ao salvar dados do carro'));
    const onDone = vi.fn();
    render(<CarInfoStep projectId="p1" projectType={ProjectType.CARRO} onDone={onDone} onSkip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/marca/i), { target: { value: 'Toyota' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(screen.getByText('Erro ao salvar dados do carro')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });
});
