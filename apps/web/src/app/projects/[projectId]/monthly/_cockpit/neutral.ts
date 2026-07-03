import { isNeutralExpenseType } from '@reformaflow/domain';
import type { MonthlyEntry } from '../_types';

type NeutralEntry = Pick<
  MonthlyEntry,
  'isNeutral' | 'bankLast4' | 'tipoDespesaCodigo' | 'categoriaCodigo'
>;

/**
 * A entry é de tipo NEUTRO (pagamento de fatura / movimentação interna)?
 *
 * Fonte de verdade: o backend deriva `isNeutral` de `expense.tipoDespesa` (enum
 * confiável). Quando presente, usamos direto. O fallback (backend antigo, antes do
 * deploy) usa o enum cru — nunca `categoria`/`categoriaCodigo` como label, que é
 * ambíguo — degradando com segurança para o comportamento anterior.
 */
export function entryIsNeutral(e: NeutralEntry): boolean {
  if (typeof e.isNeutral === 'boolean') return e.isNeutral;
  return isNeutralExpenseType(e.tipoDespesaCodigo ?? e.categoriaCodigo ?? undefined);
}

/**
 * Neutro que é LIQUIDAÇÃO pela CONTA (pagar fatura pela conta corrente): as compras
 * já contaram nas faturas, então NÃO conta em lugar nenhum. Espelha exatamente
 * `monthly-overview.service.ts:372` (fonte de verdade da Visão Conta).
 *
 * Neutro cobrado NO CARTÃO (cardLast4, sem bankLast4) — ex.: "cartão paga cartão" —
 * é cobrança real na fatura e NÃO é liquidação-na-conta: permanece no eixo caixa.
 */
export function isNeutralAccountSettlement(e: NeutralEntry): boolean {
  return entryIsNeutral(e) && !!e.bankLast4;
}
