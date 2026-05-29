import type { Expense } from '@/types';

const MESES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/**
 * Uma ocorrência é uma "instância" de uma despesa em um mês específico.
 * Despesas PARCELADO/QUINZENAL geram várias ocorrências (uma por parcela),
 * cada uma com sua própria data e valor (valor da parcela/quinzena).
 * Despesas à vista geram uma única ocorrência com o valor cheio.
 */
export interface Occurrence extends Expense {
  occKey: string;
  occDate: string;
  occValue: number;
  occIndex: number;
  occTotalParcelas: number;
}

export interface GrupoDespesaPorMes {
  mesKey: string;
  mesLabel: string;
  items: Occurrence[];
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

function addMonthsToISO(iso: string, i: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso.slice(0, 10);
  const total = (m - 1) + i;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDaysToISO(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso.slice(0, 10);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Expande uma despesa em suas ocorrências mensais.
 * PARCELADO → uma ocorrência por mês; QUINZENAL → a cada 15 dias.
 */
export function expandExpenseOccurrences(e: Expense): Occurrence[] {
  const n = e.quantidadeParcela ?? 1;
  const isInstallment =
    (e.formaPagamento === 'PARCELADO' || e.formaPagamento === 'QUINZENAL') &&
    n > 1;

  if (!isInstallment) {
    const d = effectiveDate(e) || '';
    return [
      {
        ...e,
        occKey: e.id,
        occDate: d,
        occValue: e.valorTotal,
        occIndex: 1,
        occTotalParcelas: 1,
      },
    ];
  }

  const start = e.dataInicioParcela || e.dataPagamento || effectiveDate(e) || '';
  const isQuinzenal = e.formaPagamento === 'QUINZENAL';
  const per = Math.round(e.valorTotal / n);
  const occ: Occurrence[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const value = i === n - 1 ? e.valorTotal - acc : per;
    acc += per;
    const occDate = isQuinzenal
      ? addDaysToISO(start, i * 15)
      : addMonthsToISO(start, i);
    occ.push({
      ...e,
      occKey: `${e.id}#${i}`,
      occDate,
      occValue: value,
      occIndex: i + 1,
      occTotalParcelas: n,
    });
  }
  return occ;
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
  const byMes = new Map<string, Occurrence[]>();
  const semData: Occurrence[] = [];

  for (const e of expenses) {
    for (const occ of expandExpenseOccurrences(e)) {
      if (!occ.occDate) {
        semData.push(occ);
        continue;
      }
      const key = mesKeyFromDate(occ.occDate);
      const arr = byMes.get(key);
      if (arr) arr.push(occ);
      else byMes.set(key, [occ]);
    }
  }

  const sorted = Array.from(byMes.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );

  const grouped = sorted.map(([key, items]) => {
    const sortedItems = items.slice().sort((a, b) =>
      a.occDate > b.occDate ? 1 : -1,
    );
    const totalPago = sortedItems
      .filter((e) => e.status === 'PAGO')
      .reduce((s, e) => s + e.occValue, 0);
    const totalPlanejado = sortedItems
      .filter((e) => e.status === 'PLANEJADO')
      .reduce((s, e) => s + e.occValue, 0);
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
      .reduce((s, e) => s + e.occValue, 0);
    const totalPlanejado = semData
      .filter((e) => e.status === 'PLANEJADO')
      .reduce((s, e) => s + e.occValue, 0);
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
