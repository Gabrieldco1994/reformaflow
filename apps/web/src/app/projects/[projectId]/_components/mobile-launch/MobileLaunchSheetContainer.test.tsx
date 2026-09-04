import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MobileLaunchSheetContainer } from './MobileLaunchSheetContainer';

/**
 * #218 (W5) — o "+" mobile (`MobileLaunchSheetContainer`) monta o picker de
 * conta e as queries de extrato SEM checar `bankAccounts`. Hoje só PESSOAL o
 * monta (`AppShell` gate `hasFeature('monthlyOverview')`), mas o gate de extrato
 * tem que ser explícito e defensivo:
 * `hasFeature(type,'bankAccounts') && hasModule('bankAccounts')`.
 *
 * DIVERGÊNCIA DE ESCOPO conhecida (ver retorno do qa-engineer): o botão visível
 * "Extrato bancário" é renderizado por `MobileLaunchModeSheet` (catálogo
 * `PHOTO_MODES` em `launch-modes.ts`), fora da lista fechada de arquivos do
 * design. O que ESTE arquivo pode travar dentro do escopo do container e o que
 * de fato causou o #656: quando o gate falha, o container NÃO dispara
 * `GET /projects/:id/bank-accounts` (a chamada que dava 403) e NÃO monta o
 * picker de conta / `ImportBankStatementModal`. Quando o gate passa, monta.
 */

let mockProjectType = 'PESSOAL';
let mockHasModule: (slug: string) => boolean = () => true;
const apiGet = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn().mockResolvedValue({ id: 'x' }),
    delete: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: mockProjectType }),
}));
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { name: 'Teste' }, hasModule: (slug: string) => mockHasModule(slug) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/p1/conta',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../expenses/_hooks/useExpenseMutations', () => ({
  invalidateExpenseQueries: vi.fn(),
  invalidateImportQueries: vi.fn(),
}));
vi.mock('../../expenses/_hooks/useVoiceExpense', () => ({
  useVoiceExpense: () => ({ voiceSupported: true, closeVoiceModal: vi.fn(), voiceModalOpen: false }),
}));
vi.mock('../../expenses/_components/VoiceExpenseModal', () => ({ VoiceExpenseModal: () => null }));
vi.mock('./MobileLaunchSheet', () => ({ MobileLaunchSheet: () => null }));
vi.mock('../../credit-cards/_components/ImportStatementModal', () => ({ default: () => null }));
vi.mock('../../bank-accounts/_components/ImportBankStatementModal', () => ({
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="import-bank-statement" data-pid={projectId} />
  ),
}));
vi.mock('../../conta/_components/ReceitaModal', () => ({ ReceitaModal: () => null }));
vi.mock('../SemCartaoEmptyState', () => ({
  SemCartaoEmptyState: ({ projectId }: { projectId: string }) => (
    <div data-testid="sem-cartao-empty" data-pid={projectId} />
  ),
}));
vi.mock('../SemContaEmptyState', () => {
  const SemContaEmptyState = ({ projectId }: { projectId: string }) => (
    <div data-testid="sem-conta-empty" data-pid={projectId} />
  );
  return { SemContaEmptyState, default: SemContaEmptyState };
});

function renderContainer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MobileLaunchSheetContainer projectId="p1" open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

/** Navega: raiz do "+" → sub-tela foto → clica "Extrato bancário". */
function irParaExtrato() {
  fireEvent.click(screen.getByRole('button', { name: /Fatura \/ Extrato/i }));
  fireEvent.click(screen.getByRole('button', { name: /Extrato bancário/i }));
}

const chamouExtratoDoProjeto = () =>
  apiGet.mock.calls.some((c) => c[0] === '/projects/p1/bank-accounts');

beforeEach(() => {
  mockProjectType = 'PESSOAL';
  mockHasModule = () => true;
  apiGet.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-02T12:00:00'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MobileLaunchSheetContainer — gate de import de extrato (#218)', () => {
  it('REFORMA (defensivo): escolher "Extrato bancário" não dispara GET /projects/:id/bank-accounts nem monta o picker', () => {
    mockProjectType = 'REFORMA';
    renderContainer();
    irParaExtrato();

    expect(chamouExtratoDoProjeto()).toBe(false);
    expect(screen.queryByTestId('sem-conta-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('import-bank-statement')).not.toBeInTheDocument();
  });

  it('PESSOAL + hasModule false: idem — sem chamada de extrato e sem picker', () => {
    mockProjectType = 'PESSOAL';
    mockHasModule = (slug) => slug !== 'bankAccounts';
    renderContainer();
    irParaExtrato();

    expect(chamouExtratoDoProjeto()).toBe(false);
    expect(screen.queryByTestId('sem-conta-empty')).not.toBeInTheDocument();
  });

  it('PESSOAL + hasModule true, sem conta: picker monta com SemContaEmptyState escopado, sem texto morto', async () => {
    mockProjectType = 'PESSOAL';
    mockHasModule = () => true;
    renderContainer();
    irParaExtrato();

    expect(chamouExtratoDoProjeto()).toBe(true);
    expect(await screen.findByTestId('sem-conta-empty')).toHaveAttribute('data-pid', 'p1');
    expect(
      screen.queryByText(/Nenhuma conta cadastrada\. Cadastre em/),
    ).not.toBeInTheDocument();
  });
});
