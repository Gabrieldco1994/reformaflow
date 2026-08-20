/**
 * Rateio parcial sob contrato mixed-version — W1 (#448).
 *
 * O payload de `GET :id/rateio` existe hoje em DUAS formas, porque os deploys
 * de web e API não são atômicos:
 *
 *  - **API antiga (pré-B1b):** manda `hiddenTargetsCount`,
 *    `hiddenAllocationCents` e `removedTargetsCount`.
 *  - **API nova (B1b):** esses campos saem do contrato. O payload redigido é
 *    deep-equal a uma resposta sem nada oculto — POR DESIGN, para não revelar
 *    a existência de participantes fora da lente do requisitante.
 *
 * Consequência de projeto, explicitada aqui para não voltar como bug:
 * o web NÃO consegue inferir parcialidade no payload novo, e não deve tentar.
 * Uma regra fail-closed ("na dúvida, trava") mataria a CTA "Ratear compra"
 * permanentemente para todo mundo assim que B1b subisse. Quem impede a escrita
 * insegura é o servidor — `ratearMixed` chama `assertCanReverseSources`, que
 * enumera TODA `RateioAllocation` existente da fonte e responde 404 com ZERO
 * writes se algum alvo estiver fora da lente. O dever do web é mostrar esse
 * erro honestamente (os `onError` de `ratearMutation` já fazem isso).
 */

import { formatCurrency } from '@/lib/utils';

/** Só os campos de visibilidade — todos opcionais no contrato novo. */
export interface RateioVisibilityFields {
  hiddenTargetsCount?: number;
  hiddenAllocationCents?: number;
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
 * Trava a edição destrutiva quando o servidor DECLARA alocações ocultas ou
 * removidas (API antiga). Ausência de declaração não trava — ver docstring do
 * módulo.
 */
export function isRateioEditLocked(detalhe: RateioVisibilityFields | undefined): boolean {
  if (!detalhe) return false;
  return count(detalhe.hiddenTargetsCount) > 0 || count(detalhe.removedTargetsCount) > 0;
}

/**
 * Frase sobre alocações ocultas, ou `null`. Devolve `null` sempre que o
 * servidor não mandou contagem E soma — nunca inventamos "0 alocações" nem
 * exibimos um valor derivado de campo ausente.
 */
export function hiddenAllocationsNotice(
  detalhe: RateioVisibilityFields | undefined,
): string | null {
  const hidden = count(detalhe?.hiddenTargetsCount);
  if (hidden <= 0) return null;
  const cents = knownCents(detalhe?.hiddenAllocationCents);
  if (cents === null) return null;
  return hidden === 1
    ? `1 alocação em projeto sem acesso · ${formatCurrency(cents / 100)}`
    : `${hidden} alocações em projetos sem acesso · ${formatCurrency(cents / 100)}`;
}

/**
 * Aviso do detalhe do rateio, ou `null` quando não há o que avisar.
 *
 * A cópia da sobra é deliberadamente neutra: com o contrato novo, um viewer
 * restrito passa a ver `sobraCents !== 0` LEGITIMAMENTE (a parte alocada fora
 * da lente dele simplesmente não aparece). "A soma não fecha" leria como
 * defeito de dado para quem não fez nada errado.
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
  return 'Parte desta compra não está alocada nas planejadas que você vê.';
}
