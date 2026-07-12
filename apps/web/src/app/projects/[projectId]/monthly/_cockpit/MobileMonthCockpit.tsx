"use client";

import { useEffect, useMemo, useState } from "react";
import { moneyGlance } from "@/lib/money";
import type { MonthlyEntry, MonthlyOverviewResponse } from "../_types";
import { buildMariaStories } from "../_lib/insights";
import ScenarioChips from "../_components/ScenarioChips";
import SwipeToPay from "../_components/SwipeToPay";
import type { Eixo } from "./EixoToggle";
import {
  buildComprometimentoFuturo,
  buildSaldoSeries,
  deriveCockpitTop,
  deriveMonth,
  mediaMensalPorTipo,
} from "./derive";
import { mesLongo } from "./format";
import HeroTimeTravel from "./HeroTimeTravel";
import MariaStories from "./MariaStories";
import MiniHeroCapsule from "./MiniHeroCapsule";
import MobileCockpitAccordion from "./MobileCockpitAccordion";
import MobileConsumptionFlow from "./MobileConsumptionFlow";
import MobileMonthDetails from "./MobileMonthDetails";
import { buildMobileMonthData } from "./mobile-month-data";
import SankeyParaOndeFoi from "./SankeyParaOndeFoi";

type AccordionState = {
  consumption: boolean;
  details: boolean;
};

const DEFAULT_ACCORDIONS: AccordionState = {
  consumption: true,
  details: false,
};

function isAccordionState(value: unknown): value is AccordionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.consumption === "boolean" &&
    typeof state.details === "boolean"
  );
}

