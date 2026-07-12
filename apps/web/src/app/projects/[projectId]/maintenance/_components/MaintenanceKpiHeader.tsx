'use client';

import { KpiTile } from '@/components/KpiTile';
import { moneyGlance } from '@/lib/money';

export interface MaintenanceKpiHeaderProps {
  pendingCount: number;
  doneThisYearCount: number;
  accumulatedCostCents: number;
}

/** Topo de 3 KpiTiles de `maintenance/` — pendentes, feitas no ano, custo acumulado. */
export function MaintenanceKpiHeader({
  pendingCount,
  doneThisYearCount,
  accumulatedCostCents,
}: MaintenanceKpiHeaderProps) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div role="article" aria-label="Pendentes" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone={pendingCount > 0 ? 'warning' : 'neutral'}
          label="Pendentes"
          value={String(pendingCount)}
          context="manutenções agendadas"
        />
      </div>
      <div role="article" aria-label="Feitas no ano" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone="neutral"
          label="Feitas no ano"
          value={String(doneThisYearCount)}
          context="realizadas"
        />
      </div>
      <div role="article" aria-label="Custo acumulado" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone="neutral"
          label="Custo acumulado"
          value={moneyGlance(accumulatedCostCents)}
          context="no ano"
        />
      </div>
    </div>
  );
}
