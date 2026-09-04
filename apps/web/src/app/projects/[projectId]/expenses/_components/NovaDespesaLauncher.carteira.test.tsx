import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NovaDespesaLauncher } from './NovaDespesaLauncher';

/**
 * #659 — RED spec (design phase). `ImportWithoutAccountModal` ("Importar para
 * Carteira") is reachable from the desktop launcher's zero-accounts picker.
 * Written against a build that does NOT yet render the CTA — every assertion
 * here is expected to fail for "element/role not found", not for an import
 * error. See docs/659-carteira-launcher-reachability-design.md §3 (desktop).
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
// Stub of the real modal: exposes buttons to drive commit/cancel deterministically.
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

function renderLauncher(importAccounts: Array<Record<string, unknown>> | 'loading' | 'error' = []) {
  apiGet.mockReset();
  apiGet.mockImplementation((path: string) => {
    if (path === '/projects/p1/bank-accounts') {
      if (importAccounts === 'loading') return new Promise(() => {});
      if (importAccounts === 'error') return Promise.reject(new Error('boom'));
      return Promise.resolve(importAccounts);
    }
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
          <button type="button" onClick={open}>
            abrir
          </button>
        )}
      />
    </QueryClientProvider>,
  );
}

function abrirPickerDeConta() {
  fireEvent.click(screen.getByRole('button', { name: 'abrir' }));
  fireEvent.click(screen.getByRole('button', { name: /Extrato bancário/i }));
}

describe('#659 NovaDespesaLauncher — Carteira reachability (RED)', () => {
  beforeEach(() => {
    mockHasModule = () => true;
    onCommittedSpy = null;
    onCloseSpy = null;
  });

  it('zero contas confirmado: "Importar para Carteira" aparece ANTES de "Nova conta"', async () => {
    renderLauncher([]);
    abrirPickerDeConta();

    const importarBtn = await screen.findByRole('button', { name: 'Importar para Carteira' });
    const novaContaBtn = await screen.findByRole('button', { name: 'Nova conta' });
    expect(importarBtn).toBeInTheDocument();
    expect(novaContaBtn).toBeInTheDocument();
    const position = importarBtn.compareDocumentPosition(novaContaBtn);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('loading: distinto do vazio — sem CTAs, sem "Nenhuma conta cadastrada"', async () => {
    renderLauncher('loading');
    abrirPickerDeConta();

    expect(screen.getByText(/Carregando contas/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nova conta' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma conta cadastrada/i)).not.toBeInTheDocument();
  });

  it('erro: distinto do vazio — alerta + "Tentar novamente", sem CTAs de zero contas', async () => {
    renderLauncher('error');
    abrirPickerDeConta();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/Não foi possível carregar as contas/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tentar novamente/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma conta cadastrada/i)).not.toBeInTheDocument();
  });

  it('cancelar volta ao picker sem loop e sem segundo modal', async () => {
    renderLauncher([]);
    abrirPickerDeConta();
    fireEvent.click(await screen.findByRole('button', { name: 'Importar para Carteira' }));

    expect(screen.getByTestId('import-without-account')).toBeInTheDocument();
    onCloseSpy?.();

    await waitFor(() => {
      expect(screen.queryByTestId('import-without-account')).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('button', { name: 'Importar para Carteira' })).toBeInTheDocument();
    expect(screen.getAllByTestId('import-without-account')).toHaveLength(0);
  });

  it('onCommitted/invalidate/close disparam exatamente uma vez por commit', async () => {
    renderLauncher([]);
    abrirPickerDeConta();
    fireEvent.click(await screen.findByRole('button', { name: 'Importar para Carteira' }));

    fireEvent.click(screen.getByRole('button', { name: 'stub-commit' }));

    await waitFor(() => {
      expect(screen.queryByTestId('import-without-account')).not.toBeInTheDocument();
    });
    const bankAccountsCalls = apiGet.mock.calls.filter(
      (c) => c[0] === '/projects/p1/bank-accounts',
    ).length;
    expect(bankAccountsCalls).toBeLessThanOrEqual(2);
  });

  it('gate: hasModule("bankAccounts")===false → CTA Carteira ausente', () => {
    mockHasModule = (slug) => slug !== 'bankAccounts';
    renderLauncher([]);
    fireEvent.click(screen.getByRole('button', { name: 'abrir' }));
    expect(screen.queryByRole('button', { name: /Extrato bancário/i })).not.toBeInTheDocument();
  });

  it('gate: hasModule("receipts")===false → CTA Carteira ausente mesmo com contas=0', async () => {
    mockHasModule = (slug) => slug !== 'receipts';
    renderLauncher([]);
    abrirPickerDeConta();
    expect(await screen.findByTestId('sem-conta-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
  });

  it('existem contas: fluxo atual preservado — CTA de Carteira ausente, lista mostrada', async () => {
    renderLauncher([{ id: 'a1', nickname: 'Itaú', last4: '1234' }]);
    abrirPickerDeConta();
    expect(await screen.findByRole('button', { name: /Itaú/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar para Carteira' })).not.toBeInTheDocument();
  });
});
