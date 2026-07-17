import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Expense } from '@/types';
import type { ExpenseQueryState } from '../_lib/expense-query-state';
import { useExpenseFilters } from './useExpenseFilters';

function makeExpense(patch: Partial<Expense> & { id: string }): Expense {
  return {
    tipoDespesa: 'OUTROS',
    valor: 1000,
    quantidade: 1,
    valorTotal: 1000,
    formaPagamento: 'PIX',
    status: 'PLANEJADO',
    ...patch,
  };
}

const baseQuery: ExpenseQueryState = {
  q: '',
  tipoDespesa: '',
  room: '',
  titulo: '',
  fornecedor: '',
  formaPagamento: '',
  status: '',
  view: 'category',
  period: '',
  rangeStart: '',
  rangeEnd: '',
  origin: '',
};

describe('useExpenseFilters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounce da busca só sincroniza a URL no último valor digitado', () => {
    const onQueryChange = vi.fn();
    const expenses: Expense[] = [makeExpense({ id: 'e1', titulo: 'Infra elétrica' })];
    const { result } = renderHook(() => useExpenseFilters(expenses, false, baseQuery, onQueryChange));

    act(() => result.current.setSearchText('i'));
    act(() => vi.advanceTimersByTime(60));
    act(() => result.current.setSearchText('in'));
    act(() => vi.advanceTimersByTime(60));
    act(() => result.current.setSearchText('infr'));

    expect(result.current.filteredExpenses).toHaveLength(1);
    expect(onQueryChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(179));
    expect(onQueryChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...baseQuery, q: 'infr' });
  });
});
