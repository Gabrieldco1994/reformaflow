/**
 * Rateio parcial sob o contrato SOURCE-ONLY do B1b (#448) — W1.
 *
 * `GET :id/rateio` responde hoje o payload REDIGIDO pela lente do requisitante:
 *
 *  - participante fora da lente é **omitido por inteiro** — `hiddenTargetsCount`
 *    e `hiddenAllocationCents` foram REMOVIDOS do contrato, não zerados;
 *  - `rateadoCents` é Σ dos itens **visíveis**. Mantê-lo total-aware era o
 *    vazamento: `totalSourceCents − Σ items` devolvia a soma oculta por
 *    subtração, e `sobraCents === 0` denunciava o participante escondido;
 *  - `rateado: false` quando nenhum participante é visível;
 *  - `removedTargetsCount` sobrevive, **filtrado pela lente**.
 *
 * Consequência de projeto, explicitada aqui para não voltar como bug: o web
 * NÃO consegue inferir parcialidade, e não deve tentar. O payload redigido é
 * deep-equal ao de uma compra sem nada oculto — POR DESIGN. Uma regra
 * fail-closed ("na dúvida, trava") mataria a CTA "Ratear compra"
 * permanentemente para todo mundo. Quem impede a escrita insegura é o servidor:
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
 * Fonte de verdade única e explícita: `removedTargetsCount > 0`. A leitura de
 * `hiddenTargetsCount` saiu daqui no handoff do B1b — o campo não existe mais
 * no contrato, então mantê-lo seria um segundo gatilho invisível, que só
 * dispararia contra servidor velho e que ninguém conseguiria reproduzir.
 * Ausência de declaração NÃO trava (ver docstring do módulo).
 */
export function isRateioEditLocked(detalhe: RateioVisibilityFields | undefined): boolean {
  if (!detalhe) return false;
  return count(detalhe.removedTargetsCount) > 0;
}

/**
 * Aviso do detalhe do rateio, ou `null` quando não há o que avisar.
 *
 * A frase da sobra é DELIBERADAMENTE descritiva: sob o contrato source-only um
 * viewer restrito passa a ver `sobraCents !== 0` legitimamente, então a cópia
 * não pode (a) soar como defeito de dado — "a soma não fecha" acusa quem não
 * fez nada errado — nem (b) sugerir que há participante oculto, o que seria o
 * vazamento voltando como texto. Ela só nomeia o número que já está na tela.
 */
export function rateioWarningMessage(
  detalhe: RateioVisibilityFields | undefined,
  sobraCents: number | null | undefined,
): string | null {
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
