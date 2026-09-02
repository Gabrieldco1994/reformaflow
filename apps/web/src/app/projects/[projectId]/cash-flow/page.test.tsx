import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CashFlowPage from './page';

/**
 * #218 (W5) — CTA do estado vazio do Fluxo de Caixa, restaurado da #655.
 *
 * `entries=[]` → o `EmptyState` ganha a ação "Lançar despesa ou recebimento" →
 * `router.push('/projects/:id/expenses')`. TYPE-AGNOSTIC: `/cash-flow` só
 * renderiza para REFORMA e PESSOAL e `/expenses` é rota válida nos dois — nenhuma
 * dependência de `bankAccounts` (foi essa dependência que quebrou a #655).
 */

let mockProjectType = 'REFORMA';
const mockPush = vi.fn();

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: mockProjectType }),
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue([]) } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['cash-flow', 'p1'], []);
  client.setQueryData(['account-view', 'p1'], { caixaHoje: 0 });
  return render(
    <QueryClientProvider client={client}>
      <CashFlowPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockProjectType = 'REFORMA';
  mockPush.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('CashFlowPage — CTA do estado vazio (#218)', () => {
  it('REFORMA: vazio → CTA "Lançar despesa ou recebimento" → push /projects/p1/expenses', () => {
    mockProjectType = 'REFORMA';
    renderPage();

    const cta = screen.getByRole('button', { name: /Lançar despesa ou recebimento/i });
    fireEvent.click(cta);
    expect(mockPush).toHaveBeenCalledWith('/projects/p1/expenses');
  });

  it('PESSOAL: mesmo CTA, mesmo destino (rota válida nos dois tipos)', () => {
    mockProjectType = 'PESSOAL';
    renderPage();

    const cta = screen.getByRole('button', { name: /Lançar despesa ou recebimento/i });
    fireEvent.click(cta);
    expect(mockPush).toHaveBeenCalledWith('/projects/p1/expenses');
  });
});
