import { useMemo, useState } from 'react';
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

export function useExpenseFilters(expenses: Expense[], showRooms: boolean) {
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<ExpenseFilters>(EMPTY_FILTERS);
  const [searchText, setSearchText] = useState('');

  const updateFilter = (key: keyof ExpenseFilters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearchText('');
  };

  const filteredExpenses = useMemo(() => {
    return expenses.filter((exp) => {
      if (filters.tipoDespesa && exp.tipoDespesa !== filters.tipoDespesa) return false;
      if (showRooms && filters.room) {
        const roomName = exp.room?.name ?? '';
        if (!roomName.toLowerCase().includes(filters.room.toLowerCase())) return false;
      }
      if (filters.titulo) {
        if (!(exp.titulo ?? '').toLowerCase().includes(filters.titulo.toLowerCase())) return false;
      }
      if (filters.fornecedor) {
        if (!(exp.fornecedor ?? '').toLowerCase().includes(filters.fornecedor.toLowerCase())) return false;
      }
      if (filters.formaPagamento && exp.formaPagamento !== filters.formaPagamento) return false;
      if (filters.status && exp.status !== filters.status) return false;
      if (searchText) {
        const s = searchText.toLowerCase();
        const searchable = [
          exp.id, exp.titulo, exp.fornecedor, exp.room?.name,
          tipoLabel(exp.tipoDespesa), formaLabel(exp.formaPagamento),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!searchable.includes(s)) return false;
      }
      return true;
    });
  }, [expenses, filters, searchText, showRooms]);

  const hasActiveFilters = Object.values(filters).some((v) => v !== '') || searchText !== '';

  const categorias: ExpenseCategoryGroup[] = useMemo(() => {
    const catMap = new Map<string, Expense[]>();
    for (const exp of filteredExpenses) {
      const cat = exp.tipoDespesa;
      const arr = catMap.get(cat);
      if (arr) arr.push(exp);
      else catMap.set(cat, [exp]);
    }
    return Array.from(catMap.entries())
      .map(([cat, items]) => ({
        tipo: cat,
        label: tipoLabel(cat),
        expenses: items.sort((a, b) => b.valorTotal - a.valorTotal),
        totalPlanejado: items.filter((e) => e.status === 'PLANEJADO').reduce((s, e) => s + e.valorTotal, 0),
        totalPago: items.filter((e) => e.status === 'PAGO').reduce((s, e) => s + e.valorTotal, 0),
        total: items.reduce((s, e) => s + e.valorTotal, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [filteredExpenses]);

  return {
    showFilters,
    setShowFilters,
    filters,
    updateFilter,
    clearFilters,
    searchText,
    setSearchText,
    filteredExpenses,
    hasActiveFilters,
    categorias,
  };
}