/** Limiar de rolagem (px) a partir do qual a cápsula-resumo aparece fixa no topo. */
const CAPSULE_SCROLL_THRESHOLD = 240;

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
  const top = useMemo(() => deriveCockpitTop(data, monthKey), [data, monthKey]);
  const currentTop = useMemo(
    () => deriveCockpitTop(data, data.mesAtual),
    [data],
  );
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
  const [accordions, setAccordions] =
    useState<AccordionState>(DEFAULT_ACCORDIONS);
  const [hydratedAccordionKey, setHydratedAccordionKey] = useState<
    string | null
  >(null);
  const accordionStorageKey = `lifeone:monthly:accordions:${projectId}:${monthKey}`;

  useEffect(() => {
    let next = DEFAULT_ACCORDIONS;
    try {
      const stored = window.localStorage.getItem(accordionStorageKey);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (isAccordionState(parsed)) next = parsed;
      }
    } catch {
      // Storage can be unavailable; the disclosure state still works in memory.
    }
    setAccordions(next);
    setHydratedAccordionKey(accordionStorageKey);
  }, [accordionStorageKey]);

  useEffect(() => {
    if (hydratedAccordionKey !== accordionStorageKey) return;
    try {
      window.localStorage.setItem(
        accordionStorageKey,
        JSON.stringify(accordions),
      );
    } catch {
      // Keep the current in-memory state when persistence is unavailable.
    }
  }, [accordionStorageKey, accordions, hydratedAccordionKey]);

  const toggleAccordion = (key: keyof AccordionState) => {
    setAccordions((current) => ({ ...current, [key]: !current[key] }));
  };

  const isCurrentMonth = monthKey === data.mesAtual;
  const isFutureMonth = monthKey > data.mesAtual;
  const viewingAnotherMonth = monthKey !== data.mesAtual;

  // Inovação #2 (Cenários "E se…?"): delta em centavos aplicado client-side sobre a
  // curva projetada do herói (I3) — nunca sobre os KPIs canônicos (I1). Vive só em
  // estado local, resetado a cada troca de mês (não persiste, ao contrário do
  // disclosure state dos acordeões).
  const [scenarioDelta, setScenarioDelta] = useState(0);
  useEffect(() => {
    setScenarioDelta(0);
  }, [monthKey]);

  // Inovação #5 (Mini-herói cápsula): puramente presentacional — a detecção de
  // rolagem vive aqui, o componente só decide o que renderizar a partir de `visible`.
  const [capsuleVisible, setCapsuleVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      setCapsuleVisible(window.scrollY > CAPSULE_SCROLL_THRESHOLD);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Inovação #6 (Maria percebeu): insights por regra pura, zero chamada de IA nesta
  // fase — reaproveita dados já calculados por `deriveMonth`/`buildComprometimentoFuturo`.
  const mediaMensalPorTipoMap = useMemo(
    () =>
      mediaMensalPorTipo(
        data.entries ?? data.mesAtualEntries,
        Number.parseInt(monthKey.slice(0, 4), 10),
      ),
    [data.entries, data.mesAtualEntries, monthKey],
  );
  const comprometimento = useMemo(
    () => buildComprometimentoFuturo(data, monthKey, 12, projectId),
    [data, monthKey, projectId],
  );
  const mariaInsights = useMemo(
    () =>
      buildMariaStories({
        categorias: month.categorias,
        mediaMensalPorTipo: mediaMensalPorTipoMap,
        comprometimento,
      }),
    [month.categorias, mediaMensalPorTipoMap, comprometimento],
  );

  // Inovação #4 (Deslizar-para-pagar): só despesas ainda não realizadas entram na
  // lista — mês futuro permanece somente leitura (mesma regra da nota "incompleto").
  const swipeEntries = useMemo(
    () =>
      isFutureMonth
        ? []
        : selectedEntries.filter(
            (entry) =>
              entry.tipo === "DESPESA" &&
              entry.status !== "PAGO" &&
              entry.status !== "EM_CAIXA",
          ),
    [isFutureMonth, selectedEntries],
  );

  return (
    <section
      role="region"
      aria-label="Cockpit mensal mobile"
      data-testid="mobile-month-cockpit"
      data-project-id={projectId}
      className="min-w-0 space-y-3 md:hidden"
    >
      <p className="text-sm font-medium text-[var(--ck-muted)]">
        Leitura {AXIS_LABEL[eixo]} · valores canônicos de {labelMonth(monthKey)}
      </p>

      {/* Inovação #1: herói escuro com "viagem no tempo" — absorve o herói canônico
          (I1 preservado) e o slider diário que antes vivia dentro do acordeão "Ritmo
          do mês". Só oferece a viagem no tempo no mês corrente. */}
      <HeroTimeTravel
        top={top}
        series={series}
        hoje={month.hoje}
        diasNoMes={month.diasNoMes}
        showTimeTravel={isCurrentMonth && series.length > 0}
        scenarioDelta={scenarioDelta}
      />

      {/* Inovação #2: cenários "E se…?" — chips controlados que deformam ao vivo a
          curva projetada mostrada acima (função pura `applyScenario`), nunca o
          headline canônico. Só faz sentido enquanto há viagem no tempo ativa. */}
      {isCurrentMonth && series.length > 0 && (
        <section
          aria-label="Cenários e se…?"
          className="rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] p-4 shadow-lifeone-card"
        >
          <p className="text-sm font-medium text-[var(--ck-muted)]">
            E se, por dia, eu…
          </p>
          <div className="mt-2">
            <ScenarioChips
              selectedDelta={scenarioDelta}
              onChange={setScenarioDelta}
            />
          </div>
          <p className="mt-2 text-sm text-[var(--ck-muted)]">
            Simulação: desliza a curva projetada do herói acima. Não altera
            nenhum lançamento.
          </p>
        </section>
      )}

      {/* Inovação #6: "Maria percebeu" — insights por regra pura (sem IA nesta
          fase), derivados de dados já calculados. */}
      <MariaStories insights={mariaInsights} />

      {/* Inovação #3: Sankey "Para onde foi" — mesma fonte de `CategoriasBarras`. */}
      <SankeyParaOndeFoi
        categorias={month.categorias}
        entrouTotal={top.entrouMes}
      />

      {/* Inovação #4: deslizar-para-pagar — reusa o endpoint EXISTENTE de marcar
          pago (via `resolveSwipeToPayTarget`/I2, I4); mês futuro fica de fora
          (somente leitura, mesma regra da nota "Mês futuro incompleto"). */}
      {!isFutureMonth && (
        <section
          aria-label="Próximas saídas"
          className="rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] p-4 shadow-lifeone-card"
        >
          <h2 className="text-base font-semibold text-[var(--ck-text)]">
            Próximas saídas
          </h2>
          <p className="mt-1 text-sm text-[var(--ck-muted)]">
            Deslize ou toque para marcar como pago
          </p>
          <div className="mt-3">
            <SwipeToPay entries={swipeEntries} viewingProjectId={projectId} />
          </div>
        </section>
      )}

      <MobileCockpitAccordion
        id="mobile-cockpit-consumption"
        title="Consumo"
        open={accordions.consumption}
        onToggle={() => toggleAccordion("consumption")}
      >
        <MobileConsumptionFlow data={consumption} />
      </MobileCockpitAccordion>
      <MobileCockpitAccordion
        id="mobile-cockpit-details"
        title="Detalhes"
        open={accordions.details}
        onToggle={() => toggleAccordion("details")}
      >
        <MobileMonthDetails month={month} isFutureMonth={isFutureMonth} />
      </MobileCockpitAccordion>

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
            {moneyGlance(currentTop.caixaValor)}
          </p>
          <p className="text-sm text-[var(--ck-muted)]">
            {currentTop.caixaReal ? "caixa hoje" : "resultado realizado"}
          </p>
        </div>
      </aside>

      {/* Inovação #5: mini-herói cápsula — mesmo número canônico da aside acima,
          só que fixo no topo depois que o usuário rola além do herói (I1: nunca
          uma segunda fonte de verdade). */}
      <MiniHeroCapsule
        visible={capsuleVisible}
        value={moneyGlance(currentTop.caixaValor)}
        label={currentTop.caixaReal ? "Caixa hoje" : "Resultado realizado"}
      />
    </section>
  );
}
