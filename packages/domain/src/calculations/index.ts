import { CashFlowType, PaymentForm } from '../enums';
import type { CashFlowEntry, CashFlowEntryComputed } from '../types';

/**
 * Calcula o saldo acumulado do fluxo de caixa (rolling balance)
 * Recebimento soma, Despesa subtrai
 */
export function calculateRollingBalance(
  entries: Pick<CashFlowEntry, 'tipo' | 'valor'>[],
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
 * Enriquece entradas de fluxo de caixa com saldo acumulado
 */
export function computeCashFlowEntries(
  entries: CashFlowEntry[],
): CashFlowEntryComputed[] {
  const balances = calculateRollingBalance(entries);
  return entries.map((entry, i) => ({
    ...entry,
    rollingBalance: balances[i]!,
  }));
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
