import { BudgetStatus, CashFlowType } from '../enums';
import type { CashFlowEntry, CashFlowEntryComputed } from '../types';

/**
 * Calcula o saldo: previsto - realizado
 * Regra: saldo = previsto - realizado (planilha: =C-D)
 */
export function calculateBalance(planned: number, actual: number): number {
  return planned - actual;
}

/**
 * Calcula o % consumido: realizado / previsto
 * Regra: proteger divisão por zero (planilha: =IFERROR(D/C, 0))
 */
export function calculatePercentConsumed(planned: number, actual: number): number {
  if (planned === 0) return 0;
  return actual / planned;
}

/**
 * Determina o status do orçamento baseado no % consumido
 * Regra da planilha:
 *   - previsto = 0 → '-'
 *   - % > 100% → OVER_BUDGET (Estourado)
 *   - 80% ≤ % ≤ 100% → WARNING (Atenção)
 *   - caso contrário → OK
 */
export function calculateBudgetStatus(
  planned: number,
  actual: number,
): BudgetStatus | '-' {
  if (planned === 0) return '-';
  const percent = calculatePercentConsumed(planned, actual);
  if (percent > 1) return BudgetStatus.OVER_BUDGET;
  if (percent >= 0.8) return BudgetStatus.WARNING;
  return BudgetStatus.OK;
}

/**
 * Calcula o valor liberado ao empreiteiro
 * Regra: valorLiberado = valorContratado × percentualConcluído
 * (planilha: =C*D na aba Empreiteiro)
 */
export function calculateReleasedAmount(
  contractedAmount: number,
  percentCompleted: number,
): number {
  return contractedAmount * percentCompleted;
}

/**
 * Calcula o saldo acumulado do fluxo de caixa (rolling balance)
 * Regra da planilha:
 *   - Primeira linha: se Entrada → +valor, se Saída → -valor
 *   - Demais: saldoAnterior + valor (se Entrada) ou saldoAnterior - valor (se Saída)
 */
export function calculateRollingBalance(
  entries: Pick<CashFlowEntry, 'type' | 'amount'>[],
): number[] {
  const balances: number[] = [];
  let running = 0;

  for (const entry of entries) {
    if (entry.type === CashFlowType.INCOME) {
      running += entry.amount;
    } else {
      running -= entry.amount;
    }
    balances.push(running);
  }

  return balances;
}

/**
 * Enriquece entradas de fluxo de caixa com saldo acumulado
 */
export function computeCashFlowEntries(
  entries: CashFlowEntry[],
): CashFlowEntryComputed[] {
  const balances = calculateRollingBalance(entries);
  return entries.map((entry, i) => ({
    ...entry,
    rollingBalance: balances[i]!,
  }));
}

/**
 * Calcula o Realizado total de um BudgetItem
 * Regra: soma de MaterialPurchases (por Room+WorkType) + ContractorMilestones pagos
 */
export function calculateActual(
  purchasesTotal: number,
  paidMilestonesTotal: number,
): number {
  return purchasesTotal + paidMilestonesTotal;
}

/**
 * Calcula o valor sugerido para contingência (10-20% do total previsto)
 */
export function calculateContingencySuggestion(
  totalPlanned: number,
  percentage: number = 0.15,
): number {
  return totalPlanned * Math.min(Math.max(percentage, 0.1), 0.2);
}
