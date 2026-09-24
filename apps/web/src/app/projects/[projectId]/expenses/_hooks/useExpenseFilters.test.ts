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

  it.each([
    { paidCents: 40_000, remainingCents: 40_000, settlementStatus: 'PARTIAL', totalPago: 120_000 },
    { paidCents: 80_000, remainingCents: 0, settlementStatus: 'PAID', totalPago: 160_000 },
  ] as const)('#702-X3 category includes native-paid sisters with $settlementStatus funding', ({ totalPago, ...summary }) => {
    const expenses = [makeExpense({
      id: 'mixed-contract',
      tipoDespesa: 'MATERIAL',
      valor: 160_000,
      valorTotal: 160_000,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 2,
      dataInicioParcela: '2026-07-10',
      paidParcelas: '[0]',
      installmentSettlements: [{
        parcelaIndex: 1, dueDate: '2026-08-10', contractedCents: 80_000, ...summary,
      }],
    })];
    const { result } = renderHook(() => useExpenseFilters(expenses, true, baseQuery, vi.fn()));
    expect(result.current.categorias).toMatchObject([{
      tipo: 'MATERIAL', total: 160_000,
      totalPago,
      totalPlanejado: summary.remainingCents,
    }]);
  });
});
