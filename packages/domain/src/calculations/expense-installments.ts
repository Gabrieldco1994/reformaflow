import { PaymentForm } from '../enums';
import { parseInstallmentDateOnlyUtc, todayLocalDateUtc } from './local-date-utc';
import { ExpenseScheduleV1, parseExpenseSchedule } from './expense-schedule';

export { parseInstallmentDateOnlyUtc } from './local-date-utc';

export type InstallmentPaymentForm =
  | typeof PaymentForm.A_VISTA
  | typeof PaymentForm.PARCELADO
  | typeof PaymentForm.QUINZENAL
  | typeof PaymentForm.PIX
  | typeof PaymentForm.PAGAMENTO_CONTA;

/**
 * Retorna `true` quando a forma de pagamento gera UMA única parcela
 * (pagamento único na data informada).
 *
 * Inclui formas tradicionais (A_VISTA), eletrônicas (PIX) e boleto/conta
 * (PAGAMENTO_CONTA). Strings desconhecidas também caem no caminho de
 * pagamento único para evitar quebras quando o backend recebe valores
 * legados (ex.: CARTAO_CREDITO, CONTA_CORRENTE vindos do importer).
 */
export function isSinglePaymentForm(forma: string | null | undefined): boolean {
  if (!forma) return true;
  return forma !== PaymentForm.PARCELADO && forma !== PaymentForm.QUINZENAL;
}

export interface InstallmentInput {
  /** Valor total da despesa em centavos (inteiro). */
  valorTotal: number;
  /** Forma de pagamento — `A_VISTA`, `PARCELADO` ou `QUINZENAL`. */
  formaPagamento: InstallmentPaymentForm | string;
  /** Data do pagamento à vista (usada apenas quando `A_VISTA`). */
  dataPagamento?: Date | null;
  /** Quantidade de parcelas (usada quando `PARCELADO`/`QUINZENAL`). */
  quantidadeParcela?: number | null;
  /** Data da primeira parcela (usada quando `PARCELADO`/`QUINZENAL`). */
  dataInicioParcela?: Date | null;
  /** JSON de datas efetivas por índice 0-based: `{"1":"2026-09-20"}`. */
  installmentDateOverrides?: string | null;
  schedule?: ExpenseScheduleV1 | null;
}

export interface InstallmentEntry {
  index: number;
  /** Rótulo documentado preservado; no legado, "i/n" ou "1/1". */
  parcela: string | null;
  /** Centavos documentados; no legado, o remainder vai para a última. */
  valor: number;
  /** Data efetiva da ocorrência em UTC, não a projeção do vencimento. */
  data: Date;
  invoiceDueMonth: string | null;
}

export function parseInstallmentDateOverrides(
  raw: string | null | undefined,
  installmentCount: number,
): Map<number, Date> {
  const result = new Map<number, Date>();
  if (!raw || installmentCount <= 0) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return result;
  for (const [key, value] of Object.entries(parsed)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= installmentCount) continue;
    if (typeof value !== 'string') continue;
    const date = parseInstallmentDateOnlyUtc(value);
    if (date) result.set(index, date);
  }
  return result;
}

function serializeInstallmentDateOverrides(overrides: Map<number, Date>): string | null {
  if (overrides.size === 0) return null;
  const normalized: Record<string, string> = {};
  for (const [index, date] of [...overrides.entries()].sort(([a], [b]) => a - b)) {
    normalized[String(index)] = date.toISOString().slice(0, 10);
  }
  return JSON.stringify(normalized);
}

export function normalizeInstallmentDateOverrides(input: InstallmentInput): string | null {
  if (!input.schedule && isSinglePaymentForm(input.formaPagamento)) return null;
  const base = buildBaseInstallments(input);
  const overrides = parseInstallmentDateOverrides(input.installmentDateOverrides, base.length);
  for (const [index, date] of overrides) {
    if (base[index]?.data.getTime() === date.getTime()) overrides.delete(index);
  }
  return serializeInstallmentDateOverrides(overrides);
}

export function setInstallmentDateOverride(
  input: InstallmentInput,
  installmentIndex: number,
  date: Date,
): string | null {
  const base = buildBaseInstallments(input);
  if (
    (!input.schedule && isSinglePaymentForm(input.formaPagamento)) ||
    !Number.isInteger(installmentIndex) ||
    installmentIndex < 0 ||
    installmentIndex >= base.length
  ) {
    return normalizeInstallmentDateOverrides(input);
  }
  const overrides = parseInstallmentDateOverrides(input.installmentDateOverrides, base.length);
  if (base[installmentIndex]?.data.getTime() === date.getTime()) {
    overrides.delete(installmentIndex);
  } else {
    overrides.set(installmentIndex, date);
  }
  return serializeInstallmentDateOverrides(overrides);
}

