import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { ImportMassStep } from './ImportMassStep';

const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

// Stub modals — call onCommitted when rendered to simulate a completed import
vi.mock(
  '@/app/projects/[projectId]/credit-cards/_components/ImportStatementModal',
  () => ({
    default: ({ onCommitted, onClose }: { onCommitted: () => void; onClose: () => void }) => (
      <div data-testid="import-statement-modal">
        <button onClick={onCommitted}>commit-fatura</button>
        <button onClick={onClose}>close-fatura</button>
      </div>
    ),
  }),
);

vi.mock(
  '@/app/projects/[projectId]/bank-accounts/_components/ImportBankStatementModal',
  () => ({
    default: ({ onCommitted, onClose }: { onCommitted: () => void; onClose: () => void }) => (
      <div data-testid="import-bank-modal">
        <button onClick={onCommitted}>commit-extrato</button>
        <button onClick={onClose}>close-extrato</button>
      </div>
    ),
  }),
);

const defaultProps = {
  projectId: 'p1',
  projectType: ProjectType.PESSOAL,
  onDone: vi.fn(),
  onSkip: vi.fn(),
};

function renderStep(overrides?: Partial<typeof defaultProps>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ImportMassStep {...defaultProps} {...overrides} />
    </QueryClientProvider>,
  );
}

describe('ImportMassStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockResolvedValue([]);
  });

  it('shows skip-only UI when no cards and no accounts', async () => {
    apiGetMock.mockResolvedValue([]);
    renderStep();

    await waitFor(() =>
      expect(
        screen.getByText(/adicione um cartão ou conta bancária/i),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByText(/fatura do cartão/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/extrato da conta/i)).not.toBeInTheDocument();
    expect(screen.getByText(/pular — importar depois/i)).toBeInTheDocument();
  });

  it('shows "Fatura do cartão" button when at least one card exists', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/credit-cards')
        return Promise.resolve([{ id: 'cc1', brand: 'Visa', last4: '1234' }]);
      return Promise.resolve([]);
    });
    renderStep();

    await waitFor(() =>
      expect(screen.getByText(/fatura do cartão/i)).toBeInTheDocument(),
    );
  });

  it('shows "Extrato da conta" button when at least one account exists', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/bank-accounts')
        return Promise.resolve([{ id: 'ba1', institution: 'Nubank' }]);
      return Promise.resolve([]);
    });
    renderStep();

    await waitFor(() =>
      expect(screen.getByText(/extrato da conta/i)).toBeInTheDocument(),
    );
  });

  it('clicking "Pular" calls onSkip without opening any modal', async () => {
    const onSkip = vi.fn();
    renderStep({ onSkip });

    const skipBtn = screen.getByText(/pular — importar depois/i);
    fireEvent.click(skipBtn);

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('import-statement-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('import-bank-modal')).not.toBeInTheDocument();
  });

  it('onCommitted triggers onDone', async () => {
    const onDone = vi.fn();
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/credit-cards')
        return Promise.resolve([{ id: 'cc1', brand: 'Visa', last4: '9999' }]);
      return Promise.resolve([]);
    });
    renderStep({ onDone });

    await waitFor(() =>
      expect(screen.getByText(/fatura do cartão/i)).toBeInTheDocument(),
    );

    // Click "Fatura do cartão" → auto-selects the single card → modal opens
    fireEvent.click(screen.getByText(/fatura do cartão/i));

    await waitFor(() =>
      expect(screen.getByTestId('import-statement-modal')).toBeInTheDocument(),
    );

    // Simulate commit
    fireEvent.click(screen.getByText('commit-fatura'));

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
