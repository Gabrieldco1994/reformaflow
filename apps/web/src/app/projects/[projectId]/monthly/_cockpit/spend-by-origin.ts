import type { MonthlyEntry } from '../_types';
import { entryIsNeutral, isNeutralAccountSettlement } from './neutral';

/**
 * Soma o quanto foi gasto por origem — cartão (`cardLast4`) e conta (`bankLast4`) —
 * a partir das entries já filtradas do mês. As `entries` refletem o eixo ativo
 * (competência ou caixa), então o resultado respeita "Gastei" vs "Vai sair".
 *
 * Regra de neutro POR EIXO (semântica diferente):
 * - **caixa ("Vai sair", `keepCardSettlement: true`)**: exclui só a liquidação PELA
 *   CONTA (`isNeutral && bankLast4`); mantém neutro cobrado NO CARTÃO ("cartão paga
 *   cartão"), que é cobrança real na fatura → bate com a Visão Conta (service:372).
 * - **competência ("Gastei", padrão)**: exclui TODO neutro — pagamento de fatura /
 *   movimentação interna não é consumo.
 *
 * Escopo PESSOAL (`pessoalProjectId`): quando informado, conta só lançamentos do
 * projeto PESSOAL — igual à Visão Conta (`getAccountView`, que consulta
 * `projectId === PESSOAL`). Isso mantém o espelho (lançamento PESSOAL de uma compra
 * cross-project) e descarta o canônico do outro projeto, evitando dupla contagem no
 * cartão/conta pessoal.
 */
export function spendByOrigin(
  entries: MonthlyEntry[],
  opts: { keepCardSettlement?: boolean; pessoalProjectId?: string } = {},
): {
  cards: Map<string, number>;
  accounts: Map<string, number>;
} {
  const { keepCardSettlement = false, pessoalProjectId } = opts;
  const cards = new Map<string, number>();
  const accounts = new Map<string, number>();
  for (const e of entries) {
    if (e.tipo !== 'DESPESA') continue;
    if (pessoalProjectId && e.projectId !== pessoalProjectId) continue;
    if (keepCardSettlement ? isNeutralAccountSettlement(e) : entryIsNeutral(e)) continue;
    if (e.cardLast4) {
      cards.set(e.cardLast4, (cards.get(e.cardLast4) ?? 0) + e.valor);
    } else if (e.bankLast4) {
      accounts.set(e.bankLast4, (accounts.get(e.bankLast4) ?? 0) + e.valor);
    }
  }
  return { cards, accounts };
}
