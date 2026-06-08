'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Gauge, ChevronLeft, ChevronRight } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import type { MonthlyOverviewResponse } from './_types';
import { mesLongo } from './_cockpit/format';
import { COCKPIT_THEME } from './_cockpit/ui';
import { anosDisponiveis } from './_cockpit/derive';
import CockpitTop from './_cockpit/CockpitTop';
import MonthView from './_cockpit/MonthView';
import YearView from './_cockpit/YearView';

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
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<MonthlyOverviewResponse>({
    queryKey: ['monthly-overview', projectId],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview`),
    enabled: !!projectId,
  });

  if (projectType && projectType !== 'PESSOAL') {
    return (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-6 text-center">
        <p className="text-sm text-darc-velvet">
          O cockpit financeiro está disponível apenas para projetos do tipo <strong>Pessoal</strong>.
        </p>
      </div>
    );
  }

  // Meses disponíveis (ordenados) para navegação na visão "Mês".
  const mesesDisponiveis = data ? data.meses.map((r) => r.mes).sort() : [];
  const monthKey = selectedMonth ?? data?.mesAtual ?? '';
  const [yearStr, monthStr] = monthKey.split('-');
  const monthYear = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
  const month0 = monthStr ? parseInt(monthStr, 10) - 1 : new Date().getMonth();
  const minMes = mesesDisponiveis[0] ?? monthKey;
  const maxMes = mesesDisponiveis[mesesDisponiveis.length - 1] ?? monthKey;

  const monthEntries = data?.entries
    ? data.entries.filter((e) => (e.data ?? '').slice(0, 7) === monthKey)
    : undefined;

  const anos = data ? anosDisponiveis(data) : [monthYear];
  const year = selectedYear ?? monthYear;

  return (
    <div
      style={COCKPIT_THEME}
      className="rounded-[22px] bg-[var(--ck-bg)] text-[var(--ck-text)] p-4 md:p-6 border border-[var(--ck-border)] shadow-[0_20px_60px_rgba(0,0,0,.35)]"
    >
      <header className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--ck-surface-2)] border border-[var(--ck-border)] grid place-items-center">
            <Gauge className="w-5 h-5 text-[var(--ck-accent)]" />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--ck-muted)]">Cockpit financeiro</p>
            <h1 className="font-display text-xl md:text-2xl text-[var(--ck-text)] leading-tight">
              {view === 'mes'
                ? data
                  ? `${mesLongo(month0)} ${monthYear}`
                  : 'Visão do mês'
                : `Ano ${year}`}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {view === 'mes' && data && (
            <div className="inline-flex items-center gap-1 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-1">
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
              className="bg-[var(--ck-surface-2)] border border-[var(--ck-border)] text-[var(--ck-text)] text-xs rounded-lg px-2 py-1.5 outline-none"
            >
              {anos.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          )}
          <div className="inline-flex rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-1">
            {(['mes', 'ano'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  view === v ? 'bg-[var(--ck-accent)] text-[#06121a]' : 'text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
                }`}
              >
                {v === 'mes' ? 'Mês' : 'Ano'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {data && !isLoading && <CockpitTop data={data} />}

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

      {data && !isLoading && (
        view === 'mes'
          ? <MonthView key={monthKey} data={data} monthKey={monthKey} entries={monthEntries} />
          : <YearView data={data} year={year} />
      )}
    </div>
  );
}
