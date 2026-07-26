import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { ImportMassStep } from './ImportMassStep';
import type { OnboardingFunding } from '../../_types';

const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => apiGetMock(...args) },
}));

vi.mock(
  '@/app/projects/[projectId]/credit-cards/_components/ImportStatementModal',
  () => ({
    default: ({ onClose, onCommitted }: { onClose: () => void; onCommitted: () => void }) => (
      <div data-testid="import-fatura">
        <button onClick={onCommitted}>Commitar fatura</button>
        <button onClick={onClose}>Fechar fatura</button>
      </div>
    ),
  }),
);

vi.mock(
  '@/app/projects/[projectId]/bank-accounts/_components/ImportBankStatementModal',
  () => ({
    default: ({ onClose, onCommitted }: { onClose: () => void; onCommitted: () => void }) => (
      <div data-testid="import-extrato">
        <button onClick={onCommitted}>Commitar extrato</button>
        <button onClick={onClose}>Fechar extrato</button>
      </div>
    ),
  }),
);

vi.mock('@/app/projects/[projectId]/_components/SemCartaoEmptyState', () => ({
  SemCartaoEmptyState: () => <div data-testid="sem-cartao" />,
}));

const CARD = { id: 'cc1', brand: 'Visa', last4: '1234', nickname: null };
const ACCOUNT = { id: 'ba1', institution: 'NUBANK', last4: '5678', nickname: null };

const cardFunding: OnboardingFunding = {
  bankAccount: null,
  creditCard: { kind: 'creditCard', id: 'cc1', ownerProjectId: 'p1', origin: 'created' },
};
const accountFunding: OnboardingFunding = {
  bankAccount: { kind: 'bankAccount', id: 'ba1', ownerProjectId: 'p1', origin: 'created' },
  creditCard: null,
};
const bothFunding: OnboardingFunding = {
  bankAccount: { kind: 'bankAccount', id: 'ba1', ownerProjectId: 'p1', origin: 'created' },
  creditCard: { kind: 'creditCard', id: 'cc1', ownerProjectId: 'p1', origin: 'created' },
};

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function defaultProps(overrides = {}) {
  return {
    projectId: 'p1',
    projectType: ProjectType.PESSOAL,
    onDone: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path === '/tenant/credit-cards') return Promise.resolve([CARD]);
    if (path === '/tenant/bank-accounts') return Promise.resolve([ACCOUNT]);
    return Promise.resolve([]);
  });
});

describe('ImportMassStep — auto-abre com cartão preferido', () => {
  it('cartão preferido válido: abre ImportStatementModal diretamente', async () => {
    wrap(<ImportMassStep {...defaultProps({ funding: cardFunding })} />);
    await waitFor(() => expect(screen.getByTestId('import-fatura')).toBeInTheDocument());
  });

  it('conta preferida válida: abre ImportBankStatementModal diretamente', async () => {
    wrap(<ImportMassStep {...defaultProps({ funding: accountFunding })} />);
    await waitFor(() => expect(screen.getByTestId('import-extrato')).toBeInTheDocument());
  });

  it('ambos: não auto-abre — exibe botões de escolha Extrato/Fatura', async () => {
    wrap(<ImportMassStep {...defaultProps({ funding: bothFunding })} />);
    await waitFor(() => {
      expect(screen.queryByTestId('import-fatura')).not.toBeInTheDocument();
      expect(screen.queryByTestId('import-extrato')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Fatura do cartão')).toBeInTheDocument();
    expect(screen.getByText('Extrato da conta')).toBeInTheDocument();
  });
});

describe('ImportMassStep — preferido vence mesmo com múltiplas fontes', () => {
  it('cartão preferido cc1 auto-abre fatura mesmo havendo cc2 no sistema', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/credit-cards') return Promise.resolve([CARD, { id: 'cc2', brand: 'Master', last4: '9999', nickname: null }]);
      if (path === '/tenant/bank-accounts') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    wrap(<ImportMassStep {...defaultProps({ funding: cardFunding })} />);
    await waitFor(() => expect(screen.getByTestId('import-fatura')).toBeInTheDocument());
  });
});

describe('ImportMassStep — ID stale não abre modal', () => {
  it('cartão preferido não existe nas queries: não auto-abre', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/credit-cards') return Promise.resolve([]); // cc1 removido
      if (path === '/tenant/bank-accounts') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    wrap(<ImportMassStep {...defaultProps({ funding: cardFunding })} />);
    await waitFor(() => expect(screen.queryByTestId('import-fatura')).not.toBeInTheDocument());
  });
});

describe('ImportMassStep — fechar modal não reabre', () => {
  it('fechar fatura não reabre automaticamente', async () => {
    wrap(<ImportMassStep {...defaultProps({ funding: cardFunding })} />);
    await waitFor(() => expect(screen.getByTestId('import-fatura')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Fechar fatura'));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('import-fatura')).not.toBeInTheDocument();
  });
});

describe('ImportMassStep — sem fonte', () => {
  it('sem funding e sem fontes no sistema: exibe estado vazio', async () => {
    apiGetMock.mockResolvedValue([]);
    wrap(<ImportMassStep {...defaultProps()} />);
    await waitFor(() => expect(screen.getByText(/nenhuma fonte configurada/i)).toBeInTheDocument());
  });
});

describe('ImportMassStep — commit e skip', () => {
  it('commitar fatura chama onDone uma vez', async () => {
    const onDone = vi.fn();
    wrap(<ImportMassStep {...defaultProps({ onDone, funding: cardFunding })} />);
    await waitFor(() => screen.getByTestId('import-fatura'));
    fireEvent.click(screen.getByText('Commitar fatura'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('commitar extrato chama onDone uma vez', async () => {
    const onDone = vi.fn();
    wrap(<ImportMassStep {...defaultProps({ onDone, funding: accountFunding })} />);
    await waitFor(() => screen.getByTestId('import-extrato'));
    fireEvent.click(screen.getByText('Commitar extrato'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('skip chama onSkip uma vez', async () => {
    apiGetMock.mockResolvedValue([]);
    const onSkip = vi.fn();
    wrap(<ImportMassStep {...defaultProps({ onSkip })} />);
    await waitFor(() => screen.getByText(/pular — importar depois/i));
    fireEvent.click(screen.getByText(/pular — importar depois/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
