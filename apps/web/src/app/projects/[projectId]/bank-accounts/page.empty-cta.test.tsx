import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #490 D-A — CTA duplicado no estado vazio, gêmeo do `/credit-cards`.
 *
 * Sem nenhuma conta a tela mostrava DOIS botões "Nova conta": o do cabeçalho e
 * o do `EmptyState`. Mesma decisão: no vazio a CTA primária é a do `EmptyState`
 * (título + explicação), e o token `data-journey-action` acompanha a CTA viva.
 *
 * ─── QUAL RAMO DA GUARDA U4 ESTE ARQUIVO EXERCITA (#453) ───────────────────
 *
 * A página ganhou uma guarda de 3 casos para PESSOAL, onde `bank-accounts` saiu
 * de PROJECT_NAV:
 *   1. sem `bankAccounts`                      → replace('/no-permission')
 *   2. com `bankAccounts` + `monthlyOverview`  → replace('.../conta')
 *   3. com `bankAccounts`, sem `monthlyOverview` → renderiza a página legada
 *
 * Nos casos 1 e 2 a página devolve `null` ANTES de qualquer CTA — um teste de
 * "CTA única no estado vazio" rodando ali estaria medindo tela em branco. Este
 * arquivo declara o CASO 3 explicitamente pelo mock de `useAuth`, e cada caso
 * assere que NENHUM redirect ocorreu: se a guarda passar a disparar para este
 * perfil, estes testes ficam VERMELHOS em vez de continuarem verdes sobre um
 * `null`. Os três ramos da guarda em si são cobertos em `e2e/u4-nav-redirect`.
 */
const accountsResponse: { value: unknown[] } = { value: [] };
const apiGet = vi.fn(async () => accountsResponse.value);
const routerReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    replace: routerReplace,
    push: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({
    projectId: 'project-1',
    projectType: 'PESSOAL',
    projectName: 'Pessoal',
  }),
}));

// CASO 3 da guarda U4: tem o módulo da página, NÃO tem o hub. É o único perfil
// em que a página legada ainda renderiza — e portanto o único em que a CTA do
// estado vazio existe para ser contada.
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    hasModule: (slug: string) => slug === 'bankAccounts',
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...(args as [])),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import BankAccountsPage from './page';

function repeatedLabels() {
  const labels = screen
    .getAllByRole('button')
    .map((button) => (button.textContent ?? '').trim())
    .filter(Boolean);
  return labels.filter((label, index) => labels.indexOf(label) !== index);
}

describe('BankAccountsPage — CTA única no estado vazio (#490)', () => {
  beforeEach(() => {
    accountsResponse.value = [];
    apiGet.mockClear();
    routerReplace.mockClear();
  });

  it('não repete o rótulo "Nova conta" quando não há nenhuma conta', async () => {
    render(<BankAccountsPage />);
    expect(await screen.findByText('Nenhuma conta cadastrada')).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(screen.getAllByRole('button', { name: /Nova conta/ })).toHaveLength(1);
    // Caso 3 da guarda U4: nada de redirect — a página legada é o que se mede.
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('mantém o token de jornada bank-account.new exatamente uma vez no estado vazio', async () => {
    const { container } = render(<BankAccountsPage />);
    expect(await screen.findByText('Nenhuma conta cadastrada')).toBeInTheDocument();

    expect(container.querySelectorAll('[data-journey-action="bank-account.new"]')).toHaveLength(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('devolve a CTA do cabeçalho quando já existe conta', async () => {
    accountsResponse.value = [
      { id: 'acc-1', last4: '9876', institution: 'Itaú', nickname: 'Conta', balanceCents: 1000 },
    ];
    const { container } = render(<BankAccountsPage />);
    expect(await screen.findByRole('button', { name: /Nova conta/ })).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(container.querySelectorAll('[data-journey-action="bank-account.new"]')).toHaveLength(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });
});
