import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectType } from '@reformaflow/domain';
import { QuickReceiptStep } from './QuickReceiptStep';

const apiPostMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

describe('QuickReceiptStep', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
  });

  it('"Criar e continuar" disabled while valor is empty; enabled once a valor is typed', () => {
    render(<QuickReceiptStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={vi.fn()} onSkip={vi.fn()} />);
    const button = screen.getByRole('button', { name: /criar e continuar/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    expect(button).not.toBeDisabled();
  });

  it('submits POST /projects/:id/receipts with {valor, data, tipo, status: PREVISTO}, then calls onDone', async () => {
    apiPostMock.mockResolvedValue({});
    const onDone = vi.fn();
    render(<QuickReceiptStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={onDone} onSkip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/projects/p1/receipts',
      expect.objectContaining({ valor: 10, status: 'PREVISTO' }),
    ));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('clicking the skip affordance calls onSkip without any api.post call', () => {
    const onSkip = vi.fn();
    render(<QuickReceiptStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByText(/pular por agora/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('api error keeps the step visible, shows inline error text, does not call onDone', async () => {
    apiPostMock.mockRejectedValue(new Error('Erro ao salvar recebimento'));
    const onDone = vi.fn();
    render(<QuickReceiptStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={onDone} onSkip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(screen.getByText('Erro ao salvar recebimento')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });
});
