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
 *
 * ─── GUARDA U4 (#453): POR QUE REFORMA CONTINUA SENDO A FIXTURE ────────────
 *
 * A página ganhou `navCollapsed = !hasNavRoute(tipo,'credit-cards') &&
 * hasNavRoute(tipo,'conta')`. REFORMA não tem `conta` no nav ⇒ `navCollapsed`
 * é falso ⇒ nenhum dos dois ramos de redirect arma, e a página legada renderiza
 * como sempre. A propriedade medida aqui (CTA única) é independente do tipo de
 * projeto — depende só de `isEmpty` —, então a fixture segue válida.
 * `routerReplace` é asserido como NÃO chamado em cada caso justamente para que
 * isso pare de ser suposição: se a guarda passar a disparar para REFORMA, estes
 * testes ficam vermelhos em vez de medirem um `null` silencioso.
 */
const cardsResponse: { value: unknown[] } = { value: [] };
const apiGet = vi.fn(async () => cardsResponse.value);
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
    routerReplace.mockClear();
  });

  it('não repete o rótulo "Novo cartão" quando não há nenhum cartão', async () => {
    render(<CreditCardsPage />);
    expect(await screen.findByText('Nenhum cartão cadastrado')).toBeInTheDocument();
    expect(repeatedLabels()).toEqual([]);
    expect(screen.getAllByRole('button', { name: /Novo cartão/ })).toHaveLength(1);
    // REFORMA não colapsa: a guarda U4 não arma e a tela legada é o que se mede.
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('mantém o token de jornada credit-card.new exatamente uma vez no estado vazio', async () => {
    const { container } = render(<CreditCardsPage />);
    expect(await screen.findByText('Nenhum cartão cadastrado')).toBeInTheDocument();

    expect(container.querySelectorAll('[data-journey-action="credit-card.new"]')).toHaveLength(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('devolve a CTA do cabeçalho quando já existe cartão', async () => {
    cardsResponse.value = [
      { id: 'card-1', last4: '1234', institution: 'Itaú', brand: 'VISA', nickname: 'Cartão' },
    ];
    const { container } = render(<CreditCardsPage />);
    expect(await screen.findByRole('button', { name: /Novo cartão/ })).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(container.querySelectorAll('[data-journey-action="credit-card.new"]')).toHaveLength(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });
});
