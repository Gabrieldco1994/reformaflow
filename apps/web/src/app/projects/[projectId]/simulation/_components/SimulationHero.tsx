'use client';

import { KpiTile } from '@/components/KpiTile';
import { Delta } from '@/components/Delta';
import { moneyGlance } from '@/lib/money';
import { computeSimulationDelta } from '../_lib/hero-delta';

export interface SimulationHeroProps {
  /** `data.kpis.previsaoSaldo` — já calculado pelo backend (`SimulationData.kpis`). */
  previsaoSaldo: number;
  /** `rollingBalance` do último `CashFlowEntry` (saldo REAL projetado, read-only). */
  realProjectedSaldoCents: number | undefined;
}

/**
 * Camada 1 (hero) da Simulação — Fase G: saldo previsto pela simulação ativa
 * em destaque + `Delta` vs o saldo real projetado do fluxo de caixa.
 * Zero motor novo: subtração de dois números já calculados em outro lugar.
 */
export function SimulationHero({ previsaoSaldo, realProjectedSaldoCents }: SimulationHeroProps) {
  const delta = computeSimulationDelta({ previsaoSaldo }, realProjectedSaldoCents);
  return (
    <div role="article" aria-label="Saldo previsto da simulação" className="min-w-0">
      <KpiTile
        variant="hero"
        layer="glance"
        tone={previsaoSaldo >= 0 ? 'positive' : 'negative'}
        label="Saldo previsto (simulação)"
        value={moneyGlance(previsaoSaldo)}
        extra={
          <div className="mt-1 text-sm">
            <Delta value={delta} type="cents" isGood={true} />
            <span className="ml-1 text-lifeone-ink-3">vs. saldo real projetado</span>
          </div>
        }
      />
    </div>
  );
}
