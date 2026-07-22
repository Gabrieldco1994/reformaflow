import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { ImportMassStep } from './ImportMassStep';

const apiGetMock = vi.fn();
const mockPush = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
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

function renderStep(
  overrides?: Partial<typeof defaultProps>,
  precache?: { cards?: unknown[]; accounts?: unknown[] },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (precache?.cards) client.setQueryData(['tenant', 'credit-cards'], precache.cards);
  if (precache?.accounts) client.setQueryData(['tenant', 'bank-accounts'], precache.accounts);
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

  it('shows "Fatura do cartão" even with no cards and no accounts, and clicking it opens the empty state (not "Extrato")', async () => {
    apiGetMock.mockResolvedValue([]);
    renderStep();

    await waitFor(() =>
      expect(screen.getByText(/fatura do cartão/i)).toBeInTheDocument(),
    );

    // "Extrato da conta" continua sem conta cadastrada — a correção é só o cartão.
    expect(screen.queryByText(/extrato da conta/i)).not.toBeInTheDocument();
    expect(screen.getByText(/pular — importar depois/i)).toBeInTheDocument();

    // Clicar em "Fatura do cartão" sem cartão cadastrado abre o empty state (#248),
    // permitindo cadastrar sem sair do onboarding — não uma tela em branco nem "Extrato".
    fireEvent.click(screen.getByText(/fatura do cartão/i));
    await waitFor(() =>
      expect(screen.getByText(/nenhum cartão cadastrado/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('import-statement-modal')).not.toBeInTheDocument();
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
    // Precarrega o cache para evitar corrida: agora "Fatura do cartão" renderiza
    // antes do fetch resolver (é sempre visível), então o clique precisa achar
    // cards.length já resolvido para 1 e auto-selecionar em vez de abrir o picker.
    renderStep({ onDone }, { cards: [{ id: 'cc1', brand: 'Visa', last4: '9999' }] });

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
