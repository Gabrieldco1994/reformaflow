/**
 * Conciliação cross-project por parcela — funções puras (single source of truth).
 *
 * Quando uma despesa importada (PESSOAL, cartão/conta) liquida UMA parcela de
 * uma despesa planejada em outro projeto (REFORMA/CASA/CARRO), o valor REAL da
 * fatura substitui o planejado **somente naquela parcela**. O planejado é
 * preservado como snapshot (em `CrossProjectSettlement.plannedValor`) para que o
 * unlink seja totalmente reversível.
 *
 * Invariante (§0.7): nenhum cálculo local novo — todas as telas/serviços que
 * precisam do "valor efetivo" de um alvo conciliado devem usar
 * `effectiveValorTotal` daqui, e nunca recomputar a fórmula.
 */

export interface SettlementDelta {
  /** Valor real pago na parcela (centavos). */
  realValor: number;
  /** Valor planejado original da parcela (centavos) — snapshot. */
  plannedValor: number;
}

/**
 * Normaliza o JSON de parcelas pagas: aceita só inteiros no range [0, n),
 * sem duplicados, ordenados. Nunca confia no formato bruto vindo do banco/cliente.
 */
export function parsePaidParcelas(raw: string | null | undefined, n: number): number[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const set = new Set<number>();
  for (const v of parsed) {
    const i = Number(v);
    if (Number.isInteger(i) && i >= 0 && i < n) set.add(i);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * Soma das diferenças (real − planejado) das liquidações de um alvo.
 * É o ajuste que o valor real impõe sobre o planejado.
 */
export function sumSettlementDeltas(settlements: SettlementDelta[]): number {
  let acc = 0;
  for (const s of settlements) acc += s.realValor - s.plannedValor;
  return acc;
}

/**
 * Valor efetivo (real) do total de uma despesa alvo conciliada:
 * planejado original + ajuste das parcelas liquidadas pelo valor real.
 *
 * Não-circular: `plannedValorTotal` é o `Expense.valorTotal` (imutável,
 * sempre o planejado). As liquidações carregam o snapshot do planejado por
 * parcela, então `real − planned` isola exatamente o ajuste.
 */
export function effectiveValorTotal(
  plannedValorTotal: number,
  settlements: SettlementDelta[],
): number {
  return plannedValorTotal + sumSettlementDeltas(settlements);
}

/**
 * Aplica overrides de valor por índice de parcela sobre o array de valores
 * planejados, retornando um NOVO array (não muta a entrada). Índices fora do
 * range são ignorados.
 */
export function applyParcelaOverrides(
  plannedValues: number[],
  overrides: Record<number, number> | Map<number, number>,
): number[] {
  const get = (idx: number): number | undefined => {
    if (overrides instanceof Map) return overrides.get(idx);
    return Object.prototype.hasOwnProperty.call(overrides, idx) ? overrides[idx] : undefined;
  };
  return plannedValues.map((v, idx) => {
    const o = get(idx);
    return o === undefined ? v : o;
  });
}
