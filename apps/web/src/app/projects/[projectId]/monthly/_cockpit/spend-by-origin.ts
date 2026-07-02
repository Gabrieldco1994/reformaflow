import { isNeutralExpenseType } from '@reformaflow/domain';
import type { MonthlyEntry } from '../_types';

/**
 * Soma o quanto foi GASTO (despesas, excluindo neutros como pagamento de fatura)
 * por origem — cartão (`cardLast4`) e conta (`bankLast4`) — a partir das entries
 * já filtradas do mês. Como `entries` reflete o eixo ativo (competência ou caixa),
 * o resultado respeita automaticamente "Gastei" vs "Vai sair".
 *
 * Neutros são excluídos para não dobrar o gasto (o pagamento da fatura não é
 * consumo — as compras do cartão já contam).
 */
export function spendByOrigin(entries: MonthlyEntry[]): {
  cards: Map<string, number>;
  accounts: Map<string, number>;
} {
  const cards = new Map<string, number>();
  const accounts = new Map<string, number>();
  for (const e of entries) {
    if (e.tipo !== 'DESPESA') continue;
    if (isNeutralExpenseType(e.categoriaCodigo)) continue;
    if (e.cardLast4) {
      cards.set(e.cardLast4, (cards.get(e.cardLast4) ?? 0) + e.valor);
    } else if (e.bankLast4) {
      accounts.set(e.bankLast4, (accounts.get(e.bankLast4) ?? 0) + e.valor);
    }
  }
  return { cards, accounts };
}
