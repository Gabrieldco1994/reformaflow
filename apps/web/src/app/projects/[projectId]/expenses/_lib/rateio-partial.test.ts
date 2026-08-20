import { describe, expect, it } from 'vitest';
import { isRateioEditLocked, knownCents, rateioWarningMessage } from './rateio-partial';

/**
 * W1 (#448) — contrato SOURCE-ONLY do rateio parcial.
 *
 * `GET :id/rateio` é source-only estrito: participante fora da lente ⇒ a
 * resposta é a de uma compra nunca rateada (`rateado: false`, `items: []`,
 * `removedTargetsCount: 0`, `rateadoCents: 0`, `sobraCents: totalSourceCents`).
 * Quando vem lista, ela é completa. `hiddenTargetsCount`/`hiddenAllocationCents`
 * não existem no contrato.
 *
 * Consequência que este módulo existe para fixar: o web não consegue — e não
 * deve tentar — inferir parcialidade. Uma regra fail-closed ("na dúvida,
 * trava") travaria o caso normal, porque toda compra ainda não rateada chega
 * como `rateado: false`. Quem barra a escrita insegura é o servidor:
 * `ratearMixed` → `assertCanReverseSources` enumera TODA `RateioAllocation` da
 * fonte e responde 404 com ZERO writes.
 */

/** Rateio completamente visível. */
const VISIVEL = { removedTargetsCount: 0 };

/** API pré-#448: ainda manda a metadata que o contrato atual não declara. */
const PRE_448 = {
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

  it('NÃO trava quando o servidor não declara nada — fail-closed aqui mataria a CTA para sempre', () => {
    expect(isRateioEditLocked({})).toBe(false);
  });

  it('IGNORA `hiddenTargetsCount` de uma API pré-#448 — campo fora do contrato não trava nada', () => {
    // O lock tem uma fonte de verdade só. Ler um campo que o contrato não
    // declara daria a ele um segundo gatilho, que nunca dispararia contra o
    // servidor atual e que ninguém conseguiria reproduzir.
    expect(isRateioEditLocked(PRE_448)).toBe(false);
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
    expect(rateioWarningMessage(VISIVEL, undefined)).toBeNull();
    expect(rateioWarningMessage(VISIVEL, null)).toBeNull();
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
