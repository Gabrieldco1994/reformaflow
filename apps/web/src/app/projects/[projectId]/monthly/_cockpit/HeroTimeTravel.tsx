"use client";

import { useEffect, useState } from "react";
import { moneyDetail } from "@/lib/money";
import { applyScenario } from "../_lib/scenarios";
import type { CockpitTopDerived, DiaSaldo } from "./derive";
import MobileMonthHero from "./MobileMonthHero";

/**
 * Herói "viagem no tempo" (inovação #1). Absorve o `MobileMonthHero`
 * canônico (byte-idêntico, I1) e acrescenta um slider horizontal que
 * percorre os DIAS do mês — cada posição mostra o caixa projetado daquele
 * dia, com glow verde→vermelho conforme o saldo. Quando um cenário "E se…?"
 * está ativo (`scenarioDelta`), a curva projetada é deformada com a mesma
 * função pura usada pelos chips (`applyScenario`) — o headline canônico
 * nunca é afetado.
 */
export default function HeroTimeTravel({
  top,
  series,
  hoje,
  diasNoMes,
  showTimeTravel,
  scenarioDelta = 0,
}: {
  top: CockpitTopDerived;
  series: DiaSaldo[];
  hoje: number;
  diasNoMes: number;
  showTimeTravel: boolean;
  scenarioDelta?: number;
}) {
  const firstDay = series[0]?.dia ?? 0;
  const lastDay = series[series.length - 1]?.dia ?? diasNoMes;
  const clamp = (day: number) => Math.max(firstDay, Math.min(lastDay, day));
  const [scrubDay, setScrubDay] = useState(() => clamp(hoje));

  useEffect(() => {
    setScrubDay(clamp(hoje));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay, lastDay, hoje, series]);

  // Cenário deforma só a parte PROJETADA (dias futuros) — o realizado é fato
  // consumado, não muda com o "e se". Primeiro dia futuro fica fixo (contrato
  // `applyScenario`), o restante acumula o delta.
  const projectedDays = series.filter((point) => point.dia > hoje);
  const scenarioAdjusted = applyScenario(
    projectedDays.map((point) => ({
      mes: String(point.dia),
      saldoProjetado: point.projetado ?? 0,
    })),
    scenarioDelta,
  );
  const adjustedByDay = new Map(
    scenarioAdjusted.map((point, index) => [
      projectedDays[index]!.dia,
      point.saldoProjetado,
    ]),
  );

  const scrubPoint =
    series.find((point) => point.dia === scrubDay) ?? series[0] ?? null;
  const projected = scrubDay > hoje;
  const scrubValue = projected
    ? (adjustedByDay.get(scrubDay) ?? scrubPoint?.projetado)
    : (scrubPoint?.realizado ?? scrubPoint?.projetado);
  const negative = (scrubValue ?? 0) < 0;

  return (
    <div data-testid="mobile-hero-time-travel" className="space-y-3">
      <MobileMonthHero top={top} />

      {showTimeTravel && series.length > 0 && (
        <section
          aria-label="Viagem no tempo"
          className={`rounded-[18px] border p-4 shadow-lifeone-card transition-colors ${
            negative
              ? "border-[var(--ck-neg)]/50 bg-[var(--ck-neg)]/10"
              : "border-[var(--ck-border)] bg-[var(--ck-surface)]"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[var(--ck-text)]">
                Ritmo do mês
              </h2>
              <p className="mt-1 text-sm text-[var(--ck-muted)]">
                Realizado até hoje · projetado depois
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium text-[var(--ck-muted)]">
                {projected ? "Projetado" : "Realizado"} · dia {scrubDay}
              </p>
              <p
                data-testid="hero-time-travel-value"
                className={`mt-1 font-geist text-base font-bold tabular-nums ${
                  negative ? "text-[var(--ck-neg)]" : "text-[var(--ck-text)]"
                }`}
              >
                {moneyDetail(scrubValue ?? 0)}
              </p>
            </div>
          </div>

          <input
            type="range"
            aria-label="Ritmo diário projetado"
            aria-valuetext={`Dia ${scrubDay}, ${projected ? "projetado" : "realizado"}`}
            min={firstDay}
            max={lastDay}
            step={1}
            value={scrubDay}
            onChange={(event) => {
              const next = Number(event.target.value);
              setScrubDay(clamp(next));
            }}
            className="mt-2 h-11 min-h-[44px] w-full accent-[var(--ck-accent)] text-sm"
          />

          <div className="flex items-center justify-between gap-3 text-sm text-[var(--ck-muted)]">
            <span>Realizado</span>
            <span>Projetado · inclui cartão</span>
          </div>
          <p className="mt-2 text-sm text-[var(--ck-muted)]">
            Simulação somente leitura. Mover o dia não altera caixa, projeção
            ou consumo.
          </p>
        </section>
      )}
    </div>
  );
}
