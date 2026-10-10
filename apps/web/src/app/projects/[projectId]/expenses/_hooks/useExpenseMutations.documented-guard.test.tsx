import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Expense } from '@/types';
import { ExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { useExpenseMutations } from './useExpenseMutations';

vi.mock('@/lib/api', () => ({
  api: { patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function plain(id: string): Expense {
  return {
    id,
    tipoDespesa: 'OUTROS',
    valor: 1000,
    quantidade: 1,
    valorTotal: 1000,
    formaPagamento: 'A_VISTA',
    status: 'PLANEJADO',
  };
}

function documented(id: string): Expense {
  return {
    ...plain(id),
    schedule: {
      version: 1,
      occurrences: [{ index: 0, parcela: null, valor: 1000, data: '2026-08-10', invoiceDueMonth: null }],
    },
  };
}

function setup(allExpensesPersonal: Expense[]) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useExpenseMutations({
        projectId: 'p1',
        allExpensesPersonal,
        defaultExpenseType: ExpenseType.OUTROS,
        closeFormModal: vi.fn(),
        setShowNewRow: vi.fn(),
        setNewRow: vi.fn(),
        setPayModalOpen: vi.fn(),
      }),
    { wrapper },
  );
  return { result, invalidate };
}

const conflict = Object.assign(new Error('Cronograma documentado exige correção assistida'), { status: 409 });

describe('useExpenseMutations — guard de cronograma documentado (#701, REFORMA/COMPRA)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bulk "marcar como pago" com documentado no meio de 5: ZERO requests (fail-before-write)', async () => {
    const list = [plain('a'), plain('b'), documented('doc'), plain('d'), plain('e')];
    const { result } = setup(list);
    await act(async () => {
      await expect(
        result.current.bulkPaidMutation.mutateAsync({ ids: list.map((e) => e.id) }),
      ).rejects.toThrow('correção assistida');
    });
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('bulk "marcar como pago" só com normais preserva 1 PATCH por despesa, em ordem', async () => {
    vi.mocked(api.patch).mockResolvedValue({});
    const list = [plain('a'), plain('b'), plain('c')];
    const { result } = setup(list);
    await act(async () => {
      await result.current.bulkPaidMutation.mutateAsync({ ids: ['a', 'b', 'c'] });
    });
    expect(vi.mocked(api.patch).mock.calls).toEqual([
      ['/projects/p1/expenses/a', { status: 'PAGO' }],
      ['/projects/p1/expenses/b', { status: 'PAGO' }],
      ['/projects/p1/expenses/c', { status: 'PAGO' }],
    ]);
  });

  it('status, parcela e exclusão de documentado falham antes de qualquer request', async () => {
    const { result } = setup([documented('doc')]);
    await act(async () => {
      await expect(
        result.current.toggleStatusMutation.mutateAsync({ id: 'doc', status: 'PAGO' }),
      ).rejects.toThrow('correção assistida');
      await expect(
        result.current.toggleParcelaMutation.mutateAsync({ id: 'doc', parcela: 0, paid: true }),
      ).rejects.toThrow('correção assistida');
      await expect(result.current.deleteMutation.mutateAsync('doc')).rejects.toThrow('correção assistida');
    });
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('status, parcela e exclusão de despesas normais continuam enviando request', async () => {
    vi.mocked(api.patch).mockResolvedValue({});
    vi.mocked(api.delete).mockResolvedValue({});
    const { result } = setup([plain('a')]);
    await act(async () => {
      await result.current.toggleStatusMutation.mutateAsync({ id: 'a', status: 'PAGO' });
      await result.current.toggleParcelaMutation.mutateAsync({ id: 'a', parcela: 1, paid: true });
      await result.current.deleteMutation.mutateAsync('a');
    });
    expect(api.patch).toHaveBeenCalledWith('/projects/p1/expenses/a', { status: 'PAGO' });
    expect(api.patch).toHaveBeenCalledWith('/projects/p1/expenses/a/parcela', { parcela: 1, paid: true });
    expect(api.delete).toHaveBeenCalledWith('/projects/p1/expenses/a');
  });

  it('edição descritiva (categoria) de documentado continua disponível', async () => {
    vi.mocked(api.patch).mockResolvedValue({});
    const { result } = setup([documented('doc')]);
    await act(async () => {
      await result.current.changeTipoMutation.mutateAsync({ id: 'doc', tipoDespesa: 'MATERIAL' });
      await result.current.updateMutation.mutateAsync({ id: 'doc', data: { titulo: 'Novo título' } });
    });
    expect(api.patch).toHaveBeenCalledTimes(2);
  });

  it('409 do servidor (documentado concorrente) recarrega listas para mostrar o estado atual', async () => {
    vi.mocked(api.patch).mockRejectedValue(conflict);
    const { result, invalidate } = setup([plain('a')]);
    await act(async () => {
      await expect(
        result.current.toggleStatusMutation.mutateAsync({ id: 'a', status: 'PAGO' }),
      ).rejects.toBe(conflict);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['expenses', 'p1'] });
  });

  it('bulk interrompido por 409 no meio recarrega listas (lote não é atômico)', async () => {
    vi.mocked(api.patch).mockResolvedValueOnce({}).mockRejectedValueOnce(conflict);
    const { result, invalidate } = setup([plain('a'), plain('b'), plain('c')]);
    await act(async () => {
      await expect(
        result.current.bulkPaidMutation.mutateAsync({ ids: ['a', 'b', 'c'] }),
      ).rejects.toBe(conflict);
    });
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['expenses', 'p1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account-view', 'p1'] });
  });

  it('bulk de data interrompido por 409 também recarrega listas', async () => {
    vi.mocked(api.patch).mockRejectedValue(conflict);
    const { result, invalidate } = setup([plain('a')]);
    await act(async () => {
      await expect(
        result.current.bulkDateMutation.mutateAsync({ ids: ['a'], dataPagamento: '2026-09-10' }),
      ).rejects.toBe(conflict);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['expenses', 'p1'] });
  });
});
