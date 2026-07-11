import { isNeutralExpenseType } from '@reformaflow/domain';
import type { Expense } from '@/types';

/**
 * Filtra as despesas elegíveis para o fluxo "Vincular em massa": exclui as
 * que já têm vínculo (`linkedExpenseId` preenchido) e as de tipo neutro
 * (não fazem sentido rateadas/vinculadas a outro projeto).
 */
export function selectEligibleForBulkLink(expenses: Expense[]): Expense[] {
  return expenses.filter((e) => !e.linkedExpenseId && !isNeutralExpenseType(e.tipoDespesa));
}
