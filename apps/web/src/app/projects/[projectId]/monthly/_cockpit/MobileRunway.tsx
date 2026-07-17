"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { moneyGlance } from "@/lib/money";
import { applyScenario } from "../_lib/scenarios";
import ScenarioChips from "../_components/ScenarioChips";
import type { DreSaldoAcumuladoRow } from "../../dre/_types";
import { mesCurto, mesLongo } from "./format";

/**
 * "Vai dar até dez?" mobile (fidelidade v3): veredito verde/vermelho + curva de
 * 6 meses + cenários "E se…?" integrados, compactos como no protótipo c3.
 *
 * Puramente apresentacional: reusa a MESMA série `runwaySerie` (dre-overview,
 * eixo caixa §10) que o `RunwayScenario` desktop já recebe e a função pura
 * `applyScenario` dos chips — não busca nem recalcula nada, nunca toca
 * `derive.ts`. O `scenarioDelta` vive no pai (deforma também a curva do herói).
 */
const monthIdx = (mes: string) => Number.parseInt(mes.slice(5, 7), 10) - 1;
const compact = (cents: number) => moneyGlance(cents).replace("R$ ", "");

export default function MobileRunway({
  serie,
  currentMonth,
  scenarioDelta,
  onScenarioChange,
}: {
  serie: DreSaldoAcumuladoRow[];
  currentMonth: string;
  scenarioDelta: number;
  onScenarioChange: (deltaCentsPerMonth: number) => void;
}) {
  // Mesmo recorte do `ProjecaoSaldo`: âncora no mês corrente, olhando adiante.
  const forward = serie.filter((row) => row.mes >= currentMonth);
  if (forward.length < 6) return null;

  const deformed = applyScenario(forward, scenarioDelta);
  const crossover = deformed.find((row) => row.saldoProjetado < 0) ?? null;
  const lowest = deformed.reduce(
    (min, row) => (row.saldoProjetado < min.saldoProjetado ? row : min),
    deformed[0],
  );
  const last = deformed[deformed.length - 1];

  const values = deformed.map((row) => row.saldoProjetado);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const W = 320;
  const H = 108;
  const padX = 6;
  const padTop = 8;
  const padBot = 8;
  const x = (i: number) => padX + (i / (values.length - 1)) * (W - padX * 2);
  const y = (v: number) => padTop + (1 - (v - min) / span) * (H - padTop - padBot);
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(values.length - 1).toFixed(1)},${y(min).toFixed(1)} L${x(0).toFixed(1)},${y(min).toFixed(1)} Z`;
  const tone = crossover ? "var(--ck-neg)" : "var(--ck-pos)";

  return (
    <section
      aria-label="Vai dar até dez?"
      className="minimal-card rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] p-4 shadow-lifeone-card"
    >
      <h2 className="text-base font-semibold text-[var(--ck-text)]">
        Vai dar até {mesCurto(monthIdx(last.mes))}?
      </h2>

      <div
        className={`mt-3 flex items-start gap-2.5 rounded-2xl border px-3.5 py-3 ${
          crossover
            ? "border-[var(--ck-neg)]/40 bg-[var(--ck-neg)]/10"
            : "border-[var(--ck-pos)]/40 bg-[var(--ck-pos)]/10"
        }`}
      >
        {crossover ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ck-neg)]" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ck-pos)]" />
        )}
        <div className="min-w-0 leading-snug">
          <p
            className={`text-[15px] font-bold ${
              crossover ? "text-[var(--ck-neg)]" : "text-[var(--ck-pos)]"
            }`}
          >
            {crossover
              ? `No ritmo atual, fica negativo em ${mesLongo(monthIdx(crossover.mes))}.`
              : `O saldo se mantém positivo até ${mesLongo(monthIdx(last.mes))}.`}
          </p>
          <p className="mt-0.5 text-[13px] text-[var(--ck-muted)]">
            Menor ponto: {moneyGlance(lowest.saldoProjetado)} em{" "}
            {mesLongo(monthIdx(lowest.mes))}.
          </p>
        </div>
      </div>

      <div className="relative mt-3">
        <span
          data-testid="scenario-delta"
          className={`absolute right-1 top-1 z-10 rounded-full bg-[var(--ck-surface-2)] px-2.5 py-0.5 text-[13px] font-bold tabular-nums text-[var(--ck-text)] shadow-lifeone-card transition-opacity ${
            scenarioDelta !== 0 ? "opacity-100" : "opacity-0"
          }`}
        >
          {scenarioDelta !== 0 ? `${moneyGlance(scenarioDelta)}/mês` : ""}
        </span>
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-[92px] w-full"
        >
          {min < 0 && (
            <line
              x1={padX}
              x2={W - padX}
              y1={y(0)}
              y2={y(0)}
              stroke="var(--ck-neg)"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.5}
            />
          )}
          <path d={area} fill={tone} opacity={0.12} />
          <path
            d={line}
            fill="none"
            stroke={tone}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className="mt-3 flex snap-x gap-2 overflow-x-auto pb-1">
        {deformed.map((row) => {
          const neg = row.saldoProjetado < 0;
          return (
            <div
              key={row.mes}
              data-testid={`runway-month-${row.mes}`}
              className={`min-w-[84px] snap-start rounded-lg border px-2 py-1.5 text-center ${
                neg
                  ? "border-[var(--ck-neg)]/40 bg-[var(--ck-neg)]/10"
                  : "border-[var(--ck-border)] bg-[var(--ck-surface-2)]"
              }`}
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ck-muted)]">
                {mesCurto(monthIdx(row.mes))}
              </p>
              <p
                className={`mt-0.5 font-geist text-[15px] font-bold tabular-nums ${
                  neg ? "text-[var(--ck-neg)]" : "text-[var(--ck-text)]"
                }`}
              >
                {compact(row.saldoProjetado)}
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-4">
        <p className="text-sm font-medium text-[var(--ck-muted)]">
          E se, por mês, eu…
        </p>
        <div className="mt-2">
          <ScenarioChips selectedDelta={scenarioDelta} onChange={onScenarioChange} />
        </div>
      </div>
    </section>
  );
}
