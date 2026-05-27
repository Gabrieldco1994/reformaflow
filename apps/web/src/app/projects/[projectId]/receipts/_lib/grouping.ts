import type { Receipt } from '@/types';
import type { GrupoPorMes } from '../_types';

const MESES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

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

export function groupByMes(receipts: Receipt[]): GrupoPorMes[] {
  const currentKey = currentMonthKey();
  const byMes = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const key = mesKeyFromDate(r.data);
    const arr = byMes.get(key);
    if (arr) arr.push(r);
    else byMes.set(key, [r]);
  }
  const sorted = Array.from(byMes.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  return sorted.map(([key, items]) => {
    const sortedItems = items
      .slice()
      .sort((a, b) => (a.data > b.data ? 1 : -1));
    const totalEmCaixa = sortedItems
      .filter((r) => r.status === 'EM_CAIXA')
      .reduce((s, r) => s + r.valor, 0);
    const totalPrevisto = sortedItems
      .filter((r) => r.status === 'PREVISTO')
      .reduce((s, r) => s + r.valor, 0);
    return {
      mesKey: key,
      mesLabel: mesLabelFromKey(key),
      items: sortedItems,
      total: totalEmCaixa + totalPrevisto,
      totalEmCaixa,
      totalPrevisto,
      isCurrentMonth: key === currentKey,
      isFuture: key > currentKey,
    };
  });
}
