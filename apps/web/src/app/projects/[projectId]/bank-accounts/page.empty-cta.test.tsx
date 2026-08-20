import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #490 D-A — CTA duplicado no estado vazio, gêmeo do `/credit-cards`.
 *
 * Sem nenhuma conta a tela mostrava DOIS botões "Nova conta": o do cabeçalho e
 * o do `EmptyState`. Mesma decisão: no vazio a CTA primária é a do `EmptyState`
 * (título + explicação), e o token `data-journey-action` acompanha a CTA viva.
 */
const accountsResponse: { value: unknown[] } = { value: [] };
const apiGet = vi.fn(async () => accountsResponse.value);

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({
    projectId: 'project-1',
    projectType: 'PESSOAL',
    projectName: 'Pessoal',
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
  });

  it('não repete o rótulo "Nova conta" quando não há nenhuma conta', async () => {
    render(<BankAccountsPage />);
    expect(await screen.findByText('Nenhuma conta cadastrada')).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(screen.getAllByRole('button', { name: /Nova conta/ })).toHaveLength(1);
  });

  it('mantém o token de jornada bank-account.new exatamente uma vez no estado vazio', async () => {
    const { container } = render(<BankAccountsPage />);
    expect(await screen.findByText('Nenhuma conta cadastrada')).toBeInTheDocument();

    expect(container.querySelectorAll('[data-journey-action="bank-account.new"]')).toHaveLength(1);
  });

  it('devolve a CTA do cabeçalho quando já existe conta', async () => {
    accountsResponse.value = [
      { id: 'acc-1', last4: '9876', institution: 'Itaú', nickname: 'Conta', balanceCents: 1000 },
    ];
    const { container } = render(<BankAccountsPage />);
    expect(await screen.findByRole('button', { name: /Nova conta/ })).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(container.querySelectorAll('[data-journey-action="bank-account.new"]')).toHaveLength(1);
  });
});
