import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NovaDespesaLauncher } from './NovaDespesaLauncher';

/**
 * #218 (W5) — o `NovaDespesaLauncher` cabeia `onImportAccount` INCONDICIONALMENTE
 * no `PayOptionsModal` (~L159). Defensivo: hoje só a Visão Conta (PESSOAL) o
 * monta, mas o teste da #655 montou com REFORMA e passou verde com o dead-end
 * ativo. Gate correto: `hasFeature(type,'bankAccounts') && hasModule('bankAccounts')`.
 */

let mockHasModule: (slug: string) => boolean = () => true;

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { name: 'Teste' }, hasModule: (slug: string) => mockHasModule(slug) }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
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
  SemCartaoEmptyState: ({ projectId }: { projectId: string }) => (
    <div data-testid="sem-cartao-empty" data-pid={projectId} />
  ),
}));
vi.mock('../../_components/SemContaEmptyState', () => {
  const SemContaEmptyState = ({ projectId }: { projectId: string }) => (
    <div data-testid="sem-conta-empty" data-pid={projectId} />
  );
  return { SemContaEmptyState, default: SemContaEmptyState };
});

function renderLauncher(projectType: string, importAccounts: Array<Record<string, unknown>> = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['tenant', 'credit-cards'], []);
  client.setQueryData(['tenant', 'bank-accounts'], []);
  client.setQueryData(['tenant', 'projects'], []);
  client.setQueryData(['credit-cards', 'p1'], []);
  client.setQueryData(['bank-accounts', 'p1'], importAccounts);
  return render(
    <QueryClientProvider client={client}>
      <NovaDespesaLauncher
        projectId="p1"
        projectType={projectType}
        trigger={(open) => (
          <button type="button" onClick={open}>
            abrir
          </button>
        )}
      />
    </QueryClientProvider>,
  );
}

function abrirMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'abrir' }));
}

describe('NovaDespesaLauncher — gate de import de extrato (#218)', () => {
  beforeEach(() => {
    mockHasModule = () => true;
  });

  it('REFORMA: sem botão "Extrato bancário"', () => {
    renderLauncher('REFORMA');
    abrirMenu();
    expect(screen.queryByRole('button', { name: /Extrato bancário/i })).not.toBeInTheDocument();
  });

  it('REFORMA: "Fatura de cartão" continua presente (não regride)', () => {
    renderLauncher('REFORMA');
    abrirMenu();
    expect(screen.getByRole('button', { name: /Fatura de cartão/i })).toBeInTheDocument();
  });

  it('PESSOAL + hasModule true: "Extrato bancário" presente', () => {
    mockHasModule = () => true;
    renderLauncher('PESSOAL');
    abrirMenu();
    expect(screen.getByRole('button', { name: /Extrato bancário/i })).toBeInTheDocument();
  });

  it('PESSOAL + hasModule false: "Extrato bancário" AUSENTE', () => {
    mockHasModule = (slug) => slug !== 'bankAccounts';
    renderLauncher('PESSOAL');
    abrirMenu();
    expect(screen.queryByRole('button', { name: /Extrato bancário/i })).not.toBeInTheDocument();
  });

  it('PESSOAL + hasModule true, sem conta: picker mostra SemContaEmptyState, sem texto morto', () => {
    mockHasModule = () => true;
    renderLauncher('PESSOAL', []);
    abrirMenu();
    fireEvent.click(screen.getByRole('button', { name: /Extrato bancário/i }));

    expect(screen.getByTestId('sem-conta-empty')).toHaveAttribute('data-pid', 'p1');
    expect(screen.queryByText(/Nenhuma conta cadastrada\. Cadastre em/)).not.toBeInTheDocument();
  });
});
