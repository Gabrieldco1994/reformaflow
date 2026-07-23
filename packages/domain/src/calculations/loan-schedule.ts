/**
 * Matemática pura de amortização (PRICE/SAC), extraída de
 * `apps/api/src/financing/financing.service.ts` para ser compartilhada com o
 * Planejador de Compras (`applyPurchasePlan`, ver `purchase-plan.ts`).
 *
 * PARIDADE: a parcela nº1 de um financiamento hipotético calculada aqui deve
 * ser byte-a-byte igual à parcela nº1 real do `financing.service` com os
 * mesmos parâmetros — mesma função, sem fork.
 */

export interface ScheduleRow {
  valorPrevisto: number;
  saldoDevedorPrevisto: number;
}

/** Parses a strict "YYYY-MM-DD" string into a UTC midnight Date (timezone-safe). */
export function parseDateOnlyUtc(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
}

/** Days in a given UTC year/month (0-indexed month). */
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Due date for installment `offset` months after `anchor`'s year/month,
 * clamped to `day` (1-31 -> last day of the target month when shorter).
 */
export function monthlyDueDate(anchor: Date, offset: number, day: number): Date {
  const totalMonth = anchor.getUTCMonth() + offset;
  const year = anchor.getUTCFullYear() + Math.floor(totalMonth / 12);
  const month0 = ((totalMonth % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonth(year, month0));
  return new Date(Date.UTC(year, month0, clampedDay));
}

/**
 * Sistema PRICE (Tabela Price): prestação fixa.
 * P*r*(1+r)^n / ((1+r)^n - 1); r = bps/10000. Com r=0 divide o principal em
 * parcelas iguais (resto na última). A última parcela sempre zera o saldo,
 * absorvendo o desvio de arredondamento acumulado.
 */
export function buildPriceSchedule(
  principal: number,
  bps: number,
  n: number,
): ScheduleRow[] {
  const r = bps / 10000;
  const rows: ScheduleRow[] = [];

  if (r === 0) {
    const base = Math.floor(principal / n);
    const remainder = principal - base * n;
    let saldo = principal;
    for (let i = 1; i <= n; i++) {
      const valor = i === n ? base + remainder : base;
      saldo -= valor;
      rows.push({
        valorPrevisto: valor,
        saldoDevedorPrevisto: i === n ? 0 : Math.max(saldo, 0),
      });
    }
    return rows;
  }

  const prestacao = Math.round((principal * r) / (1 - Math.pow(1 + r, -n)));
  let saldo = principal;
  for (let i = 1; i <= n; i++) {
    const juros = Math.round(saldo * r);
    let principalPart = Math.min(prestacao - juros, saldo);
    let valorPrevisto = prestacao;
    if (i === n) {
      // Zera o saldo exatamente na última parcela, absorvendo o desvio de
      // arredondamento acumulado ao longo das parcelas anteriores.
      principalPart = saldo;
      valorPrevisto = principalPart + juros;
    }
    saldo = Math.max(saldo - principalPart, 0);
    rows.push({
      valorPrevisto,
      saldoDevedorPrevisto: i === n ? 0 : saldo,
    });
  }
  return rows;
}

/**
 * Sistema SAC: amortização de principal fixa (resto na última parcela),
 * juros incidem sobre o saldo devedor inicial de cada parcela — por isso a
 * prestação é decrescente.
 */
export function buildSacSchedule(
  principal: number,
  bps: number,
  n: number,
): ScheduleRow[] {
  const r = bps / 10000;
  const base = Math.floor(principal / n);
  const remainder = principal - base * n;
  let saldo = principal;
  const rows: ScheduleRow[] = [];
  for (let i = 1; i <= n; i++) {
    const amortizacao = i === n ? base + remainder : base;
    const juros = Math.round(saldo * r);
    saldo = Math.max(saldo - amortizacao, 0);
    rows.push({
      valorPrevisto: amortizacao + juros,
      saldoDevedorPrevisto: i === n ? 0 : saldo,
    });
  }
  return rows;
}
