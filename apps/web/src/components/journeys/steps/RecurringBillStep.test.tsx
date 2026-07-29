import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectType } from '@reformaflow/domain';
import { RecurringBillStep } from './RecurringBillStep';

const apiPostMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPostMock(...args),
  },
}));

describe('RecurringBillStep', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
  });

  it('renders RecurringBillFormModal in bare mode with nome/valor/categoria/frequencia/diaVencimento fields', () => {
    const { container } = render(
      <RecurringBillStep projectId="p1" projectType={ProjectType.CASA} onDone={vi.fn()} onSkip={vi.fn()} />,
    );
    expect(container.querySelector('.fixed.inset-0')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nome da conta')).toBeInTheDocument();
    expect(screen.getByLabelText(/valor/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/dia vencimento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/categoria/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/frequência/i)).toBeInTheDocument();
  });

  it('saving successfully calls onDone', async () => {
    apiPostMock.mockResolvedValue({});
    const onDone = vi.fn();
    render(<RecurringBillStep projectId="p1" projectType={ProjectType.CASA} onDone={onDone} onSkip={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Nome da conta'), { target: { value: 'Luz' } });
    fireEvent.click(screen.getByRole('button', { name: /criar/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('clicking the skip affordance calls onSkip without any api call', () => {
    const onSkip = vi.fn();
    render(<RecurringBillStep projectId="p1" projectType={ProjectType.CASA} onDone={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByText('Cancelar'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
