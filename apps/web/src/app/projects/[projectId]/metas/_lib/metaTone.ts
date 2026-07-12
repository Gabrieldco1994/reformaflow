/**
 * Tom (cor/label) de uma meta por categoria em função do % de uso do limite.
 *
 * Único ponto de verdade para os limiares `>=80` (Atenção) e `>=100` (Estourou)
 * — extraído de `MetaCategoriaCard.tsx` para evitar dois lugares reimplementando
 * a mesma regra com risco de divergência silenciosa (ex.: `>` em vez de `>=`
 * em um dos dois). `MetaCategoriaCard` e `MetasGlance` importam DESTE arquivo.
 */
export function metaProgressTone(pct: number) {
  if (pct >= 100) return { bar: 'bg-red-600', txt: 'text-red-700', label: 'Estourou' };
  if (pct >= 80) return { bar: 'bg-amber-500', txt: 'text-amber-700', label: 'Atenção' };
  return { bar: 'bg-orange-500', txt: 'text-orange-700', label: 'No limite' };
}
