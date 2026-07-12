import { mesKeyFromDate } from './grouping';

export interface ReceiptsKpis {
  monthReceivedCents: number;
  monthForecastCents: number;
  ytdCents: number;
}

interface ReceiptLike {
  valor: number;
  data: string;
  status: string;
}

function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * KPIs de topo de `receipts/` — recebido no mês, previsto no mês e
 * acumulado do ano (YTD, só recebimentos já confirmados em caixa).
 */
export function computeReceiptsKpis(
  receipts: ReceiptLike[],
  today: Date,
): ReceiptsKpis {
  const curMonthKey = monthKeyOf(today);
  const curYear = String(today.getFullYear());

  let monthReceivedCents = 0;
  let monthForecastCents = 0;
  let ytdCents = 0;

  for (const r of receipts) {
    const monthKey = mesKeyFromDate(r.data);
    if (monthKey === curMonthKey) {
      if (r.status === 'EM_CAIXA') monthReceivedCents += r.valor;
      else monthForecastCents += r.valor;
    }
    if (r.status === 'EM_CAIXA' && monthKey.slice(0, 4) === curYear) {
      ytdCents += r.valor;
    }
  }

  return { monthReceivedCents, monthForecastCents, ytdCents };
}
