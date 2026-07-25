/**
 * Identificação do CARTÃO por trás de um pagamento de fatura que aparece no
 * extrato bancário.
 *
 * Contexto (bug real, jul/2026): uma linha "FATURA PAGA Itaú Personn" de
 * R$ 17.655,85 entrou como `PAGAMENTO_FATURA_CARTAO` com `cardLast4: null`,
 * porque `findMatchingCreditCard` só sabia casar contra o total de uma
 * `CreditCardStatementImport`. Sem `cardLast4`:
 *   - a §10 debita o caixa (correto — o dinheiro saiu), mas
 *   - `getAccountView` ignora o pagamento na quitação da fatura (exige
 *     `!!cardLast4`), então a fatura continua pendente → dinheiro contado 2×.
 *
 * A fatura em aberto NÃO precisa ter sido importada para ser reconhecida: o
 * total dela já existe, derivado das compras do cartão agrupadas pelo mês de
 * vencimento (`caixaMonthForCardPurchase`) — a MESMA regra que a Visão Conta
 * usa para montar `invoiceByMonthCard`.
 *
 * Este módulo é puro (sem Prisma) para poder ser testado direto.
 */
import { caixaMonthForCardPurchase } from '@reformaflow/domain';

/** Tolerância para considerar que o pagamento quita a fatura inteira. */
export const CARD_MATCH_TOLERANCE_CENTS = 200; // R$ 2 (encargos variam)

/** Meses de vencimento considerados, relativos ao mês do pagamento. */
const DUE_MONTH_OFFSETS = [-1, 0, 1];

export interface CardWithEntries {
  last4: string;
  nickname: string;
  closingDay: number | null;
  dueDay: number | null;
  /** Lançamentos de caixa das COMPRAS do cartão (não-neutras). */
  entries: Array<{ data: Date; valor: number }>;
}

export interface CardInvoiceCandidate {
  cardLast4: string;
  nickname: string;
  dueMonth: string;
  invoiceTotalCents: number;
  /** invoiceTotal − pagamento. Negativo = pagamento maior que a fatura. */
  deltaCents: number;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key: string, offset: number): string {
  const [year, month] = key.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 + offset, 1));
  return monthKey(d);
}

/**
 * Totais de fatura por cartão × mês de vencimento.
 * Mesma regra da Visão Conta: cada lançamento cai no mês de vencimento dado por
 * `caixaMonthForCardPurchase`; cartão sem closingDay/dueDay cai no mês de
 * competência (fallback da própria função de domínio).
 */
export function aggregateInvoiceTotals(
  card: CardWithEntries,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of card.entries) {
    const dueMonth = caixaMonthForCardPurchase(entry.data, card.closingDay, card.dueDay);
    totals.set(dueMonth, (totals.get(dueMonth) ?? 0) + entry.valor);
  }
  return totals;
}

/**
 * Ranqueia os cartões cuja fatura pode corresponder a este pagamento, do mais
 * provável ao menos provável (menor diferença de valor primeiro).
 *
 * Não decide nada sozinho: serve tanto para o auto-match estrito
 * (`pickUniqueCardMatch`) quanto para a lista que o usuário escolhe na tela de
 * importação — na prática o pagamento raramente bate centavo a centavo com a
 * fatura em aberto (parcial, encargos, compras lançadas depois).
 */
export function rankCardCandidates(
  cards: CardWithEntries[],
  amountCents: number,
  paymentDate: Date,
  limit = 6,
): CardInvoiceCandidate[] {
  const payMonth = monthKey(paymentDate);
  const wanted = new Set(DUE_MONTH_OFFSETS.map((offset) => shiftMonth(payMonth, offset)));

  const candidates: CardInvoiceCandidate[] = [];
  for (const card of cards) {
    for (const [dueMonth, total] of aggregateInvoiceTotals(card)) {
      if (!wanted.has(dueMonth)) continue;
      if (total <= 0) continue;
      candidates.push({
        cardLast4: card.last4,
        nickname: card.nickname,
        dueMonth,
        invoiceTotalCents: total,
        deltaCents: total - amountCents,
      });
    }
  }

  return candidates
    .sort((a, b) => {
      const byDelta = Math.abs(a.deltaCents) - Math.abs(b.deltaCents);
      if (byDelta !== 0) return byDelta;
      return a.dueMonth.localeCompare(b.dueMonth);
    })
    .slice(0, limit);
}

/**
 * Auto-match ESTRITO: só devolve um cartão quando não há dúvida — todos os
 * candidatos dentro da tolerância são do MESMO cartão. Dois cartões diferentes
 * com fatura no mesmo valor = ambíguo, e chutar aqui é pior que perguntar
 * (o preview mostra a lista para o usuário escolher).
 */
export function pickUniqueCardMatch(
  candidates: CardInvoiceCandidate[],
): CardInvoiceCandidate | null {
  const close = candidates.filter(
    (c) => Math.abs(c.deltaCents) <= CARD_MATCH_TOLERANCE_CENTS,
  );
  if (close.length === 0) return null;
  const distinctCards = new Set(close.map((c) => c.cardLast4));
  if (distinctCards.size > 1) return null;
  return close[0];
}
