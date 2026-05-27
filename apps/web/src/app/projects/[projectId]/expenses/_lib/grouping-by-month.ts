import type { Expense } from '@/types';

const MESES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export interface GrupoDespesaPorMes {
  mesKey: string;
  mesLabel: string;
  items: Expense[];
  total: number;
  totalPago: number;
  totalPlanejado: number;
  isCurrentMonth: boolean;
  isFuture: boolean;
}

export function effectiveDate(e: Expense): string | null {
  return (
    e.dataPagamento ||
    e.dataInicioParcela ||
    (e as { createdAt?: string }).createdAt ||
    null
  );
}

export function mesKeyFromDate(data: string): string {
  return data.slice(0, 7);
}

export function mesLabelFromKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return `${MESES_PT[m - 1]} ${y}`;
}

export function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function groupExpensesByMes(expenses: Expense[]): GrupoDespesaPorMes[] {
  const currentKey = currentMonthKey();
  const byMes = new Map<string, Expense[]>();
  const semData: Expense[] = [];

  for (const e of expenses) {
    const d = effectiveDate(e);
    if (!d) {
      semData.push(e);
      continue;
    }
    const key = mesKeyFromDate(d);
    const arr = byMes.get(key);
    if (arr) arr.push(e);
    else byMes.set(key, [e]);
  }

  const sorted = Array.from(byMes.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );

  const grouped = sorted.map(([key, items]) => {
    const sortedItems = items.slice().sort((a, b) => {
      const da = effectiveDate(a) || '';
      const db = effectiveDate(b) || '';
      return da > db ? 1 : -1;
    });
    const totalPago = sortedItems
      .filter((e) => e.status === 'PAGO')
      .reduce((s, e) => s + e.valorTotal, 0);
    const totalPlanejado = sortedItems
      .filter((e) => e.status === 'PLANEJADO')
      .reduce((s, e) => s + e.valorTotal, 0);
    return {
      mesKey: key,
      mesLabel: mesLabelFromKey(key),
      items: sortedItems,
      total: totalPago + totalPlanejado,
      totalPago,
      totalPlanejado,
      isCurrentMonth: key === currentKey,
      isFuture: key > currentKey,
    };
  });

  if (semData.length > 0) {
    const totalPago = semData
      .filter((e) => e.status === 'PAGO')
      .reduce((s, e) => s + e.valorTotal, 0);
    const totalPlanejado = semData
      .filter((e) => e.status === 'PLANEJADO')
      .reduce((s, e) => s + e.valorTotal, 0);
    grouped.push({
      mesKey: 'sem-data',
      mesLabel: 'Sem data',
      items: semData,
      total: totalPago + totalPlanejado,
      totalPago,
      totalPlanejado,
      isCurrentMonth: false,
      isFuture: false,
    });
  }

  return grouped;
}
