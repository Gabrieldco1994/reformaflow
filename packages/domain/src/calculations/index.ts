import { CashFlowType, CashFlowStatus, PaymentForm } from '../enums';
import type { CashFlowEntry, CashFlowEntryComputed } from '../types';

/**
 * Calcula o saldo acumulado do fluxo de caixa (rolling balance)
 * Recebimento soma, Despesa subtrai
 */
export function calculateRollingBalance(
  entries: Array<{ tipo: string; valor: number }>,
): number[] {
  const balances: number[] = [];
  let running = 0;

  for (const entry of entries) {
    if (entry.tipo === CashFlowType.RECEBIMENTO) {
      running += entry.valor;
    } else {
      running -= entry.valor;
    }
    balances.push(running);
  }

  return balances;
}

/**
 * Status que representam dinheiro **realizado** (efetivado), em oposição
 * a planejado/previsto. Usado para diferenciar saldo realizado x projetado.
 */
export const REALIZED_CASHFLOW_STATUSES: ReadonlySet<string> = new Set([
  CashFlowStatus.PAGO,
  CashFlowStatus.EM_CAIXA,
]);

export function isRealizedEntry(entry: { status: string }): boolean {
  return REALIZED_CASHFLOW_STATUSES.has(entry.status);
}

/**
 * Saldo acumulado considerando APENAS entries efetivamente realizados
 * (RECEBIMENTO em EM_CAIXA, DESPESA em PAGO). Planejados/Previstos não somam.
 *
 * Importante: a saída tem o mesmo tamanho de `entries` (1 saldo por linha),
 * para que o frontend possa exibir o valor realizado lado a lado com o
 * acumulado projetado. Entries não-realizados herdam o último realizado
 * (mantém a linha estável visualmente).
 */
export function calculateRollingBalanceRealizado(
  entries: Array<{ tipo: string; valor: number; status: string }>,
): number[] {
  const balances: number[] = [];
  let running = 0;

  for (const entry of entries) {
    if (isRealizedEntry(entry)) {
      if (entry.tipo === CashFlowType.RECEBIMENTO) {
        running += entry.valor;
      } else {
        running -= entry.valor;
      }
    }
    balances.push(running);
  }

  return balances;
}

/**
 * Enriquece entradas de fluxo de caixa com saldo acumulado (projetado e realizado)
 */
export function computeCashFlowEntries(
  entries: CashFlowEntry[],
): CashFlowEntryComputed[] {
  const balances = calculateRollingBalance(entries);
  const balancesRealizado = calculateRollingBalanceRealizado(entries);
  return entries.map((entry, i) => ({
    ...entry,
    rollingBalance: balances[i]!,
    rollingBalanceRealizado: balancesRealizado[i]!,
  }));
}

export interface MonthlyAccumulatedRow {
  mes: string;                       // YYYY-MM
  recebimentos: number;              // todos
  despesas: number;                  // todos
  recebimentosRealizados: number;    // só EM_CAIXA
  despesasRealizadas: number;        // só PAGO
  saldoAcumulado: number;            // projetado (tudo)
  saldoAcumuladoRealizado: number;   // só realizado
}

function nextMonthKey(key: string): string {
  const [yStr, mStr] = key.split('-');
  let y = Number.parseInt(yStr ?? '0', 10);
  let m = Number.parseInt(mStr ?? '0', 10);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Agrega cash-flow entries em buckets mensais (YYYY-MM), preenchendo meses
 * vazios entre o primeiro e o último mês com entries para que a linha do
 * saldo acumulado seja contínua no gráfico (sem "saltos").
 *
 * Retorna duas séries de saldo:
 * - saldoAcumulado: tudo (PAGO + PLANEJADO + EM_CAIXA + PREVISTO)
 * - saldoAcumuladoRealizado: apenas EM_CAIXA e PAGO
 */
export function buildMonthlyAccumulated(
  entries: Array<{ tipo: string; valor: number; status: string; data: Date | string }>,
): MonthlyAccumulatedRow[] {
  if (entries.length === 0) return [];

  const byMonth = new Map<string, {
    recebimentos: number;
    despesas: number;
    recebimentosRealizados: number;
    despesasRealizadas: number;
  }>();

  for (const entry of entries) {
    const d = entry.data instanceof Date ? entry.data : new Date(entry.data as unknown as string);
    const mesKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    let bucket = byMonth.get(mesKey);
    if (!bucket) {
      bucket = { recebimentos: 0, despesas: 0, recebimentosRealizados: 0, despesasRealizadas: 0 };
      byMonth.set(mesKey, bucket);
    }
    const realized = isRealizedEntry(entry);
    if (entry.tipo === CashFlowType.RECEBIMENTO) {
      bucket.recebimentos += entry.valor;
      if (realized) bucket.recebimentosRealizados += entry.valor;
    } else {
      bucket.despesas += entry.valor;
      if (realized) bucket.despesasRealizadas += entry.valor;
    }
  }

  const sorted = Array.from(byMonth.keys()).sort();
  const firstMes = sorted[0]!;
  const lastMes = sorted[sorted.length - 1]!;

  const months: string[] = [];
  let cursor = firstMes;
  while (cursor <= lastMes) {
    months.push(cursor);
    if (cursor === lastMes) break;
    cursor = nextMonthKey(cursor);
    if (months.length > 600) break; // safety: 50 anos
  }

  const rows: MonthlyAccumulatedRow[] = [];
  let acc = 0;
  let accReal = 0;
  for (const mes of months) {
    const bucket = byMonth.get(mes) ?? {
      recebimentos: 0,
      despesas: 0,
      recebimentosRealizados: 0,
      despesasRealizadas: 0,
    };
    acc += bucket.recebimentos - bucket.despesas;
    accReal += bucket.recebimentosRealizados - bucket.despesasRealizadas;
    rows.push({
      mes,
      recebimentos: bucket.recebimentos,
      despesas: bucket.despesas,
      recebimentosRealizados: bucket.recebimentosRealizados,
      despesasRealizadas: bucket.despesasRealizadas,
      saldoAcumulado: acc,
      saldoAcumuladoRealizado: accReal,
    });
  }
  return rows;
}

/**
 * Gera as datas das parcelas conforme forma de pagamento.
 * - PARCELADO: mensal (a cada 30 dias)
 * - QUINZENAL: a cada 15 dias
 */
export function generateInstallmentDates(
  startDate: Date,
  quantity: number,
  paymentForm: PaymentForm,
): Date[] {
  const dates: Date[] = [];
  for (let i = 0; i < quantity; i++) {
    const d = new Date(startDate);
    if (paymentForm === PaymentForm.PARCELADO) {
      d.setMonth(d.getMonth() + i);
    } else {
      d.setDate(d.getDate() + i * 15);
    }
    dates.push(d);
  }
  return dates;
}

/**
 * Distribui um valor total em N parcelas usando centavos inteiros.
 * A última parcela absorve o restante para garantir que a soma seja exata.
 */
export function splitIntoCents(totalCents: number, installments: number): number[] {
  const base = Math.floor(totalCents / installments);
  const remainder = totalCents - base * installments;
  const amounts: number[] = [];
  for (let i = 0; i < installments; i++) {
    amounts.push(i === installments - 1 ? base + remainder : base);
  }
  return amounts;
}

/**
 * Converte reais (number com decimais) para centavos (inteiro)
 */
export function toCents(value: number): number {
  return Math.round(value * 100);
}

/**
 * Converte centavos para reais
 */
export function fromCents(cents: number): number {
  return cents / 100;
}
