import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * #714 — a introdução da página convive com a copy do importador: não pode
 * prometer que parcelas "viram pagas automaticamente" (REUSED não paga). REFORMA
 * é a fixture viva da página legada (não colapsa no hub /conta; ver
 * page.empty-cta.test.tsx). Renderiza a página real, sem copiar o texto.
 */
vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'project-1', projectType: 'REFORMA', projectName: 'Reforma' }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => []), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import CreditCardsPage from './page';

describe('CreditCardsPage — introdução da importação (#714)', () => {
  it('orienta conferir, diz que compras novas geram as restantes como planejadas e que importar não quita', async () => {
    const { container } = render(<CreditCardsPage />);
    await screen.findByText('Nenhum cartão cadastrado');
    const text = container.textContent ?? '';
    expect(text).toContain('Confira os lançamentos da fatura antes de confirmar.');
    expect(text).toContain('Compras novas geram as parcelas restantes como planejadas.');
    expect(text).toContain('Importar não quita a fatura.');
    expect(text).not.toMatch(/viram pagas/i);
    expect(text).not.toMatch(/mês seguinte/i);
  });
});
