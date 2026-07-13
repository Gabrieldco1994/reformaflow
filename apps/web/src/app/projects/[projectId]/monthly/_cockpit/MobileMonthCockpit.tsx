"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { moneyGlance } from "@/lib/money";
import type { MonthlyEntry, MonthlyOverviewResponse } from "../_types";
import type { DreSaldoAcumuladoRow } from "../../dre/_types";
import { buildMariaStories } from "../_lib/insights";
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
import MobileRunway from "./MobileRunway";
import SankeyParaOndeFoi from "./SankeyParaOndeFoi";

type AccordionState = {
  consumption: boolean;
  details: boolean;
};

const DEFAULT_ACCORDIONS: AccordionState = {
  consumption: false,
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
  runwaySerie,
}: {
  data: MonthlyOverviewResponse;
  monthKey: string;
  entries?: MonthlyEntry[];
  projectId: string;
  eixo: Eixo;
  /** Série anual de saldo acumulado (`dre-overview`) — mesma do `RunwayScenario` desktop. */
  runwaySerie?: DreSaldoAcumuladoRow[];
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

  // Inovação #5 (Mini-herói cápsula): no mês corrente a cápsula surge por
  // rolagem; ao consultar OUTRO mês fica sempre visível para não perder o caixa
  // de hoje de vista. Puramente presentacional — só decide `visible`.
  const [scrolledPastHero, setScrolledPastHero] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      setScrolledPastHero(window.scrollY > CAPSULE_SCROLL_THRESHOLD);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const capsuleVisible = viewingAnotherMonth || scrolledPastHero;

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
      {/* Herói escuro com "viagem no tempo": absorve o herói canônico e o slider
          diário. A viagem no tempo só aparece no mês corrente. */}
      <HeroTimeTravel
        top={top}
        series={series}
        hoje={month.hoje}
        diasNoMes={month.diasNoMes}
        showTimeTravel={isCurrentMonth && series.length > 0}
        scenarioDelta={scenarioDelta}
      />

      {/* "Vai dar até dez?": veredito + curva de 6 meses + cenários "E se…?"
          integrados. Os chips deformam ao vivo a curva projetada do herói acima
          (mesmo scenarioDelta), nunca o headline canônico. */}
      {runwaySerie && (
        <MobileRunway
          serie={runwaySerie}
          currentMonth={monthKey}
          scenarioDelta={scenarioDelta}
          onScenarioChange={setScenarioDelta}
        />
      )}

      {/* Sankey "Para onde foi" — mesma fonte de CategoriasBarras. */}
      <SankeyParaOndeFoi
        categorias={month.categorias}
        entrouTotal={top.entrouMes}
      />

      {/* Entrada para a tela de Despesas (mobile) — o app-despesas é alcançado a
          partir do "Hoje", como no protótipo (não há 4ª aba). */}
      <Link
        href={`/projects/${projectId}/expenses`}
        aria-label="Ver todas as despesas"
        className="flex min-h-[44px] items-center justify-between rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] px-4 py-3 text-sm font-semibold text-[var(--ck-text)] shadow-lifeone-card active:scale-[0.99]"
      >
        <span>Ver todas as despesas</span>
        <span aria-hidden>→</span>
      </Link>

      {/* "Maria percebeu" — insights por regra pura (sem IA nesta fase),
          derivados de dados já calculados. */}
      <MariaStories insights={mariaInsights} />

      {/* Deslizar-para-pagar — reusa o endpoint existente de marcar pago; mês
          futuro fica de fora (somente leitura, regra da nota "Mês futuro incompleto"). */}
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

      {/* Mini-herói cápsula: número canônico do MÊS ATUAL fixo no topo. No mês
          corrente surge por rolagem; ao consultar outro mês fica sempre visível e
          carrega o aviso "consultando <mês>" (papel da antiga aside, removida). */}
      <MiniHeroCapsule
        visible={capsuleVisible}
        value={moneyGlance(currentTop.caixaValor)}
        label={currentTop.caixaReal ? "Caixa hoje" : "Resultado realizado"}
        monthLabel={labelMonth(data.mesAtual)}
        consultingLabel={viewingAnotherMonth ? labelMonth(monthKey) : undefined}
      />
    </section>
  );
}
