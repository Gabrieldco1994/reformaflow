/**
 * Cenários "E se…?" — deforma uma série mensal existente (ex.: runway de
 * caixa) aplicando um delta recorrente por mês, client-side, sem persistência
 * nem novo dado de servidor. Função pura: nunca muta a série de entrada.
 *
 * Contrato (ver BRIEF-TRILHA1-FASE-C-VISUAL.md, inovação #2):
 * - Centavos inteiros, sem ponto flutuante.
 * - `serie` nunca é mutada (novo array/objetos retornados).
 * - O primeiro ponto (índice 0) nunca muda, para qualquer delta.
 * - Delta recorrente acumula por índice: `out[i] = in[i] + delta*i`.
 * - `delta = 0` é um reset exato (deep-equal ao input, mas array novo).
 */
export interface ScenarioPoint {
  mes: string;
  saldoProjetado: number;
}

export function applyScenario<T extends ScenarioPoint>(
  serie: readonly T[],
  deltaCentsPerMonth: number,
): T[] {
  const delta = Math.round(deltaCentsPerMonth);
  return serie.map((point, index) => ({
    ...point,
    saldoProjetado: point.saldoProjetado + delta * index,
  }));
}
