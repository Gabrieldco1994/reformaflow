import type { MonthlyEntry } from "../_types";
import { buildExtratoDespesas } from "./derive";

export interface MobileMonthCategory {
  label: string;
  valueCents: number;
}

export interface MobileMonthData {
  realizedConsumptionCents: number;
  realizedCategories: MobileMonthCategory[];
  isEmpty: boolean;
}

/**
 * Adapta o extrato canônico para o fluxo de consumo mobile.
 * Mantém apenas consumo realizado; buildExtratoDespesas já remove espelhos e
 * os neutros de settlement e de consumo.
 */
export function buildMobileMonthData(
  entries: MonthlyEntry[],
  options: { topN?: number } = {},
): MobileMonthData {
  const topN = Math.max(0, Math.floor(options.topN ?? 4));
  const realized = buildExtratoDespesas(entries).itens.filter(
    (item) => item.realizado,
  );
  const byCategory = new Map<string, number>();

  for (const item of realized) {
    const label = item.categoria.trim() || "Outros";
    byCategory.set(label, (byCategory.get(label) ?? 0) + item.valor);
  }

  const realizedConsumptionCents = realized.reduce(
    (sum, item) => sum + item.valor,
    0,
  );
  const uncategorized = byCategory.get("Outros") ?? 0;
  byCategory.delete("Outros");

  const sorted = Array.from(byCategory, ([label, valueCents]) => ({
    label,
    valueCents,
  })).sort((a, b) => {
    if (b.valueCents !== a.valueCents) return b.valueCents - a.valueCents;
    if (a.label === b.label) return 0;
    return a.label < b.label ? 1 : -1;
  });

  const realizedCategories = sorted.slice(0, topN);
  const otherCents = sorted
    .slice(topN)
    .reduce((sum, item) => sum + item.valueCents, uncategorized);
  if (otherCents > 0) {
    realizedCategories.push({ label: "Outros", valueCents: otherCents });
  }

  return {
    realizedConsumptionCents,
    realizedCategories,
    isEmpty: realizedConsumptionCents === 0,
  };
}
