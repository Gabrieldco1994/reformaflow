import { describe, expect, it } from 'vitest';
import { getProjectNavModules, ProjectType } from '@reformaflow/domain';
import { getProjectHomePath } from './project-home-route';

/**
 * U2 §8 E-5 / D11 — home do projeto respeita permissão.
 *
 * `getProjectHomePath` era cego a permissão: usava `[0].slug` (para PESSOAL,
 * `monthly`) sem filtrar, então o usuário reduzido caía em `/no-permission` ao
 * abrir o próprio projeto. Contrato novo: predicado OPCIONAL; sem ele, byte
 * idêntico a hoje (barrier test — a tabela é DADO literal, não derivada de
 * PROJECT_NAV).
 */
describe('getProjectHomePath — home respeita permissão (E-5)', () => {
  const base = '/projects/p1';

  // Tabela LITERAL — cicatriz "a barrier test must not derive its expectation
  // from the constant it protects".
  const HOME_WITHOUT_PREDICATE: Record<string, string> = {
    REFORMA: `${base}/dashboard`,
    COMPRA: `${base}/dashboard`,
    PESSOAL: `${base}/monthly`,
    CASA: `${base}/dashboard`,
    CARRO: `${base}/dashboard`,
    PLANTAS: `${base}/dashboard`,
  };

  it('[TRAVA] U2-D16: sem predicado, os 6 tipos devolvem o de hoje', () => {
    for (const [type, expected] of Object.entries(HOME_WITHOUT_PREDICATE)) {
      expect(getProjectHomePath('p1', type)).toBe(expected);
    }
  });

  it('[TRAVA] U2-D17: tipo desconhecido → /dashboard, com e sem predicado', () => {
    expect(getProjectHomePath('p1', 'NAO_EXISTE')).toBe(`${base}/dashboard`);
    expect(getProjectHomePath('p1', 'NAO_EXISTE', () => true)).toBe(`${base}/dashboard`);
    expect(getProjectHomePath('p1', 'NAO_EXISTE', () => false)).toBe(`${base}/dashboard`);
  });

  it('[TRAVA] U2-D18: acesso pleno → [0], E-5 não reordena', () => {
    // Predicado que aceita tudo tem de cair no MESMO destino de hoje.
    expect(getProjectHomePath('p1', 'PESSOAL', () => true)).toBe(`${base}/monthly`);
    expect(getProjectHomePath('p1', 'REFORMA', () => true)).toBe(`${base}/dashboard`);
  });

  /**
   * FIXTURE, NÃO EXPECTATIVA. Estes dois casos provam "a home PULA os módulos
   * invisíveis e escolhe o PRIMEIRO visível na ordem canônica". A propriedade
   * não mudou; o que envelheceu foi a fixture — o U4 (#453) tirou `expenses`,
   * `receipts`, `credit-cards` e `bank-accounts` de PROJECT_NAV[PESSOAL], e um
   * predicado que casa com módulo inexistente não pula nada: ele cai no
   * fallback [0] e passaria a medir o U2-D15, não o U2-D14.
   *
   * Os substitutos foram escolhidos para manter a força de cada caso:
   *   • `cashFlow`   → casa com UM item, o ÚLTIMO do array. Só passa se a
   *                    varredura de fato atravessar os 8 anteriores.
   *   • `expenses`   → casa com DOIS itens (`recorrentes`, `metas`). Só passa
   *                    se escolher o PRIMEIRO — um `findLast` fica vermelho.
   */
  it('[TRAVA] fixture viva: os módulos dos casos D14 ainda existem no nav PESSOAL', () => {
    // Sem esta trava, remover `cash-flow`/`recorrentes` do nav degrada os dois
    // casos abaixo em silêncio: eles caem no fallback [0] e continuam VERDES
    // medindo outra coisa. Aqui a falha diz "fixture morta", não "propriedade
    // quebrada" — que é a distinção que custou este PR.
    const pessoalModules = getProjectNavModules(ProjectType.PESSOAL).map(
      (item) => item.module,
    );
    expect(pessoalModules).toContain('cashFlow');
    expect(pessoalModules.filter((m) => m === 'expenses').length).toBeGreaterThan(1);
  });

  it('[RED] U2-D14: predicado presente pula os invisíveis', () => {
    // PESSOAL, usuário só com cashFlow: o primeiro item VISÍVEL é `cash-flow`
    // (último de PROJECT_NAV), não `monthly`.
    const home = getProjectHomePath('p1', 'PESSOAL', (module) => module === 'cashFlow');
    expect(home).toBe(`${base}/cash-flow`);
    // E não o [0] — senão "pulou" e "caiu no fallback" dariam o mesmo verde.
    expect(home).not.toBe(`${base}/monthly`);
  });

  it('[RED] U2-D14: predicado presente escolhe o primeiro visível na ordem canônica', () => {
    // Só `expenses`: primeiro item cujo module==='expenses' é `recorrentes`
    // (antes de `metas`, que também é module 'expenses').
    const home = getProjectHomePath('p1', 'PESSOAL', (module) => module === 'expenses');
    expect(home).toBe(`${base}/recorrentes`);
    // Ordem canônica, não "qualquer um que casa": `metas` casa igual e perde.
    expect(home).not.toBe(`${base}/metas`);
  });

  it('[RED] U2-D15: predicado que rejeita tudo → [0] (fallback), não dashboard nem vazio', () => {
    const home = getProjectHomePath('p1', 'PESSOAL', () => false);
    // Fallback obrigatório em [0]; NÃO inventa destino. O guard do AppShell é
    // quem decide o /no-permission — não este helper.
    expect(home).toBe(`${base}/monthly`);
    expect(home).not.toBe(`${base}/dashboard`);
    expect(home).not.toBe(`${base}/`);
  });
});
