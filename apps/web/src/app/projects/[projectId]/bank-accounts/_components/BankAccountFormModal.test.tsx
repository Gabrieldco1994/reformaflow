import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BankAccountFormModal from './BankAccountFormModal';

const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: vi.fn(),
  },
}));

vi.mock(
  '@/app/projects/[projectId]/bank-accounts/_components/RecebimentosVinculadorModal',
  () => ({
    default: () => <div data-testid="recebimentos-modal" />,
  }),
);

function fillLast4() {
  fireEvent.change(screen.getAllByPlaceholderText('1234')[0], { target: { value: '1234' } });
}

function wrap(ui: React.ReactElement) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('BankAccountFormModal', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
    toastSuccessMock.mockReset();
    apiPostMock.mockResolvedValue({
      bankAccount: { id: 'ba1' },
      receiptsWithoutAccount: [],
    });
  });

  it('hideCancel=false (default): "Cancelar" button is present', () => {
    wrap(
      <BankAccountFormModal projectId="p1" account={null} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText('Cancelar')).toBeInTheDocument();
  });

  it('hideCancel=true: "Cancelar" button is absent, "Salvar" is still present and still calls onSaved on success', async () => {
    const onSaved = vi.fn();
    wrap(
      <BankAccountFormModal projectId="p1" account={null} onClose={vi.fn()} onSaved={onSaved} hideCancel />,
    );
    expect(screen.queryByText('Cancelar')).not.toBeInTheDocument();
    fillLast4();
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('ba1'));
  });

  it('usa bankAccount.id da resposta canônica do POST', async () => {
    const onSaved = vi.fn();
    wrap(
      <BankAccountFormModal
        projectId="p1"
        account={null}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fillLast4();
    fireEvent.click(screen.getByText('Salvar'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('ba1'));
  });

  it('mantém o formulário aberto e mostra erro quando o PATCH falha', async () => {
    apiPatchMock.mockRejectedValue(new Error('Conta não encontrada'));
    const onSaved = vi.fn();
    wrap(
      <BankAccountFormModal
        projectId="p1"
        account={{
          id: 'acc-b',
          institution: 'NUBANK',
          nickname: 'Conta B',
          last4: '2222',
          agency: null,
          accountNumber: null,
        }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByText('Salvar'));

    expect(await screen.findByText('Conta não encontrada')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Editar conta' })).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});
