/** Narrow request-first entry, not model output or a general intent/financial parser. */
export function requestsCardInvoiceImport(literal: string): boolean {
  const normalized = literal
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  if (/\b(nao|nunca|sem|cancele|cancelar)\b/.test(normalized)) return false;
  return (
    /\bfatura\b/.test(normalized) &&
    /\b(importar|importe|importacao|processar|processe|analisar|analise)\b/.test(
      normalized,
    )
  );
}
