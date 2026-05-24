/**
 * Parser OFX para extrato bancário. Reaproveita o do credit-card
 * (a convenção é a mesma: TRNAMT negativo = débito → vira positivo nas nossas despesas).
 */
import { parseOfx as parseCreditCardOfx } from '../../credit-card/parsers/ofx';
import type { ParseResult } from '../../credit-card/parsers/types';

export function parseBankOfx(content: string, accountId: string): ParseResult {
  // O parser do credit-card usa "cardId" só como semente para o externalId hash.
  // Passamos accountId aqui — gera externalIds estáveis e idempotentes.
  return parseCreditCardOfx(content, accountId);
}
