'use client';

import { KpiTile } from '@/components/KpiTile';
import { moneyGlance } from '@/lib/money';

export interface BillsKpiHeaderProps {
  totalMensalCents: number;
  dueSoonCount: number;
  overdueCount: number;
}

/** Topo de 3 KpiTiles de `bills/` — total mensal fixo, próximas a vencer, atrasadas. */
export function BillsKpiHeader({
  totalMensalCents,
  dueSoonCount,
  overdueCount,
}: BillsKpiHeaderProps) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div role="article" aria-label="Total mensal fixo" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone="neutral"
          label="Total mensal fixo"
          value={moneyGlance(totalMensalCents)}
          context="contas ativas"
        />
      </div>
      <div role="article" aria-label="Próximas a vencer" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone={dueSoonCount > 0 ? 'warning' : 'neutral'}
          label="Próximas a vencer"
          value={String(dueSoonCount)}
          context="nos próximos 7 dias"
        />
      </div>
      <div role="article" aria-label="Atrasadas" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone={overdueCount > 0 ? 'negative' : 'neutral'}
          label="Atrasadas"
          value={String(overdueCount)}
          context="vencidas"
        />
      </div>
    </div>
  );
}
