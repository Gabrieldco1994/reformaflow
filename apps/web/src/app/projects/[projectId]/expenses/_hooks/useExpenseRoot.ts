import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Expense } from '@/types';

/**
 * Real expense detail (`GET /projects/:owner/expenses/:id`) — the same key the Conta
 * capability reads use, so React Query dedups every consumer. Always on demand
 * (user intent); never mounted for a whole list. A missing body is an error, not a
 * permission.
 */
export const expenseRootQueryOptions = (owner: string, id: string) => ({
  queryKey: ['expense', owner, id] as const,
  queryFn: async (): Promise<Expense> => {
    const expense = await api.get<Expense | null | undefined>(`/projects/${owner}/expenses/${id}`);
    if (!expense || typeof expense.valorTotal !== 'number') throw new Error('Detalhe da despesa indisponível.');
    return expense;
  },
  retry: false,
});

export type RootState = {
  status: 'idle' | 'loading' | 'error' | 'ready';
  expense?: Expense;
  retry: () => void;
};

/**
 * `ready` only when the LATEST read settled successfully. A refetch in flight or a failed
 * refetch never lets a previously cached success act as a permission: error/fetching win
 * over `data` (React Query keeps the stale `data` next to `isError`).
 */
export function toRootState(query: Pick<UseQueryResult<Expense>, 'data' | 'isError' | 'isFetching' | 'refetch'>): RootState {
  const retry = () => void query.refetch();
  if (query.isFetching) return { status: 'loading', retry };
  if (query.isError) return { status: 'error', retry };
  if (query.data) return { status: 'ready', expense: query.data, retry };
  return { status: 'loading', retry };
}

export function useExpenseRoot(owner: string | undefined, id: string | null | undefined, enabled: boolean): RootState {
  const active = enabled && !!owner && !!id;
  const query = useQuery({
    ...expenseRootQueryOptions(owner ?? '', id ?? ''),
    enabled: active,
  });
  if (!active) return { status: 'idle', retry: () => undefined };
  return toRootState(query);
}

export const fetchExpenseRoot = (queryClient: QueryClient, owner: string, id: string) =>
  queryClient.fetchQuery({ ...expenseRootQueryOptions(owner, id), staleTime: 0 });
