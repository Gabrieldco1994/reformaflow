import { describe, expect, it } from 'vitest';
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

  it('[RED] U2-D14: predicado presente pula os invisíveis', () => {
    // PESSOAL, usuário só com bankAccounts: o primeiro item VISÍVEL é
    // `bank-accounts` (último de PROJECT_NAV), não `monthly`.
    const home = getProjectHomePath('p1', 'PESSOAL', (module) => module === 'bankAccounts');
    expect(home).toBe(`${base}/bank-accounts`);
  });

  it('[RED] U2-D14: predicado presente escolhe o primeiro visível na ordem canônica', () => {
    // Só `expenses`: primeiro item cujo module==='expenses' é `expenses`
    // (antes de recorrentes/metas, que também são module 'expenses').
    const home = getProjectHomePath('p1', 'PESSOAL', (module) => module === 'expenses');
    expect(home).toBe(`${base}/expenses`);
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
