import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MobileLaunchSheetContainer } from './MobileLaunchSheetContainer';

/**
 * #659 — RED spec (design phase), mobile launcher. Mirrors
 * NovaDespesaLauncher.carteira.test.tsx for `MobileLaunchSheetContainer`. See
 * docs/659-carteira-launcher-reachability-design.md §3 (mobile).
 */

let mockProjectType = 'PESSOAL';
let mockHasModule: (slug: string) => boolean = () => true;
const apiGet = vi.fn();
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
vi.mock('../../bank-accounts/_components/ImportBankStatementModal', () => ({ default: () => null }));
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
vi.mock('../../bank-accounts/_components/ImportWithoutAccountModal', () => ({
  default: ({ projectId, onClose, onCommitted }: { projectId: string; onClose: () => void; onCommitted: () => void }) => {
    onCloseSpy = onClose;
    onCommittedSpy = onCommitted;
    return (
      <div data-testid="import-without-account" data-pid={projectId}>
        <button type="button" onClick={onClose}>stub-cancelar</button>
        <button type="button" onClick={onCommitted}>stub-commit</button>
      </div>
    );
  },
}));

function renderContainer(accounts: Array<Record<string, unknown>> | 'loading' | 'error' = []) {
  apiGet.mockReset();
  apiGet.mockImplementation((path: string) => {
    if (path === '/projects/p1/bank-accounts') {
      if (accounts === 'loading') return new Promise(() => {});
      if (accounts === 'error') return Promise.reject(new Error('boom'));
      return Promise.resolve(accounts);
    }
    return Promise.resolve([]);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MobileLaunchSheetContainer projectId="p1" open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

function irParaExtrato() {
  fireEvent.click(screen.getByRole('button', { name: /Fatura \/ Extrato/i }));
  fireEvent.click(screen.getByRole('button', { name: /Extrato bancário/i }));
}

beforeEach(() => {
  mockProjectType = 'PESSOAL';
  mockHasModule = () => true;
  onCommittedSpy = null;
  onCloseSpy = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-02T12:00:00'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#659 MobileLaunchSheetContainer — Carteira reachability (RED)', () => {
  it('zero contas confirmado: "Importar para Carteira" aparece ANTES de "Nova conta"', async () => {
    renderContainer([]);
    irParaExtrato();

    const importarBtn = await screen.findByRole('button', { name: 'Importar para Carteira' });
    const novaContaBtn = await screen.findByRole('button', { name: 'Nova conta' });
    expect(importarBtn).toBeInTheDocument();
    expect(novaContaBtn).toBeInTheDocument();
    const position = importarBtn.compareDocumentPosition(novaContaBtn);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('loading: distinto do vazio — sem CTAs de zero contas', async () => {
    renderContainer('loading');
    irParaExtrato();

    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nova conta' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma conta cadastrada/i)).not.toBeInTheDocument();
  });

  it('erro: distinto do vazio — alerta explícito, sem CTAs de zero contas', async () => {
    renderContainer('error');
    irParaExtrato();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma conta cadastrada/i)).not.toBeInTheDocument();
  });

  it('cancelar volta ao picker sem loop', async () => {
    renderContainer([]);
    irParaExtrato();
    fireEvent.click(await screen.findByRole('button', { name: 'Importar para Carteira' }));

    expect(screen.getByTestId('import-without-account')).toBeInTheDocument();
    onCloseSpy?.();

    await waitFor(() => {
      expect(screen.queryByTestId('import-without-account')).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('button', { name: 'Importar para Carteira' })).toBeInTheDocument();
  });

  it('onCommitted fecha o modal exatamente uma vez por commit', async () => {
    renderContainer([]);
    irParaExtrato();
    fireEvent.click(await screen.findByRole('button', { name: 'Importar para Carteira' }));

    fireEvent.click(screen.getByRole('button', { name: 'stub-commit' }));

    await waitFor(() => {
      expect(screen.queryByTestId('import-without-account')).not.toBeInTheDocument();
    });
    // reabrir o "+" não deve re-montar automaticamente um segundo import.
    expect(screen.queryAllByTestId('import-without-account')).toHaveLength(0);
  });

  it('gate: projeto REFORMA → escolher "Extrato bancário" não monta picker nem CTA Carteira (divergência de escopo conhecida: o botão em si vem de MobileLaunchModeSheet)', () => {
    mockProjectType = 'REFORMA';
    renderContainer([]);
    irParaExtrato();
    expect(apiGet.mock.calls.some((c) => c[0] === '/projects/p1/bank-accounts')).toBe(false);
    expect(screen.queryByTestId('sem-conta-empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
  });

  it('gate: hasModule("receipts")===false → CTA Carteira ausente mesmo com contas=0', async () => {
    mockHasModule = (slug) => slug !== 'receipts';
    renderContainer([]);
    irParaExtrato();
    expect(await screen.findByTestId('sem-conta-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
  });

  it('existem contas: fluxo atual preservado — sem CTA de Carteira', async () => {
    // 2 contas: evita o auto-seleciona-única-conta (L190-194) e força o picker a listar.
    renderContainer([
      { id: 'a1', nickname: 'Itaú', last4: '1234' },
      { id: 'a2', nickname: 'Nubank', last4: '5678' },
    ]);
    irParaExtrato();
    expect(await screen.findByRole('button', { name: /Itaú/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nubank/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
  });
});
