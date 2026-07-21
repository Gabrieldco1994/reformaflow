"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, SlidersHorizontal } from "lucide-react";
import { moneyGlance } from "@/lib/money";
import { applyScenario } from "../_lib/scenarios";
import ScenarioChips from "../_components/ScenarioChips";
import type { DreSaldoAcumuladoRow, RunwayCandidato } from "../../dre/_types";
import { mesCurto, mesLongo } from "./format";
import { RunwayActionSheet } from "./RunwayActionSheet";

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
  candidatos,
  projectId,
  ritmo,
  ritmoDiario,
  diasNoMes,
  projetado,
  onRitmoChange,
}: {
  serie: DreSaldoAcumuladoRow[];
  currentMonth: string;
  scenarioDelta: number;
  onScenarioChange: (deltaCentsPerMonth: number) => void;
  candidatos?: RunwayCandidato[];
  projectId?: string;
  /** Valor atual do slider de ritmo diário (centavos/dia). */
  ritmo?: number;
  /** Média histórica de gasto diário (centavos/dia). */
  ritmoDiario?: number;
  /** Dias totais no mês corrente. */
  diasNoMes?: number;
  /** Saldo projetado no fim do mês com o ritmo atual (centavos). */
  projetado?: number;
  /** Callback ao mover o slider de ritmo. */
  onRitmoChange?: (v: number) => void;
}) {
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

  // ponytail: estado local do sheet — só existe quando crossover && projectId
  const [sheetOpen, setSheetOpen] = useState(false);

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

      {/* "Como fechar no azul?" — só quando há crossover e projectId */}
      {crossover && projectId && (
        <>
          <button
            type="button"
            data-testid="runway-action-cta"
            onClick={() => setSheetOpen(true)}
            className="mt-3 flex w-full min-h-[44px] items-center justify-center rounded-2xl border border-[var(--ck-neg)]/40 bg-[var(--ck-neg)]/10 px-4 text-[13px] font-semibold text-[var(--ck-neg)]"
          >
            Como fechar no azul?
          </button>
          {sheetOpen && (
            <RunwayActionSheet
              candidatos={candidatos ?? []}
              piorSaldo={lowest.saldoProjetado}
              piorMes={mesLongo(monthIdx(lowest.mes))}
              projectId={projectId}
              onClose={() => setSheetOpen(false)}
            />
          )}
        </>
      )}

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

      {ritmo !== undefined && ritmoDiario !== undefined && onRitmoChange && (
        <div className="mt-4 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[var(--ck-muted)]">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Ritmo de gasto diário
            </label>
            <span className="font-geist tabular-nums text-sm text-[var(--ck-alert)]">
              {moneyGlance(ritmo)}/dia
            </span>
          </div>
          {/* wrapper garante toque ≥44px (regra 13) sem inflar o slider visualmente */}
          <div className="flex min-h-[44px] items-center">
            <input
              type="range"
              min={0}
              max={Math.max(ritmoDiario * 3, 30000)}
              step={500}
              value={Math.min(ritmo, Math.max(ritmoDiario * 3, 30000))}
              onChange={(e) => onRitmoChange(Number(e.target.value))}
              className="w-full accent-[var(--ck-alert)]"
              aria-label="Simular ritmo de gasto diário"
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--ck-muted)]">
            <span>R$ 0</span>
            <button
              type="button"
              onClick={() => onRitmoChange(ritmoDiario)}
              className="min-h-[44px] min-w-[44px] underline transition-colors hover:text-[var(--ck-text)]"
            >
              média atual ({moneyGlance(ritmoDiario)})
            </button>
            <span>{moneyGlance(Math.max(ritmoDiario * 3, 30000))}</span>
          </div>
          {projetado !== undefined && (
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--ck-border)] pt-3">
              <span className="text-[11px] uppercase tracking-wider text-[var(--ck-muted)]">
                Com esse ritmo, termina o mês com
              </span>
              <span
                className={`font-geist tabular-nums text-lg font-bold ${
                  projetado >= 0 ? "text-[var(--ck-pos)]" : "text-[var(--ck-neg)]"
                }`}
              >
                {moneyGlance(projetado)}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="mt-4">
        <p className="text-sm font-medium text-[var(--ck-muted)]">
          Como fechar no azul?
        </p>
        <div className="mt-2">
          <ScenarioChips selectedDelta={scenarioDelta} onChange={onScenarioChange} />
        </div>
      </div>
    </section>
  );
}
