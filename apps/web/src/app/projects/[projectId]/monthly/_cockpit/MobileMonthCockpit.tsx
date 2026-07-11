"use client";

import { useEffect, useMemo, useState } from "react";
import { moneyDetail, moneyGlance } from "@/lib/money";
import type { MonthlyEntry, MonthlyOverviewResponse } from "../_types";
import type { Eixo } from "./EixoToggle";
import { buildSaldoSeries, deriveCockpitTop, deriveMonth } from "./derive";
import { mesLongo } from "./format";
import MobileConsumptionFlow from "./MobileConsumptionFlow";
import MobileMonthDetails from "./MobileMonthDetails";
import MobileMonthHero from "./MobileMonthHero";
import { buildMobileMonthData } from "./mobile-month-data";

const AXIS_LABEL: Record<Eixo, string> = {
  competencia: "por compra",
  caixa: "por vencimento",
  geral: "extrato",
};

function labelMonth(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  const monthIndex = Number.parseInt(month ?? "1", 10) - 1;
  return `${mesLongo(monthIndex)} ${year ?? ""}`.trim();
}

export default function MobileMonthCockpit({
  data,
  monthKey,
  entries,
  projectId,
  eixo,
}: {
  data: MonthlyOverviewResponse;
  monthKey: string;
  entries?: MonthlyEntry[];
  projectId: string;
  eixo: Eixo;
}) {
  const selectedEntries = useMemo(
    () =>
      entries ??
      data.entries?.filter((entry) => entry.data.slice(0, 7) === monthKey) ??
      data.mesAtualEntries,
    [data.entries, data.mesAtualEntries, entries, monthKey],
  );
  const top = useMemo(() => deriveCockpitTop(data), [data]);
  const month = useMemo(
    () => deriveMonth(data, monthKey, selectedEntries),
    [data, monthKey, selectedEntries],
  );
  const series = useMemo(
    () => buildSaldoSeries(month, selectedEntries, month.ritmoDiario),
    [month, selectedEntries],
  );
  const consumption = useMemo(
    () => buildMobileMonthData(selectedEntries),
    [selectedEntries],
  );
  const [scrubDay, setScrubDay] = useState(month.hoje);

  useEffect(() => {
    const firstDay = series[0]?.dia ?? 0;
    const lastDay = series[series.length - 1]?.dia ?? month.diasNoMes;
    setScrubDay(Math.max(firstDay, Math.min(month.hoje, lastDay)));
  }, [monthKey, month.hoje, month.diasNoMes, series]);

  const scrubPoint =
    series.find((point) => point.dia === scrubDay) ?? series[0] ?? null;
  const projected = scrubDay > month.hoje;
  const scrubValue = projected
    ? scrubPoint?.projetado
    : (scrubPoint?.realizado ?? scrubPoint?.projetado);
  const firstDay = series[0]?.dia ?? 0;
  const lastDay = series[series.length - 1]?.dia ?? month.diasNoMes;
  const isCurrentMonth = monthKey === data.mesAtual;
  const isFutureMonth = monthKey > data.mesAtual;
  const viewingAnotherMonth = monthKey !== data.mesAtual;

  return (
    <section
      role="region"
      aria-label="Cockpit mensal mobile"
      data-testid="mobile-month-cockpit"
      data-project-id={projectId}
      className="min-w-0 space-y-3 md:hidden"
    >
      <p className="text-sm font-medium text-[var(--ck-muted)]">
        Leitura {AXIS_LABEL[eixo]} · valores canônicos do mês atual no topo
      </p>

      <MobileMonthHero top={top} />

      {isCurrentMonth && series.length > 0 && (
        <section
          aria-label="Leitura do ritmo diário"
          className="rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] p-4 shadow-lifeone-card"
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
              <p className="mt-1 font-geist text-base font-bold tabular-nums text-[var(--ck-text)]">
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
              setScrubDay(Math.max(firstDay, Math.min(lastDay, next)));
            }}
            className="mt-2 h-11 min-h-[44px] w-full accent-[var(--ck-accent)] text-sm"
          />

          <div className="flex items-center justify-between gap-3 text-sm text-[var(--ck-muted)]">
            <span>Realizado</span>
            <span>Projetado · inclui cartão</span>
          </div>
          <p className="mt-2 text-sm text-[var(--ck-muted)]">
            Simulação somente leitura. Mover o dia não altera caixa, projeção ou
            consumo.
          </p>
        </section>
      )}

      <MobileConsumptionFlow data={consumption} />
      <MobileMonthDetails month={month} isFutureMonth={isFutureMonth} />

      <aside
        aria-label="Resumo do mês atual"
        data-testid="mobile-month-mini-hero"
        className="sticky bottom-2 z-20 flex min-h-[56px] items-center justify-between gap-3 rounded-2xl border border-[var(--ck-border)] bg-[var(--ck-surface)]/95 px-4 py-2 shadow-lifeone-hover backdrop-blur"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--ck-text)]">
            Mês atual · {labelMonth(data.mesAtual)}
          </p>
          {viewingAnotherMonth && (
            <p className="truncate text-sm text-[var(--ck-muted)]">
              Enquanto você consulta {labelMonth(monthKey)}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="font-geist text-lg font-bold tabular-nums text-[var(--ck-text)]">
            {moneyGlance(top.caixaValor)}
          </p>
          <p className="text-sm text-[var(--ck-muted)]">
            {top.caixaReal ? "caixa hoje" : "resultado realizado"}
          </p>
        </div>
      </aside>
    </section>
  );
}
