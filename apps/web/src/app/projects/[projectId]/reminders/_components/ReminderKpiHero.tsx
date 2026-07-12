'use client';

import { KpiTile } from '@/components/KpiTile';
import { formatDateBR } from '@/lib/utils';
import type { ReminderRow } from './ReminderCard';

export interface ReminderKpiHeroProps {
  nextReminder: ReminderRow | null;
  pendingCount: number;
  overdueCount: number;
}

/** Topo de `reminders/` — próximo lembrete em destaque (hero) + contagem (support). */
export function ReminderKpiHero({ nextReminder, pendingCount, overdueCount }: ReminderKpiHeroProps) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div role="article" aria-label="Próximo lembrete" className="min-w-0 sm:col-span-2">
        <KpiTile
          variant="hero"
          layer="glance"
          tone={overdueCount > 0 && nextReminder ? 'warning' : 'neutral'}
          label="Próximo lembrete"
          value={nextReminder ? nextReminder.titulo : 'Nenhum lembrete pendente'}
          context={nextReminder ? formatDateBR(nextReminder.data) : undefined}
        />
      </div>
      <div role="article" aria-label="Pendentes" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone={overdueCount > 0 ? 'negative' : 'neutral'}
          label="Pendentes"
          value={String(pendingCount)}
          context={overdueCount > 0 ? `${overdueCount} atrasado(s)` : 'em dia'}
        />
      </div>
    </div>
  );
}
