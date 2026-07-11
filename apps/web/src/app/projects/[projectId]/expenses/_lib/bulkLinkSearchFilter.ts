import type { Expense } from '@/types';

/**
 * Filtra despesas elegíveis do modal "Vincular em massa" por texto de busca
 * (título ou fornecedor, case-insensitive, sem acentuação estrita — apenas
 * substring simples). Texto vazio/whitespace retorna a lista inteira.
 */
export function filterBulkLinkSources(expenses: Expense[], query: string): Expense[] {
  const q = query.trim().toLowerCase();
  if (!q) return expenses;
  return expenses.filter((e) => {
    const titulo = (e.titulo ?? '').toLowerCase();
    const fornecedor = (e.fornecedor ?? '').toLowerCase();
    return titulo.includes(q) || fornecedor.includes(q);
  });
}
