'use client';

import { AlertTriangle, TrendingUp } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

export interface BudgetAlert {
  tipo: string;
  label: string;
  gastoCents: number;
  limiteCents: number;
  pct: number;
  level: 'warning' | 'danger';
}

/**
 * Banner de alertas de orçamento (PESSOAL): mostra categorias que passaram
 * de 80% (atenção) ou estouraram a meta (≥100%). Só renderiza quando há
 * pelo menos um alerta. Mais severos primeiro.
 */
export function InsightsBanner({ alerts }: { alerts: BudgetAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="space-y-2">
      {alerts.map((a) => {
        const isDanger = a.level === 'danger';
        const cls = isDanger
          ? 'border-rose-200 bg-rose-50 text-rose-800'
          : 'border-amber-200 bg-amber-50 text-amber-800';
        const Icon = isDanger ? AlertTriangle : TrendingUp;
        return (
          <div
            key={a.tipo}
            className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-sm ${cls}`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{a.label}</span>{' '}
              {isDanger ? 'estourou a meta' : 'perto do limite'} —{' '}
              <span className="tabular-nums">
                {formatCurrency(a.gastoCents / 100)} de {formatCurrency(a.limiteCents / 100)}
              </span>{' '}
              ({a.pct}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}
