import { describe, expect, it } from 'vitest';
import { localDateUtc, todayLocalDateUtc } from '../src';

describe('localDateUtc', () => {
  it('normaliza instante para dia-calendário BRT em meia-noite UTC', () => {
    const instant = new Date('2026-06-10T02:59:00.000Z'); // 23:59 09/06 no BRT
    expect(localDateUtc(instant, 'America/Sao_Paulo').toISOString()).toBe('2026-06-09T00:00:00.000Z');
  });

  it('todayLocalDateUtc usa o mesmo cálculo para o "agora" informado', () => {
    const now = new Date('2026-07-01T01:30:00.000Z'); // 30/06 22:30 no BRT
    expect(todayLocalDateUtc('America/Sao_Paulo', now).toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });
});
