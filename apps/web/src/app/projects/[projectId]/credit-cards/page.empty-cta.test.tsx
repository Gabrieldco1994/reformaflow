import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #490 D-A — CTA duplicado no estado vazio.
 *
 * Sem nenhum cartão a tela mostrava DOIS botões "Novo cartão": o do cabeçalho e
 * o do `EmptyState`. Duplicata é invisível para quem rola a tela e óbvia para
 * `labels.filter((v, i, a) => a.indexOf(v) !== i)`.
 *
 * Contrato: no estado vazio, a CTA primária é a do `EmptyState` (é ela que vem
 * com título e explicação do porquê clicar), e o token `data-journey-action`
 * vai junto — o motor de jornadas escuta o token, então ele precisa existir
 * exatamente uma vez, sempre, ou a jornada de primeiro cartão morre em silêncio.
 */
const cardsResponse: { value: unknown[] } = { value: [] };
const apiGet = vi.fn(async () => cardsResponse.value);

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({
    projectId: 'project-1',
    projectType: 'REFORMA',
    projectName: 'Reforma',
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

import CreditCardsPage from './page';

function repeatedLabels() {
  const labels = screen
    .getAllByRole('button')
    .map((button) => (button.textContent ?? '').trim())
    .filter(Boolean);
  return labels.filter((label, index) => labels.indexOf(label) !== index);
}

describe('CreditCardsPage — CTA única no estado vazio (#490)', () => {
  beforeEach(() => {
    cardsResponse.value = [];
    apiGet.mockClear();
  });

  it('não repete o rótulo "Novo cartão" quando não há nenhum cartão', async () => {
    render(<CreditCardsPage />);
    expect(await screen.findByText('Nenhum cartão cadastrado')).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(screen.getAllByRole('button', { name: /Novo cartão/ })).toHaveLength(1);
  });

  it('mantém o token de jornada credit-card.new exatamente uma vez no estado vazio', async () => {
    const { container } = render(<CreditCardsPage />);
    expect(await screen.findByText('Nenhum cartão cadastrado')).toBeInTheDocument();

    expect(container.querySelectorAll('[data-journey-action="credit-card.new"]')).toHaveLength(1);
  });

  it('devolve a CTA do cabeçalho quando já existe cartão', async () => {
    cardsResponse.value = [
      { id: 'card-1', last4: '1234', institution: 'Itaú', brand: 'VISA', nickname: 'Cartão' },
    ];
    const { container } = render(<CreditCardsPage />);
    expect(await screen.findByRole('button', { name: /Novo cartão/ })).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(container.querySelectorAll('[data-journey-action="credit-card.new"]')).toHaveLength(1);
  });
});
