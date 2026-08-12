import type { ExpensePaidOrigin, PaidOriginRef, PaidOriginsResponse } from '@/types';

/**
 * Rótulo de exibição de uma origem de pagamento (#424).
 * Regra: apelido quando existir; caso contrário fallback "Cartão"/"Conta ••last4".
 * Nunca acessa `cardLast4`/`bankLast4` do alvo — o rótulo é sempre derivado da
 * origem resolvida pelo backend (O1: o alvo REFORMA nunca é escrito/lido para isso).
 */
export function formatPaidOriginLabel(origin: PaidOriginRef): string {
  if (origin.nickname) return `${origin.nickname} ••${origin.last4}`;
  const fallback = origin.kind === 'card' ? 'Cartão' : 'Conta';
  return `${fallback} ••${origin.last4}`;
}

/**
 * Resolve a origem aplicável a uma ocorrência específica de uma despesa.
 * - via='settlement': casa por parcelaIndex (0-based) === occIndex (1-based) - 1.
 *   Sem parcela correspondente → null (nunca cai na primeira por engano).
 * - via='rateio'|'link': a origem agregada (única) vale para QUALQUER occIndex.
 * - entry ausente (loading/erro/sem origem) → null.
 */
export function pickOriginForOccurrence(
  entry: ExpensePaidOrigin | undefined,
  occIndex: number,
): PaidOriginRef | null {
  if (!entry) return null;
  if (entry.via === 'settlement') {
    const parcelaIndex = occIndex - 1;
    const match = entry.parcelas.find((p) => p.parcelaIndex === parcelaIndex);
    return match ? match.origin : null;
  }
  // rateio | link: uma única origem agregada, aplicada a todas as ocorrências.
  return entry.origins[0] ?? null;
}

/** Indexa a resposta do endpoint por expenseId; tolera resposta ausente. */
export function buildPaidOriginIndex(
  response: PaidOriginsResponse | undefined,
): Map<string, ExpensePaidOrigin> {
  const map = new Map<string, ExpensePaidOrigin>();
  if (!response) return map;
  for (const item of response.items) map.set(item.expenseId, item);
  return map;
}
