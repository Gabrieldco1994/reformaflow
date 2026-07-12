/**
 * Regras de vencimento de contas recorrentes (Fase G — Design System).
 *
 * Único ponto de verdade para "atrasada" / "vence em breve", reutilizado por
 * `bills/_lib/kpis.ts` e por qualquer outra tela que precise da mesma regra
 * (ex.: dashboard de gestão) — nunca duplicar esta conta em outro arquivo.
 */

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Dias até o próximo vencimento (pode ser negativo se já passou). O dia de
 * vencimento é ajustado (clamp) para o último dia do mês corrente quando o
 * mês não tiver dias suficientes (ex.: dia 31 em fevereiro).
 */
export function daysUntilDue(diaVencimento: number, today: Date): number {
  const year = today.getFullYear();
  const month = today.getMonth();
  const clampedDay = Math.min(diaVencimento, daysInMonth(year, month));
  const dueDate = new Date(year, month, clampedDay);
  const diffMs = dueDate.getTime() - startOfDay(today).getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/** Atrasada = estritamente depois do dia de vencimento (o próprio dia não conta). */
export function isBillOverdue(diaVencimento: number, today: Date): boolean {
  return daysUntilDue(diaVencimento, today) < 0;
}

/**
 * Vence em breve = dentro da janela informada e ainda não atrasada (atraso
 * tem precedência: uma conta atrasada nunca é "vence em breve").
 */
export function isBillDueSoon(
  diaVencimento: number,
  today: Date,
  windowDays: number,
): boolean {
  const diff = daysUntilDue(diaVencimento, today);
  if (diff < 0) return false;
  return diff <= windowDays;
}
