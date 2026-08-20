import { describe, expect, it } from 'vitest';
import { canReadBudgetAllocations, canSeeBudgetAllocationEntryPoint } from './budget-allocation-access';

/**
 * Espelho do gate da API. Se estes casos divergirem de
 * `apps/api/src/budget-allocation/budget-allocation-admin.guard.ts`, a tela
 * volta a disparar requisição condenada a 403 (silenciosa: sem retry, sem
 * toast) ou esconde dado de quem tem direito a ele.
 */
describe('canReadBudgetAllocations (#449 B2)', () => {
  it('libera ADMIN não-convidado', () => {
    expect(canReadBudgetAllocations({ role: 'ADMIN', isGuest: false })).toBe(true);
  });

  it('libera OWNER: o dono do tenant lê o próprio histórico', () => {
    expect(canReadBudgetAllocations({ role: 'OWNER', isGuest: false })).toBe(true);
  });

  it('bloqueia USER (Budget é administrativo)', () => {
    expect(canReadBudgetAllocations({ role: 'USER', isGuest: false })).toBe(false);
  });

  it('bloqueia convidado de demo mesmo com role ADMIN (#497)', () => {
    expect(canReadBudgetAllocations({ role: 'ADMIN', isGuest: true })).toBe(false);
  });

  it('bloqueia convidado mesmo com role OWNER (#497)', () => {
    expect(canReadBudgetAllocations({ role: 'OWNER', isGuest: true })).toBe(false);
  });

  it('bloqueia sessão ausente ou ainda carregando (fail-closed)', () => {
    expect(canReadBudgetAllocations(null)).toBe(false);
    expect(canReadBudgetAllocations(undefined)).toBe(false);
  });

  it('trata isGuest ausente como não-convidado (payload legado de /auth/me)', () => {
    expect(canReadBudgetAllocations({ role: 'ADMIN' })).toBe(true);
  });
});

/**
 * #504 — o congelamento do #449/#500 removeu TODA a descoberta da tela: um QA
 * de runtime varreu 11 páginas, a sidebar desktop e o menu mobile e achou
 * `PAGES WITH BUDGET ENTRY POINT: []`. O histórico só existia por URL digitada
 * à mão, e o administrador do único tenant com alocações vivas (R$ 235.000,00)
 * não conseguia abrir o próprio histórico.
 *
 * Este gate decide a DESCOBERTA (o item de menu), não o acesso — o servidor
 * continua sendo a autoridade. Ele é deliberadamente MAIS ESTREITO que
 * `canReadBudgetAllocations`: além do papel, exige PESSOAL, porque a página
 * responde "só está disponível para projetos do tipo PESSOAL" em qualquer
 * outro tipo. Oferecer um menu que leva a uma tela de bloqueio é o mesmo
 * defeito que o #449 existia para matar.
 */
describe('canSeeBudgetAllocationEntryPoint (#504)', () => {
  it('mostra para ADMIN não-convidado em projeto PESSOAL', () => {
    expect(canSeeBudgetAllocationEntryPoint({ role: 'ADMIN', isGuest: false }, 'PESSOAL')).toBe(true);
  });

  it('mostra para OWNER não-convidado em projeto PESSOAL', () => {
    expect(canSeeBudgetAllocationEntryPoint({ role: 'OWNER', isGuest: false }, 'PESSOAL')).toBe(true);
  });

  it('esconde de USER: veria um item que só entrega 403', () => {
    expect(canSeeBudgetAllocationEntryPoint({ role: 'USER', isGuest: false }, 'PESSOAL')).toBe(false);
  });

  it('esconde do convidado de demo que nasce role ADMIN (#497)', () => {
    expect(canSeeBudgetAllocationEntryPoint({ role: 'ADMIN', isGuest: true }, 'PESSOAL')).toBe(false);
  });

  it('esconde de sessão ausente/carregando (fail-closed)', () => {
    expect(canSeeBudgetAllocationEntryPoint(null, 'PESSOAL')).toBe(false);
    expect(canSeeBudgetAllocationEntryPoint(undefined, 'PESSOAL')).toBe(false);
  });

  it('esconde em TODO tipo de projeto que não é PESSOAL, mesmo para ADMIN', () => {
    for (const type of ['REFORMA', 'COMPRA', 'CASA', 'CARRO', 'PLANTAS']) {
      expect(canSeeBudgetAllocationEntryPoint({ role: 'ADMIN', isGuest: false }, type)).toBe(false);
    }
  });

  it('esconde quando o tipo do projeto ainda não carregou (fail-closed)', () => {
    expect(canSeeBudgetAllocationEntryPoint({ role: 'ADMIN', isGuest: false }, undefined)).toBe(false);
  });

  it('nunca é mais permissivo que o gate de leitura da própria página', () => {
    const users = [
      { role: 'ADMIN', isGuest: false },
      { role: 'OWNER', isGuest: false },
      { role: 'USER', isGuest: false },
      { role: 'ADMIN', isGuest: true },
      null,
    ];
    for (const user of users) {
      if (canSeeBudgetAllocationEntryPoint(user, 'PESSOAL')) {
        expect(canReadBudgetAllocations(user)).toBe(true);
      }
    }
  });
});
