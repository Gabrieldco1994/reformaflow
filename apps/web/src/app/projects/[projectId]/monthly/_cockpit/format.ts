/** Formatação monetária e helpers do cockpit (valores chegam em centavos). */

export function fmtMoney(cents: number): string {
  const v = Math.round(cents / 100);
  return `R$ ${new Intl.NumberFormat('pt-BR').format(v)}`;
}

/** Versão compacta para eixos de gráfico: R$ 12k / R$ 1,2M (recebe reais, não centavos). */
export function fmtK(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `R$ ${(value / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (abs >= 1_000) return `R$ ${Math.round(value / 1000)}k`;
  return `R$ ${Math.round(value)}`;
}

export function fmtPct(value: number, digits = 0): string {
  return `${value.toFixed(digits).replace('.', ',')}%`;
}

const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MESES_LONGO = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

export function mesCurto(monthIndex0: number): string {
  return MESES_CURTO[monthIndex0] ?? '';
}

export function mesLongo(monthIndex0: number): string {
  return MESES_LONGO[monthIndex0] ?? '';
}
