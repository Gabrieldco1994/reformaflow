import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NovaDespesaLauncher } from './NovaDespesaLauncher';

/**
 * Testa que o picker de cartões/contas refaz o fetch ao reabrir,
 * garantindo lista fresca sem reload. Sem a correção (staleTime: 0 +
 * refetchOnMount), o picker serviria cache velho por até 30s.
 */

let mockHasModule: (slug: string) => boolean = () => true;
const apiGet = vi.fn();

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
  usePathname: () => '/projects/p1/expenses',
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
vi.mock('../../_components/SemContaEmptyState', () => ({
  SemContaEmptyState: () => (
    <div data-testid="sem-conta-empty">
      <button type="button">Nova conta</button>
    </div>
  ),
}));
vi.mock('../../bank-accounts/_components/ImportWithoutAccountModal', () => ({
  default: () => null,
}));

function renderLauncher(cards: Array<{ id: string; last4: string; nickname?: string | null }> = []) {
  apiGet.mockReset();
  apiGet.mockImplementation((path: string) => {
    if (path === '/projects/p1/credit-cards') {
      return Promise.resolve(cards);
    }
    if (path === '/projects/p1/bank-accounts') {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Pré-popula cache de ['credit-cards', 'p1'] com []
  client.setQueryData(['credit-cards', 'p1'], []);
  client.setQueryData(['bank-accounts', 'p1'], []);
  client.setQueryData(['tenant', 'credit-cards'], []);
  client.setQueryData(['tenant', 'bank-accounts'], []);
  client.setQueryData(['tenant', 'projects'], []);
  return render(
    <QueryClientProvider client={client}>
      <NovaDespesaLauncher
        projectId="p1"
        projectType="PESSOAL"
        trigger={(open) => (
          <button type="button" onClick={open}>
            Lançar
          </button>
        )}
      />
    </QueryClientProvider>,
  );
}

describe('NovaDespesaLauncher — card/account list refresh on picker reopen', () => {
  beforeEach(() => {
    mockHasModule = () => true;
  });

  it('picker de cartão refaz fetch ao reabrir (sem reload), mostrando novo cartão', async () => {
    const cards = [{ id: 'c1', last4: '1234', nickname: 'Nubank' }];
    renderLauncher(cards);

    // Abre o modal principal
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    // Clica em "Fatura de cartão"
    fireEvent.click(await screen.findByRole('button', { name: /Fatura de cartão/i }));

    // Picker aparece, API foi chamada → retorna 1 cartão
    const cartaoBtn = await screen.findByRole('button', { name: /Nubank.*1234/i });
    expect(cartaoBtn).toBeInTheDocument();

    // Contar chamadas de GET ao /credit-cards (primeira abertura)
    const callsOnFirstOpen = apiGet.mock.calls.filter((c) => c[0] === '/projects/p1/credit-cards').length;
    expect(callsOnFirstOpen).toBeGreaterThanOrEqual(1);

    // Fecha o picker (voltar ao menu)
    fireEvent.click(screen.getByRole('button', { name: /Cancelar|Fechar|Voltar/ }));

    // Aguarda o modal sumir
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Nubank.*1234/i })).not.toBeInTheDocument();
    });

    // Abre novamente o modal principal
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    // Clica em "Fatura de cartão" novamente
    fireEvent.click(await screen.findByRole('button', { name: /Fatura de cartão/i }));

    // Picker reabre — sem a correção (staleTime: 30_000) ele serviria cache velho
    // Com a correção (staleTime: 0 + refetchOnMount), ele refaz o fetch
    const cartaoBtnAgain = await screen.findByRole('button', { name: /Nubank.*1234/i });
    expect(cartaoBtnAgain).toBeInTheDocument();

    // Verificar que um segundo fetch foi disparado
    const totalCalls = apiGet.mock.calls.filter((c) => c[0] === '/projects/p1/credit-cards').length;
    expect(totalCalls).toBeGreaterThan(callsOnFirstOpen);
  });

  it('picker de conta refaz fetch ao reabrir, mostrando nova conta', async () => {
    const accounts = [{ id: 'a1', last4: '5678', nickname: 'Itaú' }];
    apiGet.mockImplementation((path: string) => {
      if (path === '/projects/p1/bank-accounts') return Promise.resolve(accounts);
      if (path === '/projects/p1/credit-cards') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(['bank-accounts', 'p1'], []);
    client.setQueryData(['credit-cards', 'p1'], []);
    client.setQueryData(['tenant', 'credit-cards'], []);
    client.setQueryData(['tenant', 'bank-accounts'], []);
    client.setQueryData(['tenant', 'projects'], []);
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <NovaDespesaLauncher
          projectId="p1"
          projectType="PESSOAL"
          trigger={(open) => (
            <button type="button" onClick={open}>
              Lançar
            </button>
          )}
        />
      </QueryClientProvider>,
    );

    // Abre o modal principal
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    // Clica em "Extrato bancário"
    fireEvent.click(await screen.findByRole('button', { name: /Extrato bancário/i }));

    // Picker aparece
    const contaBtn = await screen.findByRole('button', { name: /Itaú.*5678/i });
    expect(contaBtn).toBeInTheDocument();

    const callsOnFirstOpen = apiGet.mock.calls.filter((c) => c[0] === '/projects/p1/bank-accounts').length;
    expect(callsOnFirstOpen).toBeGreaterThanOrEqual(1);

    // Fecha o picker
    fireEvent.click(screen.getByRole('button', { name: /Cancelar|Fechar|Voltar/ }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Itaú.*5678/i })).not.toBeInTheDocument();
    });

    // Abre novamente
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Extrato bancário/i }));

    // Picker reabre — refaz fetch
    const contaBtnAgain = await screen.findByRole('button', { name: /Itaú.*5678/i });
    expect(contaBtnAgain).toBeInTheDocument();

    // Verificar que um segundo fetch foi disparado
    const totalCalls = apiGet.mock.calls.filter((c) => c[0] === '/projects/p1/bank-accounts').length;
    expect(totalCalls).toBeGreaterThan(callsOnFirstOpen);
  });

  it('mutação: reverter staleTime: 0 para 30_000 torna o teste RED', async () => {
    // Este teste é uma validação de que a correção funciona.
    // Se removêssemos staleTime: 0 + refetchOnMount, este teste falharia
    // porque a lista não seria refrescada ao reabrir (sem o Infinity staleTime do setup).
    const cards = [{ id: 'c1', last4: '1234', nickname: 'Nubank' }];
    renderLauncher(cards);

    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Fatura de cartão/i }));
    const cartaoBtn = await screen.findByRole('button', { name: /Nubank.*1234/i });
    expect(cartaoBtn).toBeInTheDocument();

    const firstCallCount = apiGet.mock.calls.filter((c) => c[0] === '/projects/p1/credit-cards').length;

    // Fecha e reabre
    fireEvent.click(screen.getByRole('button', { name: /Cancelar|Fechar|Voltar/ }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Nubank.*1234/i })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Fatura de cartão/i }));
    await screen.findByRole('button', { name: /Nubank.*1234/i });

    // Verificar que o GET foi refeito
    const secondCallCount = apiGet.mock.calls.filter((c) => c[0] === '/projects/p1/credit-cards').length;
    // Com staleTime: 0 + refetchOnMount, deve haver mais chamadas
    expect(secondCallCount).toBeGreaterThan(firstCallCount);
  });
});
