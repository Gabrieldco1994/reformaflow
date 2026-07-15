import { PaymentForm } from '../enums';
import { todayLocalDateUtc } from './local-date-utc';

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
}

export interface InstallmentEntry {
  /** Rótulo "i/n" — "1/1" para `A_VISTA`. */
  parcela: string;
  /** Valor da parcela em centavos. O remainder vai para a última. */
  valor: number;
  /** Data calculada da parcela em UTC. */
  data: Date;
}

/**
 * Calcula as parcelas de uma despesa.
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
        parcela: '1/1',
        valor: valorTotal,
        data: dataPagamento ?? todayLocalDateUtc('America/Sao_Paulo'),
      },
    ];
  }

  const n = Math.max(quantidadeParcela ?? 1, 1);
  const baseValue = Math.floor(valorTotal / n);
  const remainder = valorTotal - baseValue * n;
  const startDate = dataInicioParcela ?? todayLocalDateUtc('America/Sao_Paulo');
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
      parcela: `${i + 1}/${n}`,
      valor: i === n - 1 ? baseValue + remainder : baseValue,
      data: d,
    };
  });
}
