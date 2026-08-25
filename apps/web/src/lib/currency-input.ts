export function centsToReaisInput(cents: number): string {
  if (!Number.isFinite(cents)) return '0,00';
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function maskCurrencyInput(raw: string): string {
  // Preserva o sinal de menos — necessário para estornos/créditos na prévia de
  // importação (fatura de cartão), onde o valor negativo é o próprio dado, não
  // ruído a descartar. `\D` também casa '-', então sem isso o sinal some ao
  // filtrar dígitos e um estorno de -R$100 vira +R$100 ao ser reeditado.
  const isNegative = raw.includes('-');
  const digits = raw.replace(/\D/g, '');
  // Sem dígitos ainda mas com '-' digitado: mantém o sinal como placeholder
  // (não zera pra '') — senão o "-" some antes do primeiro dígito chegar e o
  // usuário nunca consegue reconstruir um valor negativo digitando do zero.
  if (!digits) return isNegative ? '-' : '';
  const formatted = centsToReaisInput(Number(digits));
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Mesma máscara, mas rejeita sinal de menos — para campos que nunca podem
 * receber valor negativo (a maioria: despesa, receita, meta, limite de
 * cartão, preço de referência etc.). Sinal negativo só é legítimo em
 * contextos específicos e explícitos (ex.: estorno na prévia de importação
 * de fatura de cartão), que usam `maskCurrencyInput` diretamente — ver
 * auditoria de consumidores na issue #572.
 */
export function maskCurrencyInputPositive(raw: string): string {
  return maskCurrencyInput(raw.replace(/-/g, ''));
}

export function currencyInputToCents(raw: string): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const normalized = trimmed.includes(',')
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export function currencyInputToNumber(raw: string): number {
  return currencyInputToCents(raw) / 100;
}
