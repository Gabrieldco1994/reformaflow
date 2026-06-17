/**
 * Derivação do "mês de caixa" (vencimento da fatura) de uma compra de cartão.
 *
 * Dado a data da compra e o `closingDay`/`dueDay` do cartão, calcula em qual
 * mês a despesa efetivamente SAI do caixa (vencimento da fatura), em oposição
 * à competência (data da compra).
 *
 * Convenção padrão de cartão BR (decisão de produto):
 * - A compra entra na fatura que fecha no próximo `closingDay` ESTRITAMENTE
 *   depois do dia da compra. Ou seja: dia < closingDay → fecha no mês corrente;
 *   dia >= closingDay → fecha no mês seguinte (compra no dia do fechamento cai
 *   na PRÓXIMA fatura).
 * - Essa fatura vence no `dueDay`. Se `dueDay < closingDay`, o vencimento é no
 *   mês seguinte ao fechamento; se `dueDay >= closingDay`, vence no mesmo mês.
 * - O mês de caixa é o ano-mês da data de vencimento.
 *
 * Tudo em UTC (espelha `buildInstallments`) para consistência cliente/servidor.
 *
 * Edge cases:
 * - `closingDay`/`dueDay` nulos → fallback para o mês da própria compra
 *   (degrada para competência sem quebrar).
 */

function toUtcDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatYearMonth(year: number, monthIndex0: number): string {
  // monthIndex0 pode estar fora de 0-11; normaliza via Date.UTC.
  const d = new Date(Date.UTC(year, monthIndex0, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Offset (em meses) do vencimento em relação ao mês da compra.
 * `null` quando não há configuração de fechamento/vencimento (fallback).
 */
function dueMonthOffset(
  day: number,
  closingDay: number | null | undefined,
  dueDay: number | null | undefined,
): number | null {
  if (closingDay == null || dueDay == null) return null;
  // Mês em que a fatura FECHA (compra no dia do fechamento cai na próxima fatura).
  const closeMonthOffset = day < closingDay ? 0 : 1;
  // Vencimento: se vence antes do dia de fechamento, é no mês seguinte ao fechamento.
  const dueOffset = dueDay >= closingDay ? 0 : 1;
  return closeMonthOffset + dueOffset;
}

export function caixaMonthForCardPurchase(
  purchaseDate: Date | string,
  closingDay: number | null | undefined,
  dueDay: number | null | undefined,
): string {
  const d = toUtcDate(purchaseDate);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  const day = d.getUTCDate();

  const offset = dueMonthOffset(day, closingDay, dueDay);
  if (offset == null) return formatYearMonth(year, month); // fallback: competência

  return formatYearMonth(year, month + offset);
}

/**
 * Como `caixaMonthForCardPurchase`, mas retorna a DATA de vencimento (com o
 * `dueDay` aplicado e clamp para o último dia de meses curtos) — útil para
 * reprojetar lançamentos no eixo de caixa preservando o dia.
 *
 * Fallback (dias nulos): retorna a própria data da compra (competência).
 */
export function caixaDateForCardPurchase(
  purchaseDate: Date | string,
  closingDay: number | null | undefined,
  dueDay: number | null | undefined,
): Date {
  const d = toUtcDate(purchaseDate);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  const offset = dueMonthOffset(day, closingDay, dueDay);
  if (offset == null) return d; // fallback: mantém a data da compra

  const lastDay = new Date(Date.UTC(year, month + offset + 1, 0)).getUTCDate();
  const clampedDue = Math.min(dueDay as number, lastDay);
  return new Date(Date.UTC(year, month + offset, clampedDue));
}
