import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MobileLaunchSheetContainer } from './MobileLaunchSheetContainer';

/**
 * #659 F3 (mobile) — the "Para qual conta é esse extrato?" <Modal> MUST unmount
 * while ImportWithoutAccountModal is open (no stacked overlays), and remount on
 * Cancel. onCommitted closes the whole launch sheet and never remounts it.
 */

let mockHasModule: (slug: string) => boolean = () => true;
const apiGet = vi.fn();
const onCloseProp = vi.fn();
let onCommittedSpy: (() => void) | null = null;
let onCloseSpy: (() => void) | null = null;

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...(args as [string])),
    post: vi.fn().mockResolvedValue({ id: 'x' }),
    delete: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: 'PESSOAL' }),
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
vi.mock('../../bank-accounts/_components/ImportBankStatementModal', () => ({ default: () => null }));
vi.mock('../../conta/_components/ReceitaModal', () => ({ ReceitaModal: () => null }));
vi.mock('../SemCartaoEmptyState', () => ({ SemCartaoEmptyState: () => <div data-testid="sem-cartao-empty" /> }));
vi.mock('../SemContaEmptyState', () => {
  const SemContaEmptyState = () => (
    <div data-testid="sem-conta-empty">
      <button type="button">Nova conta</button>
    </div>
  );
  return { SemContaEmptyState, default: SemContaEmptyState };
});
vi.mock('../../bank-accounts/_components/ImportWithoutAccountModal', () => ({
  default: ({ onClose, onCommitted }: { onClose: () => void; onCommitted: () => void }) => {
    onCloseSpy = onClose;
    onCommittedSpy = onCommitted;
    return (
      <div data-testid="import-without-account" role="dialog" aria-modal="true">
        <button type="button" aria-label="Fechar">x</button>
      </div>
    );
  },
}));

function renderContainer() {
  apiGet.mockReset();
  apiGet.mockImplementation((path: string) =>
    path === '/projects/p1/bank-accounts' ? Promise.resolve([]) : Promise.resolve([]),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // A "FAB Lançar" fora do container: abre a folha e deve recuperar o foco no fecho.
  function Harness({ open }: { open: boolean }) {
    return (
      <QueryClientProvider client={client}>
        <button type="button" data-testid="fab-lancar">Lançar</button>
        <MobileLaunchSheetContainer projectId="p1" open={open} onClose={onCloseProp} />
      </QueryClientProvider>
    );
  }
  const utils = render(<Harness open={false} />);
  (screen.getByTestId('fab-lancar') as HTMLElement).focus();
  utils.rerender(<Harness open />);
  return { ...utils, Harness };
}

async function abrirCarteira() {
  fireEvent.click(screen.getByRole('button', { name: /Fatura \/ Extrato/i }));
  fireEvent.click(screen.getByRole('button', { name: /Extrato bancário/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Importar para Carteira' }));
}

beforeEach(() => {
  mockHasModule = () => true;
  onCloseProp.mockReset();
  onCommittedSpy = null;
  onCloseSpy = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-02T12:00:00'));
});
afterEach(() => vi.useRealTimers());

describe('#659 F3 — MobileLaunchSheetContainer background isolation', () => {
  it('abrir a Carteira desmonta o picker: um "Fechar", nenhum "Nova conta"', async () => {
    renderContainer();
    await abrirCarteira();

    await waitFor(() => expect(screen.getByTestId('import-without-account')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Fechar' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Nova conta' })).not.toBeInTheDocument();
  });

  it('cancelar remonta o picker', async () => {
    renderContainer();
    await abrirCarteira();
    onCloseSpy?.();

    await waitFor(() => expect(screen.queryByTestId('import-without-account')).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Importar para Carteira' })).toBeInTheDocument();
  });

  it('onCommitted fecha a folha inteira e não remonta o picker', async () => {
    const { rerender, Harness } = renderContainer();
    await abrirCarteira();
    // foco dentro do importer antes do commit (como no app real)
    screen.getByRole('button', { name: 'Fechar' }).focus();
    onCommittedSpy?.();

    await waitFor(() => expect(onCloseProp).toHaveBeenCalledTimes(1));
    // O pai (AppShell) reage ao onClose fechando a folha.
    rerender(<Harness open={false} />);

    expect(screen.queryByTestId('import-without-account')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
    // F3 follow-up: foco volta ao FAB "Lançar", não fica no <body>.
    await waitFor(() => expect(screen.getByTestId('fab-lancar')).toHaveFocus());
  });
});
