import { describe, expect, it } from 'vitest';
import { canReadBudgetAllocations } from './budget-allocation-access';

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
