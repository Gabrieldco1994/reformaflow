/**
 * Parser CSV para extrato bancário.
 *
 * Convenção:
 *   - CSV de extrato bancário: NEGATIVO = débito, POSITIVO = crédito
 *   - Nossa Expense: amountCents POSITIVO = despesa, NEGATIVO = crédito (ignorado no commit)
 *
 * Estratégia: reaproveita parseCsv do credit-card (que já normaliza despesa = positivo
 * via flag CSV_ITAU) e DEPOIS inverte os sinais — porque do ponto de vista do banco,
 * a interpretação é oposta à da fatura de cartão.
 */
import { parseCsv as parseCreditCardCsv } from '../../credit-card/parsers/csv';
import { makeExternalId } from '../../credit-card/parsers/types';
import type { ParseResult } from '../../credit-card/parsers/types';

export function parseBankCsv(content: string, accountId: string): ParseResult {
  const raw = parseCreditCardCsv(content, { cardId: accountId, source: 'CSV_GENERIC' });

  // Inverte sinal e regenera externalId (porque o hash depende do amountCents)
  const transactions = raw.transactions.map((t) => {
    const amountCents = -t.amountCents;
    return {
      ...t,
      amountCents,
      externalId: makeExternalId({
        cardId: accountId,
        date: t.date,
        merchant: t.merchant,
        amountCents,
      }),
    };
  });

  const totalAmountCents = transactions
    .filter((t) => t.amountCents > 0)
    .reduce((s, t) => s + t.amountCents, 0);

  return {
    source: 'CSV_GENERIC',
    transactions,
    totalAmountCents,
    periodLabel: raw.periodLabel,
  };
}
