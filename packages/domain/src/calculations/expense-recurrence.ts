/**
 * Gerador de datas de despesa recorrente.
 *
 * Diferente de `buildInstallments` (que DIVIDE um total em N parcelas), a
 * recorrência REPETE a mesma despesa a cada período entre um início e um fim.
 * Cada ocorrência vira uma despesa planejada independente — editável e contada
 * nos KPIs como qualquer despesa normal.
 *
 * Frequências:
 * - `MENSAL`: mesmo dia do mês, do início ao fim (clamp para o último dia do mês
 *   quando o dia não existe, ex.: 31 → 30/28). Espelha a regra de `buildInstallments`.
 * - `QUINZENAL`: a cada 15 dias corridos.
 * - `BIMESTRAL`/`TRIMESTRAL`/`SEMESTRAL`/`ANUAL`: mesma regra de MENSAL, com
 *   passo de 2/3/6/12 meses.
 *
 * As datas são geradas em UTC (sem deslocamento de fuso), inclusivas nos limites.
 */

export type RecurrenceFrequency =
  | 'MENSAL'
  | 'QUINZENAL'
  | 'BIMESTRAL'
  | 'TRIMESTRAL'
  | 'SEMESTRAL'
  | 'ANUAL';

/** Passo em meses de cada frequência (QUINZENAL é o único em dias corridos). */
const MONTH_STEP: Record<Exclude<RecurrenceFrequency, 'QUINZENAL'>, number> = {
  MENSAL: 1,
  BIMESTRAL: 2,
  TRIMESTRAL: 3,
  SEMESTRAL: 6,
  ANUAL: 12,
};

export interface RecurrenceInput {
  /** Data da primeira ocorrência (inclusive). */
  inicio: Date;
  /** Data limite (inclusive) — a última ocorrência é a maior data <= fim. */
  fim: Date;
  frequencia: RecurrenceFrequency;
  /** Teto de segurança de ocorrências (default 120 = 10 anos mensais / ~5 anos quinzenais). */
  maxOcorrencias?: number;
}

/** Retorna `true` se a string é uma frequência de recorrência válida. */
export function isRecurrenceFrequency(v: string | null | undefined): v is RecurrenceFrequency {
  return v === 'QUINZENAL' || (!!v && v in MONTH_STEP);
}

/**
 * Gera as datas das ocorrências entre `inicio` e `fim` (ambos inclusivos).
 * Retorna `[]` se `fim < inicio`. Sempre inclui a data de início como 1ª ocorrência.
 */
export function buildRecurrenceDates(input: RecurrenceInput): Date[] {
  const { inicio, fim, frequencia, maxOcorrencias = 120 } = input;

  const start = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth(), inicio.getUTCDate()));
  const end = new Date(Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth(), fim.getUTCDate()));
  if (end.getTime() < start.getTime()) return [];

  const dates: Date[] = [];

  if (frequencia === 'QUINZENAL') {
    let i = 0;
    while (i < maxOcorrencias) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i * 15);
      if (d.getTime() > end.getTime()) break;
      dates.push(d);
      i += 1;
    }
    return dates;
  }

  // Mensais-múltiplos: mesmo dia-do-mês, com clamp para o último dia do mês.
  const step = MONTH_STEP[frequencia];
  const anchorDay = start.getUTCDate();
  let i = 0;
  while (i < maxOcorrencias) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i * step, 1));
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(anchorDay, lastDay));
    if (d.getTime() > end.getTime()) break;
    dates.push(d);
    i += 1;
  }
  return dates;
}
