import type { Expense, ExpenseFormData } from '@/types';

export function isExpenseCredit(expense?: Pick<Expense, 'valorTotal'> | null): boolean {
  return !!expense && expense.valorTotal < 0;
}

/** Additive to existing permissions; sign never establishes refund ownership. */
export function canDeleteExpense(expense: Pick<Expense, 'valorTotal' | 'canDelete'>): boolean {
  return isExpenseCredit(expense) ? expense.canDelete === true : expense.canDelete !== false;
}

export function expenseUpdatePayload(
  expense: Pick<Expense, 'valorTotal'> | null | undefined,
  data: Partial<ExpenseFormData>,
) {
  if (!isExpenseCredit(expense)) return data;
  // ponytail: all credits are metadata-only; ownership stays on the server.
  const { titulo, fornecedor, link, imageUrl } = data;
  return { titulo, fornecedor, link, imageUrl };
}

/**
 * Identity of the ROOT expense, never of an occurrence: cash-flow / parcela /
 * window-sum amounts do not tell whether the root is a credit.
 *  - 'credit'     : the server flag says so, or the real detail proves valorTotal < 0
 *                   (credit wins over any conflicting 'not-credit' signal);
 *  - 'not-credit' : flag === false or the real detail proves valorTotal >= 0.
 *                   This is NOT a permission: documented schedule, neutral, funding
 *                   and server-derived action rules still apply on top of it;
 *  - 'unknown'    : nothing proven yet (optional field absent, detail missing/loading/error).
 */
export type RootIdentity = 'credit' | 'not-credit' | 'unknown';

export function rootIdentity(
  flag: boolean | undefined,
  detail?: Pick<Expense, 'valorTotal'> | null,
): RootIdentity {
  const proven = !!detail && typeof detail.valorTotal === 'number';
  if (flag === true || (proven && isExpenseCredit(detail))) return 'credit';
  if (flag === false || proven) return 'not-credit';
  return 'unknown';
}
