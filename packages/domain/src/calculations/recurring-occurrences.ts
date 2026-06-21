/**
 * Ocorrências de uma despesa recorrente MENSAL (despesa fixa).
 *
 * São "virtuais": não existem como linhas no banco — são derivadas de uma
 * única despesa marcada como `recorrente`, expandida mês a mês a partir da
 * data de início até o menor entre `recorrenciaFim` e `horizonEnd`.
 *
 * A comparação de limite é feita por MÊS (YYYY-MM), não por dia: se o
 * horizonte cai no mesmo mês do início (mesmo que num dia anterior), a
 * ocorrência daquele mês é incluída.
 *
 * Sempre opera em UTC para consistência cliente/servidor. O dia do mês é
 * mantido, com clamp para o último dia em meses mais curtos (31 → 28/30).
 */
export interface RecurringInput {
  /** Valor total da despesa em centavos (inteiro). */
  valorTotal: number;
  /** Data da primeira ocorrência (UTC). */
  dataInicio: Date;
  /** Último mês da recorrência (inclusive) ou null para sem fim. */
  recorrenciaFim?: Date | null;
  /** Não gerar ocorrências além deste mês (ex.: mês selecionado ou hoje). */
  horizonEnd: Date;
}

export interface RecurringEntry {
  /** 0-based: número de meses desde `dataInicio`. */
  index: number;
  /** Valor da ocorrência em centavos (igual ao total — recorrência não rateia). */
  valor: number;
  /** Data da ocorrência (UTC), com o dia original ou clamp. */
  data: Date;
}

/** Índice absoluto de mês (anos*12+mês) para contagem de meses entre datas. */
function monthIndex(d: Date): number {
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

export function buildRecurringOccurrences(
  input: RecurringInput,
): RecurringEntry[] {
  const { valorTotal, dataInicio, recorrenciaFim, horizonEnd } = input;

  const startIdx = monthIndex(dataInicio);
  let endIdx = monthIndex(horizonEnd);
  if (recorrenciaFim) {
    endIdx = Math.min(endIdx, monthIndex(recorrenciaFim));
  }
  if (endIdx < startIdx) return [];

  const day = dataInicio.getUTCDate();
  const count = endIdx - startIdx + 1;

  return Array.from({ length: count }, (_, i) => {
    const targetMonth = dataInicio.getUTCMonth() + i;
    const d = new Date(dataInicio);
    d.setUTCDate(1);
    d.setUTCMonth(targetMonth);
    const lastDay = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return { index: i, valor: valorTotal, data: d };
  });
}
