import { formatCurrency } from '@/lib/utils';
import type { DreSaldoAcumuladoRow } from '../dre/_types';

export type RunwayNarrativeTone = 'positive' | 'negative';

export interface RunwayNarrative {
  tone: RunwayNarrativeTone;
  headline: string;
  detail: string;
}

export function monthLabelLongFromKey(key: string): string {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function deriveRunwayNarrative(
  serie: DreSaldoAcumuladoRow[] | undefined,
  currentMonth: string,
): RunwayNarrative | null {
  const forward = (serie ?? []).filter((row) => row.mes >= currentMonth);
  if (forward.length < 2) return null;

  const crossover = forward.find((row) => row.saldoProjetado < 0) ?? null;
  const lowest = forward.reduce(
    (min, row) => (row.saldoProjetado < min.saldoProjetado ? row : min),
    forward[0]!,
  );
  const horizon = forward[forward.length - 1]!;

  if (crossover) {
    return {
      tone: 'negative',
      headline: `No ritmo atual, o saldo fica negativo em ${monthLabelLongFromKey(crossover.mes)}.`,
      detail: `Pior ponto: ${formatCurrency(lowest.saldoProjetado / 100)} em ${monthLabelLongFromKey(lowest.mes)}.`,
    };
  }

  return {
    tone: 'positive',
    headline: `O saldo se mantém positivo até ${monthLabelLongFromKey(horizon.mes)}.`,
    detail: `Menor ponto: ${formatCurrency(lowest.saldoProjetado / 100)} em ${monthLabelLongFromKey(lowest.mes)}.`,
  };
}
