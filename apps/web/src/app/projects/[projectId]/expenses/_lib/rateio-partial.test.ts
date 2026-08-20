import { describe, expect, it } from 'vitest';
import {
  hiddenAllocationsNotice,
  isRateioEditLocked,
  knownCents,
  rateioWarningMessage,
} from './rateio-partial';

/**
 * W1 (#448) — contrato mixed-version do rateio PARCIAL.
 *
 * Os dois deploys não são atômicos, então o web precisa ser seguro com as DUAS
 * formas do payload de `GET :id/rateio`:
 *
 *  - **API antiga (pré-B1b):** ainda manda `hiddenTargetsCount` /
 *    `hiddenAllocationCents` / `removedTargetsCount`. Comportamento tem que
 *    ficar IDÊNTICO ao de hoje (nenhuma regressão no bundle novo).
 *  - **API nova (B1b):** esses campos são REMOVIDOS do contrato — o payload
 *    redigido é deep-equal a um payload sem nada oculto, POR DESIGN. O web
 *    então não consegue (e não deve tentar) inferir parcialidade.
 */

const FULL = {
  hiddenTargetsCount: 0,
  hiddenAllocationCents: 0,
  removedTargetsCount: 0,
};

/** Exatamente o que a API nova manda: sem chave nenhuma de metadata oculta. */
const REDACTED = {};

describe('isRateioEditLocked', () => {
  it('trava quando a API ANTIGA declara alocações ocultas', () => {
    expect(isRateioEditLocked({ ...FULL, hiddenTargetsCount: 1, hiddenAllocationCents: 5000 })).toBe(
      true,
    );
  });

  it('trava quando a API ANTIGA declara alvos removidos', () => {
    expect(isRateioEditLocked({ ...FULL, removedTargetsCount: 2 })).toBe(true);
  });

  it('não trava quando a API ANTIGA declara tudo visível', () => {
    expect(isRateioEditLocked(FULL)).toBe(false);
  });

  it('NÃO trava com o payload redigido da API nova — fail-closed aqui mataria a CTA', () => {
    // O payload redigido é indistinguível de um rateio 100% visível por design
    // (B1b: "comparação deep-equal do payload redigido é idêntica a uma
    // resposta vazia/sem metadata"). Travar no ausente deixaria "Ratear compra"
    // permanentemente morta para TODO mundo. Quem barra a escrita insegura é o
    // servidor: `ratearMixed` → `assertCanReverseSources` enumera TODA
    // `RateioAllocation` existente da fonte e responde 404 com ZERO writes
    // quando algum alvo está fora da lente.
    expect(isRateioEditLocked(REDACTED)).toBe(false);
  });

  it('não trava sem detalhe nenhum (ainda carregando)', () => {
    expect(isRateioEditLocked(undefined)).toBe(false);
  });
});

describe('knownCents — nunca renderiza NaN', () => {
  it('devolve o número quando ele existe', () => {
    expect(knownCents(0)).toBe(0);
    expect(knownCents(-500)).toBe(-500);
  });

  it('devolve null para ausente/nulo/NaN em vez de propagar NaN pra tela', () => {
    expect(knownCents(undefined)).toBeNull();
    expect(knownCents(null)).toBeNull();
    expect(knownCents(Number.NaN)).toBeNull();
  });
});

describe('hiddenAllocationsNotice — nunca revela metadata que o servidor não mandou', () => {
  it('descreve os ocultos quando a API ANTIGA os declara', () => {
    expect(
      hiddenAllocationsNotice({ ...FULL, hiddenTargetsCount: 1, hiddenAllocationCents: 5000 }),
    ).toMatch(/1 aloca/i);
    expect(
      hiddenAllocationsNotice({ ...FULL, hiddenTargetsCount: 3, hiddenAllocationCents: 5000 }),
    ).toMatch(/3 aloca/i);
  });

  it('devolve null no payload redigido — nada de "0 alocações" nem R$ NaN', () => {
    expect(hiddenAllocationsNotice(REDACTED)).toBeNull();
    expect(hiddenAllocationsNotice(undefined)).toBeNull();
  });

  it('devolve null quando a contagem existe mas a soma não — nunca inventa valor', () => {
    expect(hiddenAllocationsNotice({ hiddenTargetsCount: 2 })).toBeNull();
  });

  it('devolve null quando não há nada oculto', () => {
    expect(hiddenAllocationsNotice(FULL)).toBeNull();
  });
});

describe('rateioWarningMessage', () => {
  it('prioriza alvos removidos (API antiga), com plural correto', () => {
    expect(rateioWarningMessage({ ...FULL, removedTargetsCount: 1 }, 0)).toMatch(
      /1 planejada removida/,
    );
    expect(rateioWarningMessage({ ...FULL, removedTargetsCount: 2 }, 0)).toMatch(
      /2 planejadas removidas/,
    );
  });

  it('avisa sobre a sobra sem acusar o usuário de erro', () => {
    const message = rateioWarningMessage(FULL, 30_029);
    // Um viewer restrito passa a ver sobra != 0 LEGITIMAMENTE quando parte das
    // alocações está fora da lente dele — a cópia não pode soar como defeito.
    expect(message).toMatch(/você vê/i);
    expect(message).not.toMatch(/não fecha/i);
  });

  it('silencia quando a sobra é zero e nada foi removido', () => {
    expect(rateioWarningMessage(FULL, 0)).toBeNull();
  });

  it('silencia quando a sobra é desconhecida — nunca alarme fabricado', () => {
    expect(rateioWarningMessage(REDACTED, undefined)).toBeNull();
    expect(rateioWarningMessage(REDACTED, null)).toBeNull();
  });
});