/**
 * Calcula as parcelas de uma despesa.
 * Um schedule explícito preserva centavos, rótulos e datas e deve fechar
 * exatamente com a quantidade de ocorrências e o valor total da despesa.
 *
 * Sempre opera em UTC para garantir consistência entre cliente e servidor
 * (timezones diferentes não devem mudar o dia da parcela).
 *
 * Regras:
 * - `A_VISTA`: 1 parcela com o valor total na `dataPagamento` (ou agora).
 * - `PARCELADO`: distribui o valor em N parcelas mensais. O dia da primeira
 *   parcela é mantido nas demais, com clamp para o último dia do mês quando
 *   o destino é mais curto (ex.: 31/jan → 28/fev em ano comum).
 * - `QUINZENAL`: distribui o valor em N parcelas a cada 15 dias.
 *
 * O remainder do arredondamento de centavos vai sempre para a ÚLTIMA parcela,
 * garantindo que a soma seja exatamente igual a `valorTotal`.
 */
export function buildInstallments(input: InstallmentInput): InstallmentEntry[] {
  const installments = buildBaseInstallments(input);
  if (!input.schedule && isSinglePaymentForm(input.formaPagamento)) return installments;
  const overrides = parseInstallmentDateOverrides(
    input.installmentDateOverrides,
    installments.length,
  );
  return installments.map((installment, index) => ({
    ...installment,
    data: overrides.get(index) ?? installment.data,
  }));
}

function buildBaseInstallments(input: InstallmentInput): InstallmentEntry[] {
  if (input.schedule != null) {
    const { occurrences } = parseExpenseSchedule(input.schedule);
    const count = isSinglePaymentForm(input.formaPagamento) ? 1 : (input.quantidadeParcela ?? 1);
    if (
      occurrences.length !== count ||
      occurrences.reduce((sum, occurrence) => sum + occurrence.valor, 0) !== input.valorTotal
    ) throw new RangeError('Expense schedule does not match expense count or total');
    return occurrences.map((occurrence) => ({
      ...occurrence,
      data: new Date(`${occurrence.data}T00:00:00.000Z`),
    }));
  }
  const {
    valorTotal,
    formaPagamento,
    dataPagamento,
    quantidadeParcela,
    dataInicioParcela,
  } = input;

  if (isSinglePaymentForm(formaPagamento)) {
    return [
      {
        index: 0,
        parcela: '1/1',
        valor: valorTotal,
        data: dataPagamento ?? todayLocalDateUtc('America/Sao_Paulo'),
        invoiceDueMonth: null,
      },
    ];
  }

  const n = Math.max(quantidadeParcela ?? 1, 1);
  const baseValue = Math.floor(valorTotal / n);
  const remainder = valorTotal - baseValue * n;
  const startDate =
    dataInicioParcela ?? dataPagamento ?? todayLocalDateUtc('America/Sao_Paulo');
  const isQuinzenal = formaPagamento === PaymentForm.QUINZENAL;

  return Array.from({ length: n }, (_, i) => {
    const d = new Date(startDate);
    if (isQuinzenal) {
      d.setUTCDate(d.getUTCDate() + i * 15);
    } else {
      const targetMonth = d.getUTCMonth() + i;
      const targetDay = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(targetMonth);
      const lastDay = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
      ).getUTCDate();
      d.setUTCDate(Math.min(targetDay, lastDay));
    }
    return {
      index: i,
      parcela: `${i + 1}/${n}`,
      valor: i === n - 1 ? baseValue + remainder : baseValue,
      data: d,
      invoiceDueMonth: null,
    };
  });
}

export function resolveInstallmentIndex(
  installments: readonly InstallmentEntry[],
  parcela: string | null,
): number {
  const matches = installments.filter((item) => item.parcela === parcela);
  if (matches.length === 1) return matches[0]!.index;
  const single = installments[0];
  if (
    installments.length === 1 && single &&
    (parcela === null || parcela === '1/1') &&
    (single.parcela === null || single.parcela === '1/1')
  ) return single.index;
  throw new RangeError('Missing or ambiguous installment correspondence');
}
