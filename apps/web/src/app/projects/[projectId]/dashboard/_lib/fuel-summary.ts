/**
 * Resumo de gasto com combustível do CARRO: soma do mês atual + média mensal
 * histórica. Puro — recebe despesas já filtradas por tipoDespesa (ex.:
 * GASOLINA, label "Combustível") e a data de referência.
 */
export interface FuelExpenseLike {
  valorTotal: number;
  dataPagamento?: string | null;
  dataCompra?: string | null;
  createdAt?: string | null;
}

export interface FuelSummary {
  currentMonthCents: number;
  averageMonthlyCents: number;
  monthsConsidered: number;
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function effectiveDate(e: FuelExpenseLike): string | null {
  return e.dataCompra || e.dataPagamento || e.createdAt || null;
}

export function computeFuelSummary(
  expenses: FuelExpenseLike[],
  today: Date,
): FuelSummary {
  const currentKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const byMonth = new Map<string, number>();

  for (const expense of expenses) {
    const date = effectiveDate(expense);
    if (!date) continue;
    const key = monthKey(date);
    byMonth.set(key, (byMonth.get(key) ?? 0) + expense.valorTotal);
  }

  const monthsConsidered = byMonth.size;
  const totalCents = Array.from(byMonth.values()).reduce((sum, v) => sum + v, 0);
  const averageMonthlyCents = monthsConsidered > 0 ? Math.round(totalCents / monthsConsidered) : 0;

  return {
    currentMonthCents: byMonth.get(currentKey) ?? 0,
    averageMonthlyCents,
    monthsConsidered,
  };
}
