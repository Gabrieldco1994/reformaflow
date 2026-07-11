import { describe, it, expect } from 'vitest';
import { filterBulkLinkSources } from './bulkLinkSearchFilter';
import type { Expense } from '@/types';

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    titulo: 'Restaurante XPTO',
    fornecedor: null,
    valorTotal: 10000,
    tipoDespesa: 'ALIMENTACAO',
    ...overrides,
  } as Expense;
}

describe('filterBulkLinkSources', () => {
  it('retorna todas as despesas quando query vazia', () => {
    const expenses = [makeExpense({ id: 'a' }), makeExpense({ id: 'b', titulo: 'Outro' })];
    expect(filterBulkLinkSources(expenses, '')).toHaveLength(2);
  });

  it('retorna todas as despesas quando query só tem espaços', () => {
    const expenses = [makeExpense({ id: 'a' })];
    expect(filterBulkLinkSources(expenses, '   ')).toHaveLength(1);
  });

  it('filtra por substring do título, case-insensitive', () => {
    const expenses = [
      makeExpense({ id: 'a', titulo: 'Restaurante XPTO' }),
      makeExpense({ id: 'b', titulo: 'Farmácia ABC' }),
    ];
    expect(filterBulkLinkSources(expenses, 'restaurante').map((e) => e.id)).toEqual(['a']);
  });

  it('filtra por substring do fornecedor quando título não bate', () => {
    const expenses = [
      makeExpense({ id: 'a', titulo: 'Compra', fornecedor: 'Mercado Livre' }),
      makeExpense({ id: 'b', titulo: 'Compra', fornecedor: 'Amazon' }),
    ];
    expect(filterBulkLinkSources(expenses, 'mercado').map((e) => e.id)).toEqual(['a']);
  });

  it('não quebra quando titulo/fornecedor são nulos', () => {
    const expenses = [makeExpense({ id: 'a', titulo: '', fornecedor: undefined })];
    expect(filterBulkLinkSources(expenses, 'xyz')).toHaveLength(0);
    expect(filterBulkLinkSources(expenses, '')).toHaveLength(1);
  });

  it('retorna lista vazia quando nada bate', () => {
    const expenses = [makeExpense({ id: 'a', titulo: 'Restaurante' })];
    expect(filterBulkLinkSources(expenses, 'zzz')).toEqual([]);
  });
});
