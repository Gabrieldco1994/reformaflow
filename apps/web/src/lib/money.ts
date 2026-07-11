/**
 * Formatação monetária padronizada do app (valores em centavos).
 *
 * Regra de camada (Fase A — Design System):
 * - `moneyGlance`  → KPIs de visão geral / heróis: abreviado e legível de relance.
 *   Sem centavos, sinal antes do R$, abrevia para "R$ 205 mil" / "R$ 1,2 mi".
 * - `moneyDetail`  → listas, extratos, edição: precisão com centavos.
 *   Sinal antes do R$: `-R$ 205.062,38`.
 *
 * Aliases antigos (deprecados, mas ainda suportados para migração incremental):
 * - `moneyShort` → `moneyGlance`
 * - `moneyExact` → `moneyDetail`
 */

const nf = (min = 0, max = 0) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max });

/** Glance: abreviado para relance. `-R$ 205 mil`, `R$ 6,4 mil`, `R$ 1,2 mi`, `R$ 990`. */
export function moneyGlance(cents: number): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}R$ ${nf(0, 1).format(abs / 1_000_000)} mi`;
  if (abs >= 10_000) return `${sign}R$ ${nf(0, 0).format(Math.round(abs / 1000))} mil`;
  if (abs >= 1_000) return `${sign}R$ ${nf(0, 1).format(abs / 1000)} mil`;
  return `${sign}R$ ${nf(0, 0).format(Math.round(abs))}`;
}

/** Detail: valor exato com centavos. `-R$ 205.062,38`. */
export function moneyDetail(cents: number): string {
  const v = cents / 100;
  const sign = v < 0 ? '-' : '';
  return `${sign}R$ ${nf(2, 2).format(Math.abs(v))}`;
}

/** @deprecated Use `moneyGlance` instead */
export const moneyShort = moneyGlance;

/** @deprecated Use `moneyDetail` instead */
export const moneyExact = moneyDetail;
