import type { Expense } from '@/types';
import { buildInstallments } from '@reformaflow/domain';

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

/** Parseia o JSON de parcelas pagas (índices 0-based), filtrando inválidos. */
function parsePaidSet(raw: string | null | undefined, n: number): Set<number> {
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    const s = new Set<number>();
    for (const v of arr) {
      const i = Number(v);
      if (Number.isInteger(i) && i >= 0 && i < n) s.add(i);
    }
    return s;
  } catch {
    return new Set();
  }
}

/**
 * Expande uma despesa em suas ocorrências mensais.
 * PARCELADO → uma ocorrência por mês; QUINZENAL → a cada 15 dias.
 * Cada ocorrência tem status próprio: paga se a parcela está em `paidParcelas`
 * (ou se a despesa inteira está PAGO).
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

  // Usa o MESMO cálculo de parcelas do backend (@reformaflow/domain) para
  // garantir que valores e datas das parcelas batam com o fluxo de caixa.
  const installments = buildInstallments({
    valorTotal: e.valorTotal,
    formaPagamento: e.formaPagamento,
    dataPagamento: e.dataPagamento ? new Date(e.dataPagamento) : null,
    quantidadeParcela: e.quantidadeParcela ?? null,
    dataInicioParcela: e.dataInicioParcela ? new Date(e.dataInicioParcela) : null,
  });

  const paidSet = parsePaidSet(e.paidParcelas, installments.length);
  const fullyPaid = e.status === 'PAGO';

  return installments.map((inst, i) => ({
    ...e,
    occKey: `${e.id}#${i}`,
    occDate: inst.data.toISOString().slice(0, 10),
    occValue: inst.valor,
    occIndex: i + 1,
    occTotalParcelas: installments.length,
    status: (fullyPaid || paidSet.has(i) ? 'PAGO' : 'PLANEJADO') as Expense['status'],
  }));
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

/**
 * Agrupa TODAS as despesas numa única lista cronológica (visão "Geral"):
 * expande parcelas em ocorrências, ordena por data (empate por maior valor) e
 * devolve um único grupo. É o "fluxo de caixa" focado em saídas — o que saiu,
 * quando e quanto — preservando as ocorrências (parcela k/n) para que as ações
 * (editar, pagar, copiar) funcionem igual à visão "Mês".
 */
export function groupExpensesChrono(expenses: Expense[]): GrupoDespesaPorMes[] {
  const comData: Occurrence[] = [];
  const semData: Occurrence[] = [];

  for (const e of expenses) {
    for (const occ of expandExpenseOccurrences(e)) {
      if (occ.occDate) comData.push(occ);
      else semData.push(occ);
    }
  }

  comData.sort((a, b) => {
    if (a.occDate !== b.occDate) return a.occDate < b.occDate ? -1 : 1;
    return b.occValue - a.occValue;
  });

  const items = [...comData, ...semData];
  if (items.length === 0) return [];

  const totalPago = items
    .filter((e) => e.status === 'PAGO')
    .reduce((s, e) => s + e.occValue, 0);
  const totalPlanejado = items
    .filter((e) => e.status === 'PLANEJADO')
    .reduce((s, e) => s + e.occValue, 0);

  return [
    {
      mesKey: 'geral',
      mesLabel: 'Todas as despesas · por data',
      items,
      total: totalPago + totalPlanejado,
      totalPago,
      totalPlanejado,
      isCurrentMonth: false,
      isFuture: false,
    },
  ];
}
