import { parseISODateLocal } from '@/lib/utils';

export interface MaintenanceKpis {
  pendingCount: number;
  doneThisYearCount: number;
  accumulatedCostCents: number;
}

interface MaintenanceLogLike {
  dataRealizada: string;
  dataProxima?: string | null;
  custo?: number;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * KPIs de topo de `maintenance/` — pendentes (próxima manutenção agendada
 * hoje ou no futuro), feitas no ano corrente e custo acumulado no ano.
 */
export function computeMaintenanceKpis(
  logs: MaintenanceLogLike[],
  today: Date,
): MaintenanceKpis {
  const currentYear = today.getFullYear();
  const todayStart = startOfDay(today);

  let pendingCount = 0;
  let doneThisYearCount = 0;
  let accumulatedCostCents = 0;

  for (const log of logs) {
    if (log.dataProxima) {
      const nextDate = parseISODateLocal(log.dataProxima);
      if (nextDate && startOfDay(nextDate).getTime() >= todayStart.getTime()) {
        pendingCount += 1;
      }
    }
    const doneDate = parseISODateLocal(log.dataRealizada);
    if (doneDate && doneDate.getFullYear() === currentYear) {
      doneThisYearCount += 1;
      accumulatedCostCents += log.custo ?? 0;
    }
  }

  return { pendingCount, doneThisYearCount, accumulatedCostCents };
}
