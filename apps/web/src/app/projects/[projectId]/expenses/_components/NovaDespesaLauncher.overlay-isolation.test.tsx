import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NovaDespesaLauncher } from './NovaDespesaLauncher';

/**
 * #659 F3 — stacked overlays / background isolation.
 * When the Carteira importer opens, the account-picker <Modal> MUST unmount
 * (no second "Fechar", no second "Nova conta"). Cancel/Escape return to the
 * picker with focus on "Importar para Carteira"; Concluir ends the flow and
 * does NOT reopen the picker.
 */

let mockHasModule: (slug: string) => boolean = () => true;
const apiGet = vi.fn();
let onCommittedSpy: (() => void) | null = null;
let onCloseSpy: (() => void) | null = null;

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { name: 'Teste' }, hasModule: (slug: string) => mockHasModule(slug) }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...(args as [string])),
    post: vi.fn().mockResolvedValue({ id: 'new-1' }),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/p1/conta',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../_hooks/useVoiceExpense', () => ({
  useVoiceExpense: () => ({ openVoiceModal: vi.fn(), closeVoiceModal: vi.fn(), voiceModalOpen: false }),
}));
vi.mock('./NovaDespesaWizard', () => ({ NovaDespesaWizard: () => null }));
vi.mock('./RecorrenteWizard', () => ({ RecorrenteWizard: () => null }));
vi.mock('./VoiceExpenseModal', () => ({ VoiceExpenseModal: () => null }));
vi.mock('../../credit-cards/_components/ImportStatementModal', () => ({ default: () => null }));
vi.mock('../../bank-accounts/_components/ImportBankStatementModal', () => ({ default: () => null }));
vi.mock('../../conta/_components/ReceitaModal', () => ({ ReceitaModal: () => null }));
vi.mock('../../_components/SemCartaoEmptyState', () => ({
  SemCartaoEmptyState: () => <div data-testid="sem-cartao-empty" />,
}));
vi.mock('../../_components/SemContaEmptyState', () => {
  const SemContaEmptyState = () => (
    <div data-testid="sem-conta-empty">
      <button type="button">Nova conta</button>
    </div>
  );
  return { SemContaEmptyState, default: SemContaEmptyState };
});
// Light stub of the real importer: renders its own "Fechar" so we can assert
// there is exactly ONE reachable at a time.
vi.mock('../../bank-accounts/_components/ImportWithoutAccountModal', () => ({
  default: ({ onClose, onCommitted }: { onClose: () => void; onCommitted: () => void }) => {
    onCloseSpy = onClose;
    onCommittedSpy = onCommitted;
    return (
      <div data-testid="import-without-account" role="dialog" aria-modal="true">
        <button type="button" aria-label="Fechar">x</button>
        <button type="button" onClick={onClose}>stub-cancelar</button>
        <button type="button" onClick={onCommitted}>stub-commit</button>
      </div>
    );
  },
}));

function renderLauncher(importAccounts: Array<Record<string, unknown>> = []) {
  apiGet.mockReset();
  apiGet.mockImplementation((path: string) => {
    if (path === '/projects/p1/bank-accounts') return Promise.resolve(importAccounts);
    return Promise.resolve([]);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['tenant', 'credit-cards'], []);
  client.setQueryData(['tenant', 'bank-accounts'], []);
  client.setQueryData(['tenant', 'projects'], []);
  client.setQueryData(['credit-cards', 'p1'], []);
  return render(
    <QueryClientProvider client={client}>
      <NovaDespesaLauncher
        projectId="p1"
        projectType="PESSOAL"
        trigger={(open) => (
          <button type="button" onClick={open}>abrir</button>
        )}
      />
    </QueryClientProvider>,
  );
}

async function abrirCarteira() {
  fireEvent.click(screen.getByRole('button', { name: 'abrir' }));
  fireEvent.click(screen.getByRole('button', { name: /Extrato bancário/i }));
  const cta = await screen.findByRole('button', { name: 'Importar para Carteira' });
  fireEvent.click(cta);
  return cta;
}

describe('#659 F3 — NovaDespesaLauncher background isolation', () => {
  beforeEach(() => {
    mockHasModule = () => true;
    onCommittedSpy = null;
    onCloseSpy = null;
  });

  it('abrir a Carteira desmonta o picker: exatamente um "Fechar" e nenhum "Nova conta"', async () => {
    renderLauncher([]);
    await abrirCarteira();

    await waitFor(() => {
      expect(screen.getByTestId('import-without-account')).toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: 'Fechar' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Nova conta' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Para qual conta é esse extrato/i)).not.toBeInTheDocument();
  });

  it('cancelar volta ao picker e devolve o foco para "Importar para Carteira"', async () => {
    renderLauncher([]);
    await abrirCarteira();
    onCloseSpy?.();

    const cta = await screen.findByRole('button', { name: 'Importar para Carteira' });
    expect(screen.queryByTestId('import-without-account')).not.toBeInTheDocument();
    await waitFor(() => expect(cta).toHaveFocus());
  });

  it('concluir encerra o fluxo: picker NÃO reabre', async () => {
    renderLauncher([]);
    await abrirCarteira();
    onCommittedSpy?.();

    await waitFor(() => {
      expect(screen.queryByTestId('import-without-account')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Para qual conta é esse extrato/i)).not.toBeInTheDocument();
  });
});
