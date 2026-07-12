/**
 * Delta hero da Simulação (Fase G) — compara o saldo previsto pela SIMULAÇÃO
 * ativa (`data.kpis.previsaoSaldo`, já calculado pelo backend) com o saldo
 * REAL projetado do fluxo de caixa (`rollingBalance` do último `CashFlowEntry`,
 * já lido em `MonthlyProjection.tsx` como "read-only — never modifies real data").
 *
 * Zero motor novo: é apenas a subtração de dois números já existentes.
 * Positivo = a simulação fica melhor que o real projetado.
 */
export function computeSimulationDelta(
  data: { previsaoSaldo: number },
  realProjectedSaldoCents: number | undefined,
): number {
  const real = realProjectedSaldoCents ?? 0;
  return data.previsaoSaldo - real;
}
