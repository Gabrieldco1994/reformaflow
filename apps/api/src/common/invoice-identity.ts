import { ConflictException } from '@nestjs/common';

/**
 * Identidade de cartão/conta em superfícies que ainda aceitam a chave LEGADA
 * (`last4`) além do id exato (`cardId`/`accountId`, aditivos no B1a #448).
 *
 * Uma única mensagem por condição, compartilhada por todas as superfícies: a
 * importação de extrato (`BankAccountService`) e o cockpit (`payInvoice`/
 * `undoInvoicePayment`) recusam a MESMA ambiguidade com o MESMO texto, então
 * cliente e suporte não precisam aprender dois vocabulários para o mesmo
 * problema. Nenhuma mensagem revela quantas duplicatas existem nem quais são.
 */
export const AMBIGUOUS_CARD_MESSAGE = 'Cartão ambíguo';
export const AMBIGUOUS_ACCOUNT_MESSAGE = 'Conta ambígua';

/**
 * Colapsa candidatos de uma resolução por chave legada em UMA identidade.
 *
 * `last4` não é identidade: dois cartões (ou duas contas) ativos do mesmo
 * projeto podem compartilhá-lo em dados legados — o guard de duplicado do B1a
 * só impede que a colisão CRESÇA, não apaga a que já existe. Antes do B1b, o
 * `findFirst` legado escolhia um em silêncio e a ação caía no registro que o
 * servidor adivinhou. Aqui a ambiguidade falha alto (409, #448 B1b) e o caller
 * fica com duas saídas honestas: mandar o id exato ou desfazer a duplicidade.
 *
 * Quem resolve por id exato NÃO passa por aqui: identidade completa nunca é
 * ambígua. `null` (nenhum candidato) segue sendo "não encontrado" do caller —
 * este helper não decide o 404, para não achatar as mensagens de cada rota.
 *
 * @param matches candidatos ATIVOS já filtrados por tenant/projeto (basta ler 2).
 * @param ambiguousMessage `AMBIGUOUS_CARD_MESSAGE` ou `AMBIGUOUS_ACCOUNT_MESSAGE`.
 */
export function resolveUniqueLegacyMatch<T>(
  matches: T[],
  ambiguousMessage: string,
): T | null {
  if (matches.length > 1) {
    throw new ConflictException(ambiguousMessage);
  }
  return matches[0] ?? null;
}

/** Finais com mais de um registro ATIVO — a leitura não pode oferecer CTA neles. */
export function ambiguousLast4Set(rows: Array<{ last4: string | null }>): Set<string> {
  const countByLast4 = new Map<string, number>();
  for (const row of rows) {
    if (!row.last4) continue;
    countByLast4.set(row.last4, (countByLast4.get(row.last4) ?? 0) + 1);
  }
  const ambiguous = new Set<string>();
  for (const [last4, count] of countByLast4) {
    if (count > 1) ambiguous.add(last4);
  }
  return ambiguous;
}
