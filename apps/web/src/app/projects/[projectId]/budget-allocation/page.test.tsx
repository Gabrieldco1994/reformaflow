import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #449 B2 — a página é histórico administrativo. Sem o papel, ela não pode
 * renderizar a tela normal: os fallbacks `?? 0` mostrariam "disponível
 * R$ 0,00" para quem tomou 403, ou seja, número ERRADO em vez de ausência.
 */
const authState: { user: { role: string; isGuest?: boolean } | null } = { user: null };
const queryOptions: Array<{ queryKey: unknown[]; enabled?: boolean }> = [];

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-1' }),
  useRouter: () => ({ back: vi.fn() }),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: authState.user }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    queryOptions.push(options);
    if (options.queryKey?.[0] === 'project') {
      return { data: { id: 'project-1', name: 'Pessoal', type: 'PESSOAL' } };
    }
    return { data: undefined };
  },
}));

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

import BudgetAllocationPage from './page';

const BUDGET_KEYS = ['budget-available', 'budget-summary', 'budget-allocations'];

function budgetQueries() {
  return queryOptions.filter((options) => BUDGET_KEYS.includes(options.queryKey?.[0] as string));
}

describe('BudgetAllocationPage — gate administrativo (#449)', () => {
  beforeEach(() => {
    queryOptions.length = 0;
    authState.user = null;
  });

  it('USER vê o aviso e nenhuma consulta de budget é disparada', () => {
    authState.user = { role: 'USER', isGuest: false };
    render(<BudgetAllocationPage />);

    expect(screen.getByText(/somente leitura/i)).toBeInTheDocument();
    expect(screen.queryByText('Alocação de Budget')).not.toBeInTheDocument();
    expect(budgetQueries().every((options) => options.enabled === false)).toBe(true);
  });

  it('convidado de demo com role ADMIN também vê o aviso (#497)', () => {
    authState.user = { role: 'ADMIN', isGuest: true };
    render(<BudgetAllocationPage />);

    expect(budgetQueries().every((options) => options.enabled === false)).toBe(true);
  });

  it('ADMIN não-convidado vê o histórico e as consultas são disparadas', () => {
    authState.user = { role: 'ADMIN', isGuest: false };
    render(<BudgetAllocationPage />);

    expect(screen.getByText('Alocação de Budget')).toBeInTheDocument();
    expect(budgetQueries().every((options) => options.enabled === true)).toBe(true);
  });

  it('OWNER vê o histórico: congelar não é sumir com o histórico do dono', () => {
    authState.user = { role: 'OWNER', isGuest: false };
    render(<BudgetAllocationPage />);

    expect(screen.getByText('Alocação de Budget')).toBeInTheDocument();
    expect(budgetQueries().every((options) => options.enabled === true)).toBe(true);
  });

  it('não oferece nenhuma ação de escrita ao ADMIN (read-only para todo papel)', () => {
    authState.user = { role: 'ADMIN', isGuest: false };
    render(<BudgetAllocationPage />);

    expect(screen.queryByRole('button', { name: /nova aloca/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /excluir/i })).not.toBeInTheDocument();
  });
});
