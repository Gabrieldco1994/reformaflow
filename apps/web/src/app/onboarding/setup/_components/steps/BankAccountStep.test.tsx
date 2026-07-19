import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectType } from '@reformaflow/domain';
import { BankAccountStep } from './BankAccountStep';

const apiPostMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPostMock(...args),
  },
}));

function fillLast4() {
  fireEvent.change(screen.getAllByPlaceholderText('1234')[0], { target: { value: '1234' } });
}

describe('BankAccountStep', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
  });

  it('renders BankAccountFormModal in bare mode (no fixed inset-0 overlay wrapper present in the DOM)', () => {
    const { container } = render(
      <BankAccountStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={vi.fn()} onSkip={vi.fn()} />,
    );
    expect(container.querySelector('.fixed.inset-0')).not.toBeInTheDocument();
  });

  it('saving successfully (mock api.post resolves) calls onDone exactly once', async () => {
    apiPostMock.mockResolvedValue({});
    const onDone = vi.fn();
    render(<BankAccountStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={onDone} onSkip={vi.fn()} />);
    fillLast4();
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('clicking "Pular por agora" shows the warning card and does NOT call onSkip yet', () => {
    const onSkip = vi.fn();
    render(<BankAccountStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByText(/pular por agora/i));
    expect(screen.getByText(/pular mesmo assim/i)).toBeInTheDocument();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('clicking "Pular mesmo assim" after the warning calls onSkip exactly once', () => {
    const onSkip = vi.fn();
    render(<BankAccountStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByText(/pular por agora/i));
    fireEvent.click(screen.getByText(/pular mesmo assim/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('api.post failure keeps the step visible and does not call onDone or onSkip', async () => {
    apiPostMock.mockRejectedValue(new Error('Erro ao salvar'));
    const onDone = vi.fn();
    const onSkip = vi.fn();
    render(<BankAccountStep projectId="p1" projectType={ProjectType.PESSOAL} onDone={onDone} onSkip={onSkip} />);
    fillLast4();
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(screen.getByText('Erro ao salvar')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });
});
