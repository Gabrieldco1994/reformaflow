/**
 * Deriva o status visual (badge) de um cartão na carteira mobile de Despesas.
 *
 * account-view SEMPRE preenche dueMonth/vencimento (mesmo quando o cartão não
 * tem closingDay cadastrado, ele cai num fallback de "mês atual, dia 1"), então
 * não dá para usar a ausência de dueMonth/vencimento como sinal de "falta configurar".
 * A fonte de verdade é o cadastro do cartão (closingDay real) em /tenant/credit-cards.
 */
export type CardWalletStatus = 'configurar' | 'paga' | 'aberta';

export function deriveCardWalletStatus(
  card: { status: string; dueMonth: string; vencimento: string },
  cardMeta: { closingDay: number | null } | undefined,
): CardWalletStatus {
  // Enquanto /tenant/credit-cards ainda não carregou, cai para o sinal antigo
  // (dueMonth/vencimento ausentes) só como fallback transitório.
  const semFechamento = cardMeta ? cardMeta.closingDay == null : !card.dueMonth || !card.vencimento;
  if (semFechamento) return 'configurar';
  return card.status === 'paga' ? 'paga' : 'aberta';
}
