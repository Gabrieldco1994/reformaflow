import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #449 B2 — Recebimentos mistura alocações de budget como `ALOCACAO_ORCAMENTO`.
 * Com a leitura do Budget restrita a full-access não-convidado, essa consulta
 * passa a tomar 403 para USER. Requisição que se sabe condenada não deve ser
 * feita: o `providers.tsx` não repete 4xx e não há toast global, então a falha
 * seria invisível.
 *
 * O teste captura as `options` de cada `useQuery` e afirma sobre `enabled` da
 * consulta de alocações — é o comportamento observável ("dispara ou não"), não
 * a forma como o componente foi escrito.
 */
const authState: { user: { role: string; isGuest?: boolean } | null } = { user: null };
const queryOptions: Array<{ queryKey: unknown[]; enabled?: boolean }> = [];

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({
    projectId: 'project-1',
    projectType: 'REFORMA',
    projectName: 'Reforma',
  }),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: authState.user }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    queryOptions.push(options);
    return { data: undefined, isLoading: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import ReceiptsPage from './page';

const ALLOCATIONS_KEY = 'budget-allocations-target';

function allocationsQuery() {
  return queryOptions.find((options) => options.queryKey?.[0] === ALLOCATIONS_KEY);
}

function receiptsQuery() {
  return queryOptions.find((options) => options.queryKey?.[0] === 'receipts');
}

describe('ReceiptsPage — consulta de alocações de budget (#449)', () => {
  beforeEach(() => {
    queryOptions.length = 0;
    authState.user = null;
  });

  it('não dispara a consulta de alocações para USER', () => {
    authState.user = { role: 'USER', isGuest: false };
    render(<ReceiptsPage />);
    expect(allocationsQuery()?.enabled).toBe(false);
  });

  it('não dispara para convidado de demo, mesmo com role ADMIN (#497)', () => {
    authState.user = { role: 'ADMIN', isGuest: true };
    render(<ReceiptsPage />);
    expect(allocationsQuery()?.enabled).toBe(false);
  });

  it('dispara para ADMIN não-convidado', () => {
    authState.user = { role: 'ADMIN', isGuest: false };
    render(<ReceiptsPage />);
    expect(allocationsQuery()?.enabled).toBe(true);
  });

  it('dispara para OWNER', () => {
    authState.user = { role: 'OWNER', isGuest: false };
    render(<ReceiptsPage />);
    expect(allocationsQuery()?.enabled).toBe(true);
  });

  it('não mexe na consulta de recebimentos: a tela continua carregando para USER', () => {
    authState.user = { role: 'USER', isGuest: false };
    render(<ReceiptsPage />);
    const receipts = receiptsQuery();
    expect(receipts).toBeDefined();
    expect(receipts?.enabled).toBeUndefined();
  });
});
