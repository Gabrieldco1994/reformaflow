import { parseISODateLocal } from '@/lib/utils';

export interface ReminderLike {
  id: string;
  data: string;
  status: string;
}

export interface ReminderKpis<T extends ReminderLike = ReminderLike> {
  nextReminder: T | null;
  pendingCount: number;
  overdueCount: number;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * KPIs de topo de `reminders/` — próximo lembrete PENDENTE em destaque
 * (o mais próximo no futuro; se todos os pendentes já venceram, o menos
 * atrasado) + contagens de pendentes/atrasados.
 */
export function computeReminderKpis<T extends ReminderLike>(
  reminders: T[],
  today: Date,
): ReminderKpis<T> {
  const todayStart = startOfDay(today);
  const pending = reminders.filter((r) => r.status === 'PENDENTE');

  const overdue: T[] = [];
  const upcoming: T[] = [];
  for (const r of pending) {
    const date = parseISODateLocal(r.data);
    if (date && startOfDay(date).getTime() < todayStart.getTime()) {
      overdue.push(r);
    } else {
      upcoming.push(r);
    }
  }

  function minByDate(list: T[]): T | null {
    return list.reduce<T | null>((min, r) => {
      if (!min) return r;
      const rDate = parseISODateLocal(r.data)?.getTime() ?? 0;
      const minDate = parseISODateLocal(min.data)?.getTime() ?? 0;
      return rDate < minDate ? r : min;
    }, null);
  }

  function maxByDate(list: T[]): T | null {
    return list.reduce<T | null>((max, r) => {
      if (!max) return r;
      const rDate = parseISODateLocal(r.data)?.getTime() ?? 0;
      const maxDate = parseISODateLocal(max.data)?.getTime() ?? 0;
      return rDate > maxDate ? r : max;
    }, null);
  }

  const nextReminder = upcoming.length > 0 ? minByDate(upcoming) : maxByDate(overdue);

  return {
    nextReminder,
    pendingCount: pending.length,
    overdueCount: overdue.length,
  };
}
