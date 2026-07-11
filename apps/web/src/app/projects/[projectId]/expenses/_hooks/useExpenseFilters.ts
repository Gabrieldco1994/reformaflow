import { useMemo, useState } from 'react';
import type { ExpenseQueryState } from '../_lib/expense-query-state';
import { tipoLabel, formaLabel } from '@/lib/expense-options';
import type { Expense } from '@/types';

export interface ExpenseFilters {
  tipoDespesa: string;
  room: string;
  titulo: string;
  fornecedor: string;
  formaPagamento: string;
  status: string;
}

const EMPTY_FILTERS: ExpenseFilters = {
  tipoDespesa: '',
  room: '',
  titulo: '',
  fornecedor: '',
  formaPagamento: '',
  status: '',
};

export interface ExpenseCategoryGroup {
  tipo: string;
  label: string;
  expenses: Expense[];
  totalPlanejado: number;
  totalPago: number;
  total: number;
}

export function useExpenseFilters(
  expenses: Expense[],
  showRooms: boolean,
  queryState: ExpenseQueryState,
  onQueryChange: (state: ExpenseQueryState) => void,
) {
  const [showFilters, setShowFilters] = useState(false);
  const filters: ExpenseFilters = {
    tipoDespesa: queryState.tipoDespesa,
    room: queryState.room,
    titulo: queryState.titulo,
    fornecedor: queryState.fornecedor,
    formaPagamento: queryState.formaPagamento,
    status: queryState.status,
  };
  const searchText = queryState.q;
  const setSearchText = (q: string) => onQueryChange({ ...queryState, q });
  const updateFilter = (key: keyof ExpenseFilters, value: string) =>
    onQueryChange({ ...queryState, [key]: value });
  const clearFilters = () => onQueryChange({
    ...queryState,
    q: '',
    ...EMPTY_FILTERS,
    rangeStart: '',
    rangeEnd: '',
  });

  const filteredExpenses = useMemo(() => expenses.filter((exp) => {
    if (filters.tipoDespesa && exp.tipoDespesa !== filters.tipoDespesa) return false;
    if (showRooms && filters.room && !(exp.room?.name ?? '').toLowerCase().includes(filters.room.toLowerCase())) return false;
    if (filters.titulo && !(exp.titulo ?? '').toLowerCase().includes(filters.titulo.toLowerCase())) return false;
    if (filters.fornecedor && !(exp.fornecedor ?? '').toLowerCase().includes(filters.fornecedor.toLowerCase())) return false;
    if (filters.formaPagamento && exp.formaPagamento !== filters.formaPagamento) return false;
    if (filters.status && exp.status !== filters.status) return false;
    if (searchText) {
      const searchable = [exp.id, exp.titulo, exp.fornecedor, exp.room?.name, tipoLabel(exp.tipoDespesa), formaLabel(exp.formaPagamento)]
        .filter(Boolean).join(' ').toLowerCase();
      if (!searchable.includes(searchText.toLowerCase())) return false;
    }
    return true;
  }), [expenses, filters.tipoDespesa, filters.room, filters.titulo, filters.fornecedor, filters.formaPagamento, filters.status, searchText, showRooms]);

  const hasActiveFilters = Object.values(filters).some((value) => value !== '') || searchText !== '';
  const categorias: ExpenseCategoryGroup[] = useMemo(() => {
    const catMap = new Map<string, Expense[]>();
    for (const exp of filteredExpenses) {
      const items = catMap.get(exp.tipoDespesa);
      if (items) items.push(exp); else catMap.set(exp.tipoDespesa, [exp]);
    }
    return Array.from(catMap.entries()).map(([cat, items]) => ({
      tipo: cat,
      label: tipoLabel(cat),
      expenses: items.sort((a, b) => b.valorTotal - a.valorTotal),
      totalPlanejado: items.filter((e) => e.status === 'PLANEJADO').reduce((sum, e) => sum + e.valorTotal, 0),
      totalPago: items.filter((e) => e.status === 'PAGO').reduce((sum, e) => sum + e.valorTotal, 0),
      total: items.reduce((sum, e) => sum + e.valorTotal, 0),
    })).sort((a, b) => b.total - a.total);
  }, [filteredExpenses]);

  return { showFilters, setShowFilters, filters, updateFilter, clearFilters, searchText, setSearchText, filteredExpenses, hasActiveFilters, categorias };
}
