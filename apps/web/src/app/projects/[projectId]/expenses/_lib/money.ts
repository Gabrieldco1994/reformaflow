/**
 * Conversões reais<->centavos para os forms de despesa.
 *
 * `reaisToCents` reaproveita o padrão de `RatearCompraModal.tsx`, porém aceita
 * tanto o formato brasileiro ("5.000,00" = milhar por ponto, decimal por vírgula)
 * quanto o formato "puro" com ponto decimal ("5000.50"). A heurística: se houver
 * vírgula, o ponto é separador de milhar; caso contrário o ponto é decimal.
 */
export function reaisToCents(raw: string): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  // Com vírgula → formato BR (pontos são milhar, vírgula é decimal).
  // Sem vírgula → ponto é o separador decimal (ou não há decimal).
  const normalized = trimmed.includes(',')
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Centavos inteiros → string em reais no formato BR ("500000" → "5.000,00"). */
export function centsToReais(cents: number): string {
  if (!Number.isFinite(cents)) return '0,00';
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
