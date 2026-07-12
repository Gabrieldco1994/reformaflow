/**
 * Cenários "E se…?" — deforma uma série mensal existente (ex.: runway de
 * caixa) aplicando um delta recorrente por mês, client-side, sem persistência
 * nem novo dado de servidor. Função pura: nunca muta a série de entrada.
 *
 * Contrato canônico, compartilhado entre o "E se…?" do mobile (Trilha 1) e o
 * runway com valor livre do Cockpit desktop (Trilha 2) — ver
 * BRIEF-TRILHA1-FASE-C-VISUAL.md e BRIEF-TRILHA2-WEB-ANALITICO-D1.md:
 * - Centavos inteiros, sem ponto flutuante.
 * - `serie` nunca é mutada (novo array retornado; objetos deformados também
 *   são novos, exceto o índice 0 — ver abaixo).
 * - O primeiro ponto (índice 0) é o "hoje"/mês corrente âncora: imutável em
 *   VALOR e em IDENTIDADE de objeto (nunca se move visualmente, nunca quebra
 *   `===` por engano em memoização de gráfico), para qualquer delta.
 * - Delta recorrente acumula por índice a partir de i>=1: `out[i] = in[i] + delta*i`.
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
  return serie.map((point, index) =>
    index === 0
      ? point
      : { ...point, saldoProjetado: point.saldoProjetado + delta * index },
  );
}
