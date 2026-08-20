import { describe, expect, it } from 'vitest';
import { isRateioEditLocked, knownCents, rateioWarningMessage } from './rateio-partial';

/**
 * W1 (#448) — contrato SOURCE-ONLY do rateio parcial, já sob o servidor B1b.
 *
 * B1b entregou o contrato final de `GET :id/rateio`:
 *  - `hiddenTargetsCount` / `hiddenAllocationCents` NÃO EXISTEM MAIS. Participante
 *    fora da lente é omitido por inteiro — não vira contagem, não vira soma.
 *  - `rateadoCents` é Σ dos itens VISÍVEIS (manter total-aware devolvia a soma
 *    oculta por subtração: `totalSourceCents - Σ items`).
 *  - `rateado: false` quando nenhum participante é visível.
 *  - `removedTargetsCount` continua existindo, FILTRADO pela lente.
 *
 * Consequência que este módulo existe para fixar: o web não consegue — e não
 * deve tentar — inferir parcialidade. O payload redigido é deep-equal a um
 * payload sem nada oculto POR DESIGN. Uma regra fail-closed ("na dúvida,
 * trava") mataria "Ratear compra" permanentemente para todo mundo. Quem barra a
 * escrita insegura é o servidor: `ratearMixed` → `assertCanReverseSources`
 * enumera TODA `RateioAllocation` da fonte e responde 404 com ZERO writes.
 */

/** Payload B1b de quem enxerga todos os participantes. */
const VISIVEL = { removedTargetsCount: 0 };

/** Payload B1b de quem NÃO enxerga parte deles: idêntico ao de cima. */
const REDIGIDO = { removedTargetsCount: 0 };

/** API pré-B1b: ainda manda a metadata que o contrato novo retirou. */
const PRE_B1B = {
  removedTargetsCount: 0,
  hiddenTargetsCount: 2,
  hiddenAllocationCents: 5_000,
} as Record<string, number>;

describe('isRateioEditLocked — trava só no que o contrato AINDA declara', () => {
  it('trava quando o servidor declara alvos removidos DENTRO da lente', () => {
    expect(isRateioEditLocked({ removedTargetsCount: 2 })).toBe(true);
  });

  it('não trava quando nada foi removido', () => {
    expect(isRateioEditLocked(VISIVEL)).toBe(false);
  });

  it('NÃO trava no payload redigido — fail-closed aqui mataria a CTA para sempre', () => {
    expect(isRateioEditLocked(REDIGIDO)).toBe(false);
  });

  it('IGNORA `hiddenTargetsCount` de uma API pré-B1b — campo morto não trava mais nada', () => {
    // B1b deletou o campo do contrato. Continuar lendo-o deixaria o lock com
    // duas fontes de verdade: uma viva (`removedTargetsCount`) e uma que só
    // aparece contra servidor velho. O lock passa a ser explícito e único.
    expect(isRateioEditLocked(PRE_B1B)).toBe(false);
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

describe('rateioWarningMessage — informa a sobra sem insinuar o que está oculto', () => {
  it('prioriza alvos removidos, com plural correto', () => {
    expect(rateioWarningMessage({ removedTargetsCount: 1 }, 0)).toMatch(/1 planejada removida/);
    expect(rateioWarningMessage({ removedTargetsCount: 2 }, 0)).toMatch(/2 planejadas removidas/);
  });

  it('descreve a sobra como fato, sem acusar erro do usuário', () => {
    // Sob o contrato source-only, um viewer restrito vê sobra != 0
    // LEGITIMAMENTE. "A soma não fecha" lê como defeito de dado para quem não
    // fez nada errado.
    const message = rateioWarningMessage(VISIVEL, 30_029);
    expect(message).not.toMatch(/não fecha/i);
    expect(message).toMatch(/sem aloca/i);
  });

  it('NÃO insinua que existe participante oculto — isso reabriria o vazamento pela copy', () => {
    // O texto não pode conter nenhuma pista de que há algo que o leitor não vê:
    // sob o contrato source-only, sobra oculta TEM que ser indistinguível de
    // dinheiro genuinamente não alocado, inclusive na frase.
    const message = rateioWarningMessage(VISIVEL, 30_029) ?? '';
    expect(message).not.toMatch(/você vê|voce ve|vis[íi]ve|oculta|escondid|sem acesso|permiss/i);
  });

  it('mostra o valor da sobra na frase', () => {
    expect(rateioWarningMessage(VISIVEL, 30_029)).toContain('300,29');
  });

  it('silencia quando a sobra é zero e nada foi removido', () => {
    expect(rateioWarningMessage(VISIVEL, 0)).toBeNull();
  });

  it('silencia quando a sobra é desconhecida — nunca alarme fabricado', () => {
    expect(rateioWarningMessage(REDIGIDO, undefined)).toBeNull();
    expect(rateioWarningMessage(REDIGIDO, null)).toBeNull();
  });
});

/**
 * Degradação sob SOURCE-ONLY estrito (#448, revisão do B1b em #499).
 *
 * Contrato corrigido: quando QUALQUER participante está fora da lente, a
 * resposta é byte a byte a de uma compra NUNCA rateada — lista filtrada +
 * número derivado do total vazava por subtração, porque o servidor só aceita a
 * escrita com `Σ alocações === valorTotal` (`conciliacao.service.ts:478`), logo
 * `total − Σ(visíveis)` É a soma dos ocultos, com igualdade exata.
 *
 * Para o web isso significa um payload como:
 *   { rateado: false, items: [], removedTargetsCount: 0,
 *     rateadoCents: 0, sobraCents: totalSourceCents }
 * Nada aqui pode virar aviso, âmbar ou lock: `sobra = total` não é sobra, é uma
 * compra que (para este leitor) simplesmente não foi rateada.
 */
const SOURCE_ONLY = { rateado: false, removedTargetsCount: 0 };

describe('degradação sob SOURCE-ONLY — "não rateada" não vira alarme', () => {
  it('não trava a edição: o leitor restrito abre um rateio novo, não um bloqueado', () => {
    expect(isRateioEditLocked(SOURCE_ONLY)).toBe(false);
  });

  it('NÃO avisa, mesmo com sobra == total — é compra não rateada, não sobra', () => {
    expect(rateioWarningMessage(SOURCE_ONLY, 20_000)).toBeNull();
  });

  it('`rateado` ausente (API antiga) preserva o comportamento anterior', () => {
    // Só `rateado === false` silencia. Contrato sem o campo continua avisando a
    // sobra como antes — degradar para "nunca avisa" esconderia sobra real.
    expect(rateioWarningMessage({ removedTargetsCount: 0 }, 20_000)).not.toBeNull();
  });

  it('alvo removido dentro da lente ainda avisa — esse caso é legítimo e sobrevive', () => {
    expect(rateioWarningMessage({ rateado: true, removedTargetsCount: 1 }, 20_000)).toContain(
      'removida',
    );
  });
});
