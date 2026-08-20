/**
 * Rateio parcial sob o contrato SOURCE-ONLY (#448) — W1.
 *
 * Participante fora da lente ⇒ a resposta é a de uma compra nunca rateada. Sem
 * lista parcial não há campo que declare o oculto nem número do qual derivá-lo.
 * Basta UM participante fora da lente para `GET :id/rateio` responder
 * `{ rateado: false, items: [], removedTargetsCount: 0, rateadoCents: 0,
 * sobraCents: totalSourceCents }`.
 *
 * Logo, quando vem lista, ela é COMPLETA: `rateadoCents` (Σ dos itens) e
 * `removedTargetsCount` cobrem todos os alvos, sem segunda leitura possível.
 * `hiddenTargetsCount`/`hiddenAllocationCents` não existem no contrato.
 *
 * Este módulo trata `rateado === false` silenciando o aviso — `sobra == total`
 * não é sobra, é uma compra que, para este leitor, não foi rateada — e sem
 * travar nada.
 *
 * Consequência de projeto, explicitada aqui para não voltar como bug: o web
 * NÃO consegue inferir parcialidade, e não deve tentar. A resposta de um rateio
 * parcialmente visível é indistinguível da de uma compra nunca rateada — POR
 * DESIGN. Uma regra fail-closed ("na dúvida, trava") travaria justamente o caso
 * normal, porque toda compra ainda não rateada chega como `rateado: false`: a
 * CTA "Ratear compra" morreria para todo mundo. Quem impede a escrita insegura
 * é o servidor:
 * `ratearMixed` chama `assertCanReverseSources`, que enumera TODA
 * `RateioAllocation` existente da fonte e responde 404 com ZERO writes se algum
 * alvo estiver fora da lente. O dever do web é mostrar esse erro honestamente
 * (os `onError` de `ratearMutation` já fazem isso).
 *
 * O mesmo princípio vale para a COPY: nenhuma frase daqui pode insinuar que
 * existe algo que o leitor não está vendo. Sobra oculta tem que ser
 * indistinguível de dinheiro genuinamente não alocado, inclusive no texto —
 * senão o vazamento que o payload fechou reabre pela porta da interface.
 */

import { formatCurrency } from '@/lib/utils';

/** Campos de visibilidade que o contrato AINDA declara. */
export interface RateioVisibilityFields {
  /**
   * `false` = para ESTE leitor a compra não está rateada. Sob source-only
   * estrito é o que chega quando qualquer participante está fora da lente: o
   * payload inteiro é o de uma compra nunca rateada.
   */
  rateado?: boolean;
  /** Alocações cujo alvo foi soft-deletado DENTRO da lente do requisitante. */
  removedTargetsCount?: number;
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Centavos utilizáveis, ou `null` quando o servidor não mandou o número.
 * Existe para que nenhuma divisão por 100 vire `R$ NaN` na tela quando o
 * contrato encolhe.
 */
export function knownCents(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Trava a edição destrutiva quando o servidor declara alvos REMOVIDOS.
 *
 * Fonte de verdade única e explícita: `removedTargetsCount > 0` — alvo removido
 * DENTRO da lente, declarado pelo servidor. Não existe segundo gatilho: um
 * critério que só disparasse contra servidor velho seria invisível em produção
 * e irreproduzível. Ausência de declaração NÃO trava (ver docstring do módulo).
 */
export function isRateioEditLocked(detalhe: RateioVisibilityFields | undefined): boolean {
  if (!detalhe) return false;
  return count(detalhe.removedTargetsCount) > 0;
}

/**
 * Aviso do detalhe do rateio, ou `null` quando não há o que avisar.
 *
 * Guarda source-only PRIMEIRO: com `rateado === false` a compra, para este
 * leitor, não está rateada — `sobraCents` vem igual ao total e transformar isso
 * em aviso seria alarme fabricado sobre uma compra comum. Hoje a
 * `RateioDetalheSection` nem chega aqui (retorna `null` antes), mas a
 * propriedade tem que valer no módulo, e não em um call site: esta função é
 * exportada e o próximo consumidor não vai lembrar do gate.
 *
 * A frase da sobra é DELIBERADAMENTE descritiva: ela não pode (a) soar como
 * defeito de dado — "a soma não fecha" acusa quem não fez nada errado — nem
 * (b) sugerir que há participante oculto, o que seria o vazamento voltando como
 * texto. Ela só nomeia o número que já está na tela.
 */
export function rateioWarningMessage(
  detalhe: RateioVisibilityFields | undefined,
  sobraCents: number | null | undefined,
): string | null {
  if (detalhe?.rateado === false) return null;
  const removed = count(detalhe?.removedTargetsCount);
  if (removed > 0) {
    return removed === 1
      ? '1 planejada removida deste rateio.'
      : `${removed} planejadas removidas deste rateio.`;
  }
  const sobra = knownCents(sobraCents);
  if (sobra === null || sobra === 0) return null;
  return `Esta compra tem ${formatCurrency(sobra / 100)} sem alocação em planejadas.`;
}
