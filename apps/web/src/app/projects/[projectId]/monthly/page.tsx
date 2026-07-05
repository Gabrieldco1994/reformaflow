'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Gauge, ChevronLeft, ChevronRight } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import type { MonthlyOverviewResponse } from './_types';
import { mesLongo } from './_cockpit/format';
import { COCKPIT_THEME } from './_cockpit/ui';
import { anosDisponiveis, buildCaixaData } from './_cockpit/derive';
import CockpitTop from './_cockpit/CockpitTop';
import MonthView from './_cockpit/MonthView';
import MovimentoMes from './_cockpit/MovimentoMes';
import ExtratoGeral from './_cockpit/ExtratoGeral';
import YearView from './_cockpit/YearView';
import EixoToggle, { type Eixo } from './_cockpit/EixoToggle';
import SaldosWidget from './_cockpit/SaldosWidget';

type View = 'mes' | 'ano';

function addMonthKey(key: string, delta: number): string {
  const [y, m] = key.split('-').map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default function CockpitPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { projectType } = useProject();
  const [view, setView] = useState<View>('mes');
  const [eixo, setEixo] = useState<Eixo>('competencia');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('cockpit-eixo');
    if (saved === 'competencia' || saved === 'caixa' || saved === 'geral') setEixo(saved);
  }, []);

  const changeEixo = (e: Eixo) => {
    setEixo(e);
    if (typeof window !== 'undefined') window.localStorage.setItem('cockpit-eixo', e);
  };

  const { data, isLoading, error } = useQuery<MonthlyOverviewResponse>({
    queryKey: ['monthly-overview', projectId],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview`),
    enabled: !!projectId,
  });

  if (projectType && projectType !== 'PESSOAL') {
    return (
      <div className="rounded-2xl bg-lifeone-card shadow-lifeone-card border border-lifeone-hairline p-6 text-center">
        <p className="text-sm text-lifeone-ink">
          O cockpit financeiro está disponível apenas para projetos do tipo <strong>Pessoal</strong>.
        </p>
      </div>
    );
  }

  // Eixo de tempo: competência (default) ou caixa (vencimento da fatura).
  const viewData = data ? (eixo === 'caixa' ? buildCaixaData(data) : data) : undefined;

  // Meses disponíveis (ordenados) para navegação na visão "Mês".
  const mesesDisponiveis = viewData ? viewData.meses.map((r) => r.mes).sort() : [];
  const monthKey = selectedMonth ?? viewData?.mesAtual ?? '';
  const [yearStr, monthStr] = monthKey.split('-');
  const monthYear = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
  const month0 = monthStr ? parseInt(monthStr, 10) - 1 : new Date().getMonth();
  const minMes = mesesDisponiveis[0] ?? monthKey;
  const maxMes = mesesDisponiveis[mesesDisponiveis.length - 1] ?? monthKey;

  const monthEntries = viewData?.entries
    ? viewData.entries.filter((e) => (e.data ?? '').slice(0, 7) === monthKey)
    : undefined;

  const anos = viewData ? anosDisponiveis(viewData) : [monthYear];
  const year = selectedYear ?? monthYear;

  return (
    <div
      style={COCKPIT_THEME}
      className="rounded-[22px] bg-[var(--ck-bg)] text-[var(--ck-text)] p-4 md:p-6 border border-[var(--ck-border)] shadow-lifeone-card"
    >
      <header className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--ck-surface-2)] border border-[var(--ck-border)] grid place-items-center">
            <Gauge className="w-5 h-5 text-[var(--ck-accent)]" />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--ck-muted)]">Cockpit financeiro</p>
            <h1
              className="font-geist not-italic text-xl md:text-2xl text-[var(--ck-text)] leading-tight"
              style={{ fontFamily: "'Geist', var(--font-sans), system-ui, sans-serif", fontStyle: 'normal' }}
            >
              {view === 'mes'
                ? data
                  ? `${mesLongo(month0)} ${monthYear}`
                  : 'Visão do mês'
                : `Ano ${year}`}
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {view === 'mes' && data && (
            <div className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-1">
              <button
                type="button"
                aria-label="Mês anterior"
                disabled={monthKey <= minMes}
                onClick={() => setSelectedMonth(addMonthKey(monthKey, -1))}
                className="p-1.5 rounded-lg text-[var(--ck-muted)] enabled:hover:text-[var(--ck-text)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {monthKey !== data.mesAtual && (
                <button
                  type="button"
                  onClick={() => setSelectedMonth(null)}
                  className="px-2 text-[11px] text-[var(--ck-accent)] hover:underline"
                >
                  hoje
                </button>
              )}
              <button
                type="button"
                aria-label="Próximo mês"
                disabled={monthKey >= maxMes}
                onClick={() => setSelectedMonth(addMonthKey(monthKey, 1))}
                className="p-1.5 rounded-lg text-[var(--ck-muted)] enabled:hover:text-[var(--ck-text)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
          {view === 'ano' && anos.length > 1 && (
            <select
              value={year}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              className="bg-[var(--ck-surface-2)] border border-[var(--ck-border)] text-[var(--ck-text)] text-xs rounded-lg px-2 py-1.5 outline-none shrink-0"
            >
              {anos.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          )}
          <div className="inline-flex shrink-0 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-1">
            {(['mes', 'ano'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  view === v ? 'bg-[var(--ck-accent)] text-[#FFFFFF]' : 'text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
                }`}
              >
                {v === 'mes' ? 'Mês' : 'Ano'}
              </button>
            ))}
          </div>
          {data && <EixoToggle eixo={eixo} onChange={changeEixo} />}
        </div>
      </header>

      {viewData && !isLoading && view === 'mes' && (
        <CockpitTop
          data={viewData}
          monthKey={monthKey}
          entries={monthEntries}
          showRecs={view === 'mes'}
        />
      )}

      {viewData && !isLoading && view === 'mes' && eixo !== 'geral' && (
        <>
          <MovimentoMes data={viewData} monthKey={monthKey} entries={monthEntries} />
          <SaldosWidget projectId={projectId} entries={monthEntries ?? []} eixo={eixo} />
        </>
      )}

      {isLoading && (
        <div className="space-y-4 animate-pulse">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 rounded-[18px] bg-[var(--ck-surface-2)]" />
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

      {viewData && !isLoading && (
        view === 'mes'
          ? eixo === 'geral'
            ? <ExtratoGeral key={`geral-${monthKey}`} entries={viewData.entries ?? []} monthKey={monthKey} year={monthYear} />
            : <MonthView key={`${eixo}-${monthKey}`} data={viewData} monthKey={monthKey} entries={monthEntries} projectId={projectId} eixo={eixo} />
          : <YearView data={viewData} year={year} projectId={projectId} eixo={eixo} />
      )}
    </div>
  );
}
