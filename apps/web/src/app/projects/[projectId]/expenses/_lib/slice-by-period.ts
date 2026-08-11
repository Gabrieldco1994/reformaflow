import type { Expense } from '@/types';
import {
  expandExpenseOccurrences,
  type Occurrence,
} from './grouping-by-month';
import { inPeriod, type PeriodFilter } from './personal-hierarchy';

export type SlicedExpense = Expense & Partial<Occurrence>;

function occurrenceSlice(occurrence: Occurrence): SlicedExpense {
  return {
    ...occurrence,
    valor: occurrence.occValue,
    quantidade: 1,
    valorTotal: occurrence.occValue,
    dataPagamento: occurrence.occDate,
    status: occurrence.status,
  };
}

/**
 * Fatia a base consolidada do PESSOAL sem descartar a identidade sintética da
 * ocorrência. `occIndex` continua 1-based na view; a conversão acontece apenas
 * na mutation HTTP.
 */
export function sliceExpensesByPeriod(
  base: Expense[],
  period: PeriodFilter,
  periodYear: number,
  rangeStart: string,
  rangeEnd: string,
): SlicedExpense[] {
  if (rangeStart && rangeEnd) {
    const out: SlicedExpense[] = [];
    const startDate = new Date(`${rangeStart}-01T00:00:00.000Z`);
    const [endYear, endMonth] = rangeEnd.split('-').map(Number);
    const endDate = new Date(Date.UTC(endYear, endMonth, 0));

    for (const expense of base) {
      const occurrences = expandExpenseOccurrences(expense, 'competencia');
      for (const occurrence of occurrences) {
        if (!occurrence.occDate) continue;
        const date = new Date(`${occurrence.occDate}T00:00:00.000Z`);
        if (date < startDate || date > endDate) continue;
        out.push(
          occurrence.occKey === expense.id
            ? expense
            : occurrenceSlice(occurrence),
        );
      }
    }
    return out;
  }

  if (period === 'ALL') {
    return base.filter((expense) =>
      inPeriod(expense, period, periodYear, 'competencia'),
    );
  }

  const out: SlicedExpense[] = [];
  for (const expense of base) {
    for (const occurrence of expandExpenseOccurrences(
      expense,
      'competencia',
    )) {
      if (
        !occurrence.occDate ||
        occurrence.occDate.slice(0, 7) !== period
      ) {
        continue;
      }
      out.push(
        occurrence.occKey === expense.id
          ? expense
          : occurrenceSlice(occurrence),
      );
    }
  }
  return out;
}
