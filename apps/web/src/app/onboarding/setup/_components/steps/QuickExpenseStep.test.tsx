import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectType } from '@reformaflow/domain';
import { QuickExpenseStep } from './QuickExpenseStep';

const apiPostMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

describe('QuickExpenseStep', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
  });

  it('renders tipo options from getExpenseOptions(projectType) — different sets for REFORMA vs PESSOAL', () => {
    const { unmount } = render(
      <QuickExpenseStep projectId="p1" projectType={ProjectType.REFORMA} onDone={vi.fn()} onSkip={vi.fn()} />,
    );
    const reformaOptions = screen.getAllByRole('option').map((o) => o.textContent);
    unmount();

    render(<QuickExpenseStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={vi.fn()} onSkip={vi.fn()} />);
    const pessoalOptions = screen.getAllByRole('option').map((o) => o.textContent);

    expect(reformaOptions).not.toEqual(pessoalOptions);
  });

  it('"Criar e continuar" disabled while valor is empty; enabled once a valor is typed', () => {
    render(<QuickExpenseStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={vi.fn()} onSkip={vi.fn()} />);
    const button = screen.getByRole('button', { name: /criar e continuar/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    expect(button).not.toBeDisabled();
  });

  it('submits POST /projects/:id/expenses with the expected shape, then calls onDone', async () => {
    apiPostMock.mockResolvedValue({});
    const onDone = vi.fn();
    render(<QuickExpenseStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={onDone} onSkip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/projects/p1/expenses',
      expect.objectContaining({
        valor: 10,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
      }),
    ));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('clicking the skip affordance calls onSkip without any api.post call', () => {
    const onSkip = vi.fn();
    render(<QuickExpenseStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByText(/pular por agora/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('api error keeps the step visible, shows inline error text, does not call onDone', async () => {
    apiPostMock.mockRejectedValue(new Error('Erro ao salvar despesa'));
    const onDone = vi.fn();
    render(<QuickExpenseStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={onDone} onSkip={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(screen.getByText('Erro ao salvar despesa')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });
});
