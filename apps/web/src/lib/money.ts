/**
 * Formatação monetária padronizada do app (valores em centavos).
 *
 * Regra de camada (ver docs/analise-ux-mobile.md §3):
 * - `moneyShort`  → KPIs de visão geral / heróis: abreviado e legível de relance.
 * - `moneyExact`  → listas, extratos, edição: precisão com centavos.
 *
 * Sinal SEMPRE antes do "R$" (ex.: `-R$ 205 mil`), consistente em todo o app.
 */

const nf = (min = 0, max = 0) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max });

/** Abreviado para relance: `-R$ 205 mil`, `R$ 6,4 mil`, `R$ 1,2 mi`, `R$ 990`. */
export function moneyShort(cents: number): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}R$ ${nf(0, 1).format(abs / 1_000_000)} mi`;
  if (abs >= 10_000) return `${sign}R$ ${nf(0, 0).format(Math.round(abs / 1000))} mil`;
  if (abs >= 1_000) return `${sign}R$ ${nf(0, 1).format(abs / 1000)} mil`;
  return `${sign}R$ ${nf(0, 0).format(Math.round(abs))}`;
}

/** Valor exato com centavos, sinal antes do R$: `-R$ 205.062,38`. */
export function moneyExact(cents: number): string {
  const v = cents / 100;
  const sign = v < 0 ? '-' : '';
  return `${sign}R$ ${nf(2, 2).format(Math.abs(v))}`;
}
