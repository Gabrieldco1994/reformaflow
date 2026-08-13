import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Expense } from '@/types';
import type { ExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { useExpenseMutations } from './useExpenseMutations';

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('useExpenseMutations — data de parcela', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('usa o projeto dono e invalida projeto visualizado, dono e afetados', async () => {
    vi.mocked(api.patch).mockResolvedValue({
      id: 'expense-1',
      parcela: 1,
      data: '2026-09-05',
      isOverride: true,
      affectedProjectIds: ['mirror-project'],
    });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const foreignExpense = {
      id: 'expense-1',
      projectId: 'owner-project',
      project: { id: 'owner-project', name: 'Obra', type: 'REFORMA' },
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: 90_000,
      quantidade: 1,
      valorTotal: 90_000,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: '2026-08-10',
      status: 'PLANEJADO',
    } as Expense;

    const { result } = renderHook(
      () =>
        useExpenseMutations({
          projectId: 'view-project',
          allExpensesPersonal: [foreignExpense],
          defaultExpenseType: 'OUTROS' as ExpenseType,
          closeFormModal: vi.fn(),
          setShowNewRow: vi.fn(),
          setNewRow: vi.fn(),
          setPayModalOpen: vi.fn(),
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.installmentDateMutation.mutateAsync({
        id: 'expense-1',
        parcela: 1,
        data: '2026-09-05',
      });
    });

    expect(api.patch).toHaveBeenCalledWith(
      '/projects/owner-project/expenses/expense-1/parcela-data',
      { parcela: 1, data: '2026-09-05' },
    );
    for (const projectId of ['view-project', 'owner-project', 'mirror-project']) {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['expenses', projectId],
      });
    }
    expect(api.patch).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ valor: expect.anything() }),
    );
  });
});
