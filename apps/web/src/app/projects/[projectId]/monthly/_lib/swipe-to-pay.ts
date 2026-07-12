import type { MonthlyEntry } from "../_types";
import { entryIsConsumptionNeutral, entryIsNeutral } from "../_cockpit/neutral";

/**
 * Alvo de "marcar como pago" via swipe (inovação #4). Enforça I2 (a Expense
 * a ser paga é `entry.expenseId`, NUNCA `entry.id` — este último é o id do
 * CashFlowEntry, um id DIFERENTE) e I4 (regras de elegibilidade para swipe).
 *
 * Ponto único de aplicação: tanto o gesto de swipe do cockpit quanto (no
 * futuro) qualquer outro atalho de "pagar" devem chamar esta função, para
 * que a regra de elegibilidade nunca divirja entre os dois lugares (mesmo
 * espírito do `resolveOwnerProjectId`/skip cross-project já usado em
 * `useExpenseMutations`).
 */
export interface SwipeToPayTarget {
  expenseId: string;
  ownerProjectId: string;
}

const REALIZED_STATUSES = new Set(["PAGO", "EM_CAIXA"]);

export function resolveSwipeToPayTarget(
  entry: MonthlyEntry,
  viewingProjectId: string,
): SwipeToPayTarget | null {
  if (entry.tipo !== "DESPESA") return null;
  if (REALIZED_STATUSES.has(entry.status)) return null;
  if (!entry.expenseId) return null;
  if (entryIsNeutral(entry)) return null;
  if (entryIsConsumptionNeutral(entry)) return null;
  if (entry.isEspelho) return null;
  if (entry.projectId !== viewingProjectId) return null;

  return { expenseId: entry.expenseId, ownerProjectId: entry.projectId };
}
