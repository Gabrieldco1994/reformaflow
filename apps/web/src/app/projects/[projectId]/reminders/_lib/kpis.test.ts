import { describe, expect, it } from 'vitest';
import { computeReminderKpis } from './kpis';

const reminders = [
  { id: '1', titulo: 'Trocar filtro', data: '2026-08-01', status: 'PENDENTE', prioridade: 'ALTA' },
  { id: '2', titulo: 'Revisão', data: '2026-06-01', status: 'PENDENTE', prioridade: 'MEDIA' }, // já vencido
  { id: '3', titulo: 'Concluído', data: '2026-07-01', status: 'CONCLUIDO', prioridade: 'BAIXA' },
];

describe('computeReminderKpis', () => {
  it('picks the soonest PENDENTE reminder regardless of array order', () => {
    const k = computeReminderKpis(reminders as any, new Date(2026, 6, 10));
    expect(k.nextReminder?.id).toBe('1');
  });
  it('overdueCount counts PENDENTE with data before today; nextReminder can itself be overdue if it is the only pending', () => {
    const k = computeReminderKpis(reminders as any, new Date(2026, 6, 10));
    expect(k.overdueCount).toBe(1); // item '2'
    expect(k.pendingCount).toBe(2); // '1' e '2', CONCLUIDO não conta
  });
  it('empty/no-pending set returns nextReminder null without throwing', () => {
    expect(computeReminderKpis([], new Date())).toEqual({
      nextReminder: null,
      pendingCount: 0,
      overdueCount: 0,
    });
  });
});
