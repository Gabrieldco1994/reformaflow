"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { moneyGlance } from "@/lib/money";
import type { MonthlyEntry, MonthlyOverviewResponse } from "../_types";
import type { DreSaldoAcumuladoRow } from "../../dre/_types";
import { buildMariaStories } from "../_lib/insights";
import type { Eixo } from "./EixoToggle";
import {
  buildComprometimentoFuturo,
  buildSaldoSeries,
  deriveCockpitTop,
  deriveMonth,
  mediaMensalPorTipo,
  saldoProjetado,
} from "./derive";
import { mesLongo } from "./format";
import HeroTimeTravel from "./HeroTimeTravel";
import MariaStories from "./MariaStories";
import MiniHeroCapsule from "./MiniHeroCapsule";
import MobileCockpitAccordion from "./MobileCockpitAccordion";
import MobileConsumptionFlow from "./MobileConsumptionFlow";
import { buildMobileMonthData } from "./mobile-month-data";
import MobileRunway from "./MobileRunway";

type AccordionState = {
  consumption: boolean;
};

const DEFAULT_ACCORDIONS: AccordionState = {
  consumption: false,
};

function isAccordionState(value: unknown): value is AccordionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.consumption === "boolean";
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
  runwayCandidatos,
}: {
  data: MonthlyOverviewResponse;
  monthKey: string;
  entries?: MonthlyEntry[];
  projectId: string;
  eixo: Eixo;
  /** Série anual de saldo acumulado (`dre-overview`) — mesma do `RunwayScenario` desktop. */
  runwaySerie?: DreSaldoAcumuladoRow[];
  /** Candidatos para o sheet "Como fechar no azul?" */
  runwayCandidatos?: import('../../dre/_types').RunwayCandidato[];
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
  const [ritmo, setRitmo] = useState(() => month.ritmoDiario);
  const series = useMemo(
    () => buildSaldoSeries(month, selectedEntries, ritmo),
    [month, selectedEntries, ritmo],
  );
  const projetado = useMemo(() => saldoProjetado(month, ritmo), [month, ritmo]);
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

  const viewingAnotherMonth = monthKey !== data.mesAtual;

  // Inovação #2 (Cenários "E se…?"): delta em centavos aplicado client-side sobre a
  // curva projetada do herói (I3) — nunca sobre os KPIs canônicos (I1). Vive só em
  // estado local, resetado a cada troca de mês (não persiste, ao contrário do
  // disclosure state dos acordeões).
  const [scenarioDelta, setScenarioDelta] = useState(0);
  useEffect(() => {
    setScenarioDelta(0);
  }, [monthKey]);

  // Reset do slider de ritmo a cada troca de mês.
  useEffect(() => {
    setRitmo(month.ritmoDiario);
  }, [monthKey]); // eslint-disable-line react-hooks/exhaustive-deps -- reset intencional só na troca de mês

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

  return (
    <>
      <section
        role="region"
        aria-label="Cockpit mensal mobile"
        data-testid="mobile-month-cockpit"
        data-project-id={projectId}
        className="pessoal-minimal-today min-w-0 space-y-3 md:hidden"
      >
        {/* Herói escuro com "viagem no tempo": absorve o herói canônico e o slider
            diário. A viagem no tempo só aparece no mês corrente. */}
        <HeroTimeTravel
          top={top}
          series={series}
          hoje={month.hoje}
          diasNoMes={month.diasNoMes}
          showTimeTravel={false}
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
            candidatos={runwayCandidatos}
            projectId={projectId}
            ritmo={ritmo}
            ritmoDiario={month.ritmoDiario}
            diasNoMes={month.diasNoMes}
            projetado={projetado}
            onRitmoChange={setRitmo}
          />
        )}

        {/* Entrada para a tela de Despesas (mobile) — o app-despesas é alcançado a
            partir do "Hoje", como no protótipo (não há 4ª aba). */}
        <Link
          href={`/projects/${projectId}/expenses`}
          aria-label="Ver todas as despesas"
          className="minimal-card flex min-h-[44px] items-center justify-between rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] px-4 py-3 text-sm font-semibold text-[var(--ck-text)] shadow-lifeone-card active:scale-[0.99]"
        >
          <span>Ver todas as despesas</span>
          <span aria-hidden>→</span>
        </Link>
        {/* "Maria percebeu" — insights por regra pura (sem IA nesta fase),
            derivados de dados já calculados. */}
        <MariaStories insights={mariaInsights} />

        <MobileCockpitAccordion
          id="mobile-cockpit-consumption"
          title="Consumo"
          open={accordions.consumption}
          onToggle={() => toggleAccordion("consumption")}
        >
          <MobileConsumptionFlow data={consumption} />
        </MobileCockpitAccordion>
      </section>
      {/* Mini-herói cápsula: number canônico do MÊS ATUAL fixo no topo. Renderizada
          FORA da section acima (de propósito): essa section usa `space-y-3`, e o
          Tailwind aplica margin-top a todo filho não-primeiro — inclusive a este,
          que é `position: fixed`. Essa margem somava com o `-translate-y-full` e
          deixava uma faixa de ~12px do capsule (com backdrop-blur) vazando por
          cima do header mesmo com `visible=false` (bug real, não efeito nativo do
          navegador — ver histórico do PR). Fora do space-y-3, a margem não se
          aplica e o `-translate-y-full` esconde 100% do elemento como esperado. */}
      <MiniHeroCapsule
        visible={capsuleVisible}
        value={moneyGlance(currentTop.caixaValor)}
        label={currentTop.caixaReal ? "Caixa hoje" : "Resultado realizado"}
        monthLabel={labelMonth(data.mesAtual)}
        consultingLabel={viewingAnotherMonth ? labelMonth(monthKey) : undefined}
      />
    </>
  );
}
