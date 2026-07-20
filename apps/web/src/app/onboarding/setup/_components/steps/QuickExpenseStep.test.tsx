import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { QuickExpenseStep } from './QuickExpenseStep';

const apiPostMock = vi.fn();
const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

function renderStep(props: React.ComponentProps<typeof QuickExpenseStep>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QuickExpenseStep {...props} />
    </QueryClientProvider>,
  );
}

describe('QuickExpenseStep', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue([]);
  });

  it('renders tipo options from getExpenseOptions(projectType) — different sets for REFORMA vs PESSOAL', () => {
    const { unmount } = renderStep(
      { projectId: 'p1', projectType: ProjectType.REFORMA, onDone: vi.fn(), onSkip: vi.fn() },
    );
    const reformaOptions = screen.getAllByRole('option').map((o) => o.textContent);
    unmount();

    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    const pessoalOptions = screen.getAllByRole('option').map((o) => o.textContent);

    expect(reformaOptions).not.toEqual(pessoalOptions);
  });

  it('"Criar e continuar" disabled while valor is empty; enabled once a valor is typed', () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });
    const button = screen.getByRole('button', { name: /criar e continuar/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    expect(button).not.toBeDisabled();
  });

  it('submits POST /projects/:id/expenses with the expected shape, then calls onDone', async () => {
    apiPostMock.mockResolvedValue({});
    const onDone = vi.fn();
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/projects/p1/expenses',
      expect.objectContaining({
        valor: 10,
        quantidade: 1,
        formaPagamento: 'A_VISTA',
        status: 'PAGO',
        creditCardId: null,
        bankAccountId: null,
      }),
    ));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('clicking the skip affordance calls onSkip without any api.post call', () => {
    const onSkip = vi.fn();
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip });
    fireEvent.click(screen.getByText(/pular por agora/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('api error keeps the step visible, shows inline error text, does not call onDone', async () => {
    apiPostMock.mockRejectedValue(new Error('Erro ao salvar despesa'));
    const onDone = vi.fn();
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone, onSkip: vi.fn() });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(screen.getByText('Erro ao salvar despesa')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows conta/cartão selects for PESSOAL (has bankAccounts/creditCards features), fetched from tenant-wide endpoints', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/bank-accounts') return Promise.resolve([{ id: 'ba1', nickname: 'Nubank', institution: 'Nubank' }]);
      if (path === '/tenant/credit-cards') return Promise.resolve([{ id: 'cc1', nickname: null, brand: 'Visa', last4: '1234' }]);
      return Promise.resolve([]);
    });
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });

    await waitFor(() => expect(screen.getByText('Nubank')).toBeInTheDocument());
    expect(screen.getByText('Visa ••1234')).toBeInTheDocument();
  });

  it('hides conta/cartão selects for REFORMA (no bankAccounts/creditCards feature)', () => {
    renderStep({ projectId: 'p1', projectType: ProjectType.REFORMA, onDone: vi.fn(), onSkip: vi.fn() });
    expect(screen.queryByLabelText(/conta bancária/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^cartão$/i)).not.toBeInTheDocument();
  });

  it('submits the chosen creditCardId/bankAccountId when selected', async () => {
    apiPostMock.mockResolvedValue({});
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/bank-accounts') return Promise.resolve([{ id: 'ba1', nickname: 'Nubank', institution: 'Nubank' }]);
      if (path === '/tenant/credit-cards') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderStep({ projectId: 'p1', projectType: ProjectType.PESSOAL, onDone: vi.fn(), onSkip: vi.fn() });

    await waitFor(() => expect(screen.getByText('Nubank')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '10,00' } });
    fireEvent.change(screen.getByLabelText(/conta bancária/i), { target: { value: 'ba1' } });
    fireEvent.click(screen.getByRole('button', { name: /criar e continuar/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/projects/p1/expenses',
      expect.objectContaining({ bankAccountId: 'ba1', creditCardId: null }),
    ));
  });
});
