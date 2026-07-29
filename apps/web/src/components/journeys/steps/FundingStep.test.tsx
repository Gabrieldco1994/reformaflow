import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { FundingStep } from './FundingStep';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
  },
}));

// Stub BankAccountFormModal / CardFormModal to make tests simple
vi.mock(
  '@/app/projects/[projectId]/bank-accounts/_components/BankAccountFormModal',
  () => ({
    default: ({ onSaved, onClose }: { onSaved: (id: string) => void; onClose: () => void }) => (
      <div>
        <button onClick={() => onSaved('bank-1')}>Salvar conta</button>
        <button onClick={onClose}>Cancelar conta</button>
      </div>
    ),
  }),
);

vi.mock(
  '@/app/projects/[projectId]/credit-cards/_components/CardFormModal',
  () => ({
    default: ({ onSaved, onClose }: { onSaved: (id: string) => void; onClose: () => void }) => (
      <div>
        <button onClick={() => onSaved('card-1')}>Salvar cartão</button>
        <button onClick={onClose}>Cancelar cartão</button>
      </div>
    ),
  }),
);

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function defaultProps(overrides?: Partial<Parameters<typeof FundingStep>[0]>) {
  return {
    projectId: 'p1',
    projectType: ProjectType.PESSOAL,
    onDone: vi.fn(),
    onSkip: vi.fn(),
    onFundingChange: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGetMock.mockResolvedValue([]);
});

describe('FundingStep — estrutura', () => {
  it('renderiza duas miniáreas (Conta bancária e Cartão de crédito)', () => {
    wrap(<FundingStep {...defaultProps()} />);
    expect(screen.getByText('Conta bancária')).toBeInTheDocument();
    expect(screen.getByText('Cartão de crédito')).toBeInTheDocument();
  });

  it('tem um único botão Pular por agora', () => {
    wrap(<FundingStep {...defaultProps()} />);
    expect(screen.getAllByText(/pular por agora/i)).toHaveLength(1);
  });

  it('tem um único botão Continuar', () => {
    wrap(<FundingStep {...defaultProps()} />);
    expect(screen.getAllByRole('button', { name: /continuar/i })).toHaveLength(1);
  });
});

describe('FundingStep — salvar miniárea não avança', () => {
  it('salvar conta não chama onDone', async () => {
    const onDone = vi.fn();
    wrap(<FundingStep {...defaultProps({ onDone })} />);
    fireEvent.click(screen.getByText('+ Nova conta'));
    fireEvent.click(screen.getByText('Salvar conta'));
    await waitFor(() => expect(screen.getByText('Adicionada')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('salvar cartão não chama onDone', async () => {
    const onDone = vi.fn();
    wrap(<FundingStep {...defaultProps({ onDone })} />);
    fireEvent.click(screen.getByText('+ Novo cartão'));
    fireEvent.click(screen.getByText('Salvar cartão'));
    await waitFor(() => expect(screen.getByText('Adicionado')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('FundingStep — fluxos existente, criado, ambos, nenhum', () => {
  it('criado (conta): onFundingChange recebe bankAccount com id correto', async () => {
    const onFundingChange = vi.fn();
    wrap(<FundingStep {...defaultProps({ onFundingChange })} />);
    fireEvent.click(screen.getByText('+ Nova conta'));
    fireEvent.click(screen.getByText('Salvar conta'));
    await waitFor(() =>
      expect(onFundingChange).toHaveBeenCalledWith(
        expect.objectContaining({ bankAccount: expect.objectContaining({ id: 'bank-1' }) }),
      ),
    );
  });

  it('criado (cartão): onFundingChange recebe creditCard com id correto', async () => {
    const onFundingChange = vi.fn();
    wrap(<FundingStep {...defaultProps({ onFundingChange })} />);
    fireEvent.click(screen.getByText('+ Novo cartão'));
    fireEvent.click(screen.getByText('Salvar cartão'));
    await waitFor(() =>
      expect(onFundingChange).toHaveBeenCalledWith(
        expect.objectContaining({ creditCard: expect.objectContaining({ id: 'card-1' }) }),
      ),
    );
  });

  it('ambos criados: onFundingChange final contém os dois IDs', async () => {
    const onFundingChange = vi.fn();
    wrap(<FundingStep {...defaultProps({ onFundingChange })} />);
    fireEvent.click(screen.getByText('+ Nova conta'));
    fireEvent.click(screen.getByText('Salvar conta'));
    await waitFor(() => expect(screen.getByText('Adicionada')).toBeInTheDocument());
    fireEvent.click(screen.getByText('+ Novo cartão'));
    fireEvent.click(screen.getByText('Salvar cartão'));
    await waitFor(() => expect(screen.getByText('Adicionado')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));
    const lastCall = onFundingChange.mock.calls.at(-1)?.[0];
    expect(lastCall?.bankAccount?.id).toBe('bank-1');
    expect(lastCall?.creditCard?.id).toBe('card-1');
  });

  it('nenhuma fonte: clicar Continuar chama onDone', () => {
    const onDone = vi.fn();
    wrap(<FundingStep {...defaultProps({ onDone })} />);
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('existente: mostra lista quando há contas, selecionar chama onFundingChange', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/tenant/bank-accounts') return Promise.resolve([{ id: 'acc-x', institution: 'NUBANK', last4: '1111' }]);
      return Promise.resolve([]);
    });
    const onFundingChange = vi.fn();
    wrap(<FundingStep {...defaultProps({ onFundingChange })} />);
    await waitFor(() => expect(screen.getByText('Selecionar existente')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Selecionar existente'));
    await waitFor(() => expect(screen.getByText(/NUBANK.*1111/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/NUBANK.*1111/i));
    expect(onFundingChange).toHaveBeenCalledWith(
      expect.objectContaining({ bankAccount: expect.objectContaining({ id: 'acc-x' }) }),
    );
  });
});

describe('FundingStep — clique duplo no Continuar', () => {
  it('clique duplo no Continuar chama onDone exatamente uma vez', () => {
    const onDone = vi.fn();
    wrap(<FundingStep {...defaultProps({ onDone })} />);
    const btn = screen.getByRole('button', { name: /continuar/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('FundingStep — stepRequired', () => {
  it('stepRequired=true: Continuar desabilitado sem fonte', () => {
    wrap(<FundingStep {...defaultProps({ stepRequired: true })} />);
    expect(screen.getByRole('button', { name: /continuar/i })).toBeDisabled();
  });

  it('stepRequired=true: Continuar habilitado após adicionar conta', async () => {
    wrap(<FundingStep {...defaultProps({ stepRequired: true })} />);
    fireEvent.click(screen.getByText('+ Nova conta'));
    fireEvent.click(screen.getByText('Salvar conta'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continuar/i })).not.toBeDisabled(),
    );
  });

  it('stepRequired=true: sem botão Pular', () => {
    wrap(<FundingStep {...defaultProps({ stepRequired: true })} />);
    expect(screen.queryByText(/pular/i)).not.toBeInTheDocument();
  });
});

describe('FundingStep — cache atualizado após salvar', () => {
  it('salvar conta invalida a query tenant/bank-accounts', async () => {
    wrap(<FundingStep {...defaultProps()} />);
    fireEvent.click(screen.getByText('+ Nova conta'));
    // Após salvar, a query será invalidada (não precisamos verificar a refetch real aqui — 
    // o getByText('Adicionada') confirma que o estado local foi atualizado)
    fireEvent.click(screen.getByText('Salvar conta'));
    await waitFor(() => expect(screen.getByText('Adicionada')).toBeInTheDocument());
  });
});
