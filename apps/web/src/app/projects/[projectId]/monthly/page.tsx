"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Gauge, ChevronLeft, ChevronRight, PlusCircle, Compass } from "lucide-react";
import Link from "next/link";
import { useProject } from "@/contexts/project-context";
import { api } from "@/lib/api";
import type { MonthlyOverviewResponse } from "./_types";
import type { DreOverviewResponse } from "../dre/_types";
import type { MetaProgress } from "../metas/_components/MetaCategoriaCard";
import { mesLongo } from "./_cockpit/format";
import { COCKPIT_THEME } from "./_cockpit/ui";
import { anosDisponiveis, buildCaixaData, buildComprometimentoFuturo } from "./_cockpit/derive";
import CockpitTop from "./_cockpit/CockpitTop";
import MonthView from "./_cockpit/MonthView";
import ComprometimentoFuturo from "./_cockpit/ComprometimentoFuturo";
import ExtratoGeral from "./_cockpit/ExtratoGeral";
import YearView from "./_cockpit/YearView";
import EixoToggle, { type Eixo } from "./_cockpit/EixoToggle";
import SaldosWidget from "./_cockpit/SaldosWidget";
import MobileCockpitHeader from "./_cockpit/MobileCockpitHeader";
import MobileMonthCockpit from "./_cockpit/MobileMonthCockpit";
import { PendenciasQueueCard } from "./_cockpit/PendenciasQueueCard";
import { monthlyOverviewPath } from "./_lib/monthly-overview-query";
import { NovaDespesaLauncher } from "../expenses/_components/NovaDespesaLauncher";
import { ProjecaoSaldo } from "../conta/_components/ProjecaoSaldo";

type View = "mes" | "ano";

function addMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function CockpitPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { projectType } = useProject();
  const [view, setView] = useState<View>("mes");
  const [eixo, setEixo] = useState<Eixo>("caixa");
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(() => searchParams.get("mes"));
  const [selectedCardLast4, setSelectedCardLast4] = useState<string | null>(null);
  const [ritmoSimulador, setRitmoSimulador] = useState<number | null>(null);

  const selectMonth = useCallback((month: string | null) => {
    setSelectedMonth(month);
    const next = new URLSearchParams(searchParams.toString());
    if (month) next.set("mes", month);
    else next.delete("mes");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("cockpit-eixo");
    if (saved === "geral") {
      setEixo("geral");
      return;
    }
    if (saved === "competencia" || saved === "caixa") {
      setEixo("caixa");
      return;
    }
  }, []);

  const changeEixo = (e: Eixo) => {
    setEixo(e);
    if (typeof window !== "undefined")
      window.localStorage.setItem("cockpit-eixo", e);
  };

  const { data, isLoading, error } = useQuery<MonthlyOverviewResponse>({
    queryKey: ["monthly-overview", projectId, selectedMonth],
    queryFn: () => api.get(monthlyOverviewPath(projectId, selectedMonth)),
    enabled: !!projectId,
  });

  // DRE mensal para série de runway mobile e progresso de metas.
  // Precisa ficar antes do early-return abaixo (regra dos hooks).
  const overviewMonthKey = selectedMonth ?? data?.mesAtual ?? "";
  const overviewYear =
    selectedYear ??
    (overviewMonthKey ? parseInt(overviewMonthKey.slice(0, 4), 10) : new Date().getFullYear());

  const { data: dreOverview } = useQuery<DreOverviewResponse>({
    queryKey: ["dre-overview", projectId, overviewMonthKey, overviewYear],
    queryFn: () =>
      api.get(
        `/projects/${projectId}/monthly-overview/dre-overview?month=${overviewMonthKey}&year=${overviewYear}`,
      ),
    enabled: !!projectId && !!overviewMonthKey,
  });

  const { data: metasProgress = [] } = useQuery<MetaProgress[]>({
    queryKey: ["category-budgets", "progress", projectId, overviewMonthKey],
    queryFn: () =>
      api.get(`/projects/${projectId}/category-budgets/progress?mes=${overviewMonthKey}`),
    enabled: !!projectId && !!overviewMonthKey,
  });

  if (projectType && projectType !== "PESSOAL") {
    return (
      <div className="rounded-2xl bg-lifeone-card shadow-lifeone-card border border-lifeone-hairline p-6 text-center">
        <p className="text-sm text-lifeone-ink">
          O cockpit financeiro está disponível apenas para projetos do tipo{" "}
          <strong>Pessoal</strong>.
        </p>
      </div>
    );
  }

  // Eixo de tempo: competência (default) ou caixa (vencimento da fatura).
  // Na visão ANO forçamos o eixo de caixa ("Vai sair") e escondemos o toggle —
  // é a leitura correta do ano (quando o dinheiro sai), sem confundir com competência.
  const effectiveEixo: Eixo = view === "ano" ? "caixa" : eixo;
  const viewData = data
    ? effectiveEixo === "caixa"
      ? buildCaixaData(data)
      : data
    : undefined;

  // Meses disponíveis (ordenados) para navegação na visão "Mês".
  const mesesDisponiveis = viewData
    ? viewData.meses.map((r) => r.mes).sort()
    : [];
  const monthKey = selectedMonth ?? viewData?.mesAtual ?? "";
  const [yearStr, monthStr] = monthKey.split("-");
  const monthYear = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
  const month0 = monthStr ? parseInt(monthStr, 10) - 1 : new Date().getMonth();
  const minMes = mesesDisponiveis[0] ?? monthKey;
  const maxMes = mesesDisponiveis[mesesDisponiveis.length - 1] ?? monthKey;

  const monthEntries = viewData?.entries
    ? viewData.entries.filter((e) => (e.data ?? "").slice(0, 7) === monthKey)
    : undefined;
  const comprometimentoRows = viewData
    ? buildComprometimentoFuturo(viewData, monthKey ?? viewData.mesAtual, 12, projectId)
    : [];

  const anos = viewData ? anosDisponiveis(viewData) : [monthYear];
  const year = selectedYear ?? monthYear;

  return (
    <div
      style={COCKPIT_THEME}
      className="pessoal-minimal-cockpit rounded-[22px] bg-[var(--ck-bg)] text-[var(--ck-text)] p-4 md:p-6 border border-[var(--ck-border)] shadow-lifeone-card"
    >
      <div className="md:hidden">
        <MobileCockpitHeader
          projectId={projectId}
          view={view}
          monthKey={monthKey}
          year={year}
          years={anos}
          currentMonth={data?.mesAtual ?? monthKey}
          minMonth={minMes}
          maxMonth={maxMes}
          eixo={eixo}
          onViewChange={setView}
          onPreviousMonth={() => selectMonth(addMonthKey(monthKey, -1))}
          onNextMonth={() => selectMonth(addMonthKey(monthKey, 1))}
          onCurrentMonth={() => selectMonth(null)}
          onYearChange={setSelectedYear}
          onEixoChange={changeEixo}
        />

        {isLoading && (
          <div className="space-y-3 animate-pulse">
            <div className="h-48 rounded-[18px] bg-[var(--ck-surface-2)]" />
            <div className="h-36 rounded-[18px] bg-[var(--ck-surface-2)]" />
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-xl border border-[var(--ck-neg)]/40 bg-[var(--ck-neg)]/10 p-4 text-sm text-[var(--ck-neg)]">
            Não foi possível carregar o cockpit. Tente novamente.
          </div>
        )}

        {viewData &&
          !isLoading &&
          (view === "mes" ? (
            eixo === "geral" ? (
              <ExtratoGeral
                entries={viewData.entries ?? []}
                monthKey={monthKey}
                year={monthYear}
              />
            ) : (
              <>
                <PendenciasQueueCard projectId={projectId} monthKey={monthKey} projectType={projectType} />
                <MobileMonthCockpit
                  data={viewData}
                  monthKey={monthKey}
                  entries={monthEntries ?? []}
                  projectId={projectId}
                  eixo={eixo}
                  runwaySerie={dreOverview?.anual?.saldoAcumuladoSerie}
                  runwayCandidatos={dreOverview?.anual?.candidatos}
                />
              </>
            )
          ) : (
            <YearView
              data={viewData}
              year={year}
              projectId={projectId}
              eixo={effectiveEixo}
            />
          ))}
      </div>

      <div data-testid="desktop-monthly-legacy" className="hidden md:block">
        <header className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--ck-surface-2)] border border-[var(--ck-border)] grid place-items-center">
              <Gauge className="w-5 h-5 text-[var(--ck-accent)]" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--ck-muted)]">
                Cockpit financeiro
              </p>
              <div className="flex items-center gap-2">
                <h1
                  className="font-geist not-italic text-xl md:text-2xl text-[var(--ck-text)] leading-tight"
                  style={{
                    fontFamily:
                      "'Geist', var(--font-sans), system-ui, sans-serif",
                    fontStyle: "normal",
                  }}
                >
                  {view === "mes"
                    ? data
                      ? `${mesLongo(month0)} ${monthYear}`
                      : "Visão do mês"
                    : `Ano ${year}`}
                </h1>
                {view === "mes" && (
                  <div className="inline-flex items-center gap-1">
                    <NovaDespesaLauncher
                      projectId={projectId}
                      projectType={projectType ?? "PESSOAL"}
                      trigger={(open) => (
                        <button
                          type="button"
                          aria-label="Lançar agora"
                          onClick={open}
                          className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface)] text-[var(--ck-accent)] transition-colors hover:bg-[var(--ck-surface-2)]"
                        >
                          <PlusCircle className="h-4 w-4" />
                        </button>
                      )}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link
              href={`/projects/${projectId}/apoio`}
              aria-label="Solicitar apoio"
              title="Solicitar apoio"
              className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface)] text-[var(--ck-accent)] transition-colors hover:bg-[var(--ck-surface-2)]"
            >
              <Compass className="h-4 w-4" />
            </Link>
            {view === "mes" && data && (
              <div className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-1">
                <button
                  type="button"
                  aria-label="Mês anterior"
                  disabled={monthKey <= minMes}
                  onClick={() => selectMonth(addMonthKey(monthKey, -1))}
                  className="p-1.5 rounded-lg text-[var(--ck-muted)] enabled:hover:text-[var(--ck-text)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {monthKey !== data.mesAtual && (
                  <button
                    type="button"
                    onClick={() => selectMonth(null)}
                    className="px-2 text-[11px] text-[var(--ck-accent)] hover:underline"
                  >
                    hoje
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Próximo mês"
                  disabled={monthKey >= maxMes}
                  onClick={() => selectMonth(addMonthKey(monthKey, 1))}
                  className="p-1.5 rounded-lg text-[var(--ck-muted)] enabled:hover:text-[var(--ck-text)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
            {view === "ano" && anos.length > 1 && (
              <select
                value={year}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                className="bg-[var(--ck-surface-2)] border border-[var(--ck-border)] text-[var(--ck-text)] text-xs rounded-lg px-2 py-1.5 outline-none shrink-0"
              >
                {anos.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            )}
            <div className="inline-flex shrink-0 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-1">
              {(["mes", "ano"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    view === v
                      ? "bg-[var(--ck-accent)] text-[#FFFFFF]"
                      : "text-[var(--ck-muted)] hover:text-[var(--ck-text)]"
                  }`}
                >
                  {v === "mes" ? "Mês" : "Ano"}
                </button>
              ))}
            </div>
            {data && view === "mes" && (
              <EixoToggle eixo={eixo} onChange={changeEixo} />
            )}
          </div>
        </header>

        {viewData && !isLoading && view === "mes" && (
          <CockpitTop
            data={viewData}
            monthKey={monthKey}
            entries={monthEntries}
            runwaySerie={dreOverview?.anual?.saldoAcumuladoSerie}
            showRecs={view === "mes"}
          />
        )}

        {viewData && !isLoading && view === "mes" && dreOverview?.anual?.saldoAcumuladoSerie && (
          <div className="mb-5">
            <ProjecaoSaldo
              serie={dreOverview.anual.saldoAcumuladoSerie}
              currentMonth={monthKey}
              simulatedRitmo={ritmoSimulador ?? undefined}
            />
          </div>
        )}

        {viewData && !isLoading && view === "mes" && eixo !== "geral" && (
          <div className="mb-5 grid grid-cols-1 items-stretch gap-4 xl:grid-cols-2">
            <SaldosWidget
              projectId={projectId}
              entries={monthEntries ?? []}
              eixo={eixo}
              selectedCardLast4={selectedCardLast4}
              onSelectCard={setSelectedCardLast4}
              className="h-full"
            />
            <ComprometimentoFuturo
              rows={comprometimentoRows}
              selectedCardLast4={selectedCardLast4}
              onSelectCard={setSelectedCardLast4}
              className="h-full"
            />
          </div>
        )}

        {viewData && !isLoading && view === "mes" && (
          <PendenciasQueueCard projectId={projectId} monthKey={monthKey} projectType={projectType} />
        )}

        {isLoading && (
          <div className="space-y-4 animate-pulse">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-24 rounded-[18px] bg-[var(--ck-surface-2)]"
                />
              ))}
            </div>
            <div className="h-[340px] rounded-[18px] bg-[var(--ck-surface-2)]" />
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-xl border border-[var(--ck-neg)]/40 bg-[var(--ck-neg)]/10 p-4 text-sm text-[var(--ck-neg)]">
            Não foi possível carregar o cockpit. Tente novamente.
          </div>
        )}

        {viewData &&
          !isLoading &&
          (view === "mes" ? (
            eixo === "geral" ? (
              <ExtratoGeral
                key={`geral-${monthKey}`}
                entries={viewData.entries ?? []}
                monthKey={monthKey}
                year={monthYear}
              />
            ) : (
              <MonthView
                key={`${eixo}-${monthKey}`}
                data={viewData}
                monthKey={monthKey}
                entries={monthEntries}
                projectId={projectId}
                eixo={eixo}
                runwaySerie={dreOverview?.anual?.saldoAcumuladoSerie}
                runwayCandidatos={dreOverview?.anual?.candidatos}
                metasProgress={metasProgress}
                ritmoSimulador={ritmoSimulador}
                onRitmoChange={setRitmoSimulador}
              />
            )
          ) : (
            <YearView
              data={viewData}
              year={year}
              projectId={projectId}
              eixo={effectiveEixo}
            />
          ))}
      </div>
    </div>
  );
}
