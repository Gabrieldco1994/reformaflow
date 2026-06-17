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

export function caixaMonthForCardPurchase(
  purchaseDate: Date | string,
  closingDay: number | null | undefined,
  dueDay: number | null | undefined,
): string {
  const d = toUtcDate(purchaseDate);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  const day = d.getUTCDate();

  // Fallback: sem configuração de fechamento/vencimento, usa a competência.
  if (closingDay == null || dueDay == null) {
    return formatYearMonth(year, month);
  }

  // Mês em que a fatura FECHA (offset relativo ao mês da compra).
  const closeMonthOffset = day < closingDay ? 0 : 1;
  // Vencimento: se vence antes do dia de fechamento, é no mês seguinte ao fechamento.
  const dueMonthOffset = dueDay >= closingDay ? 0 : 1;

  return formatYearMonth(year, month + closeMonthOffset + dueMonthOffset);
}
