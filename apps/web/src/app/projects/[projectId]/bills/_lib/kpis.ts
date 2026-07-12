import { isBillDueSoon, isBillOverdue } from '@/lib/recurring-bill-status';

export interface BillsKpis {
  totalMensalCents: number;
  dueSoonCount: number;
  overdueCount: number;
}

interface BillLike {
  valor: number;
  frequencia: string;
  diaVencimento: number;
  status: string;
}

const FREQUENCY_MULTIPLIER: Record<string, number> = {
  MENSAL: 1,
  BIMESTRAL: 0.5,
  TRIMESTRAL: 1 / 3,
  SEMESTRAL: 1 / 6,
  ANUAL: 1 / 12,
};

/** Janela (em dias) considerada "vence em breve" nos KPIs de contas. */
const DUE_SOON_WINDOW_DAYS = 7;

/**
 * KPIs de topo de `bills/` (recurringBills). Só contas ATIVO entram nas
 * três métricas — uma conta PAUSADO não deve inflar nem "vence em breve" nem
 * "atrasada".
 */
export function computeBillsKpis(bills: BillLike[], today: Date): BillsKpis {
  let totalMensalCents = 0;
  let dueSoonCount = 0;
  let overdueCount = 0;

  for (const bill of bills) {
    if (bill.status !== 'ATIVO') continue;
    const multiplier = FREQUENCY_MULTIPLIER[bill.frequencia] ?? 1;
    totalMensalCents += Math.round(bill.valor * multiplier);
    if (isBillOverdue(bill.diaVencimento, today)) {
      overdueCount += 1;
    } else if (isBillDueSoon(bill.diaVencimento, today, DUE_SOON_WINDOW_DAYS)) {
      dueSoonCount += 1;
    }
  }

  return { totalMensalCents, dueSoonCount, overdueCount };
}
