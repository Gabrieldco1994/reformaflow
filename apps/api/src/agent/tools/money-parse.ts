/**
 * Converte um valor monetário "falado"/digitado em REAIS (número decimal).
 *
 * Robusto para o português do Brasil, onde a vírgula é o separador decimal e o
 * ponto é o separador de milhar — ao contrário do JSON/US. Isso evita o bug do
 * assistente de voz em que "206,96" era serializado como o número 20696 (inflando
 * o valor em 100x). Capturando o valor como string e parseando aqui de forma
 * determinística, o servidor não depende da aritmética do modelo.
 *
 * Exemplos: "206,96" → 206.96 · "20.696,00" → 20696 · "1.500" → 1500 ·
 * "206.96" → 206.96 · "R$ 1.234,56" → 1234.56 · 206.96 → 206.96.
 *
 * Retorna `null` quando o valor é ausente, não numérico ou <= 0.
 */
export function parseSpokenMoney(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    let s = value.trim().replace(/r\$/gi, '').replace(/\s/g, '');
    if (s.includes(',')) {
      // Vírgula presente → é o separador decimal; pontos são milhares.
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (/\.\d{3}$/.test(s) || (s.match(/\./g)?.length ?? 0) > 1) {
      // Sem vírgula, mas com ponto em posição de milhar (ex.: "1.500" ou
      // "1.234.567") → ponto é separador de milhar, não decimal.
      s = s.replace(/\./g, '');
    }
    n = Number(s);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}
