'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { DreMensalView, type DreEixoMensal } from './_components/DreMensalView';
import { DreAnualView, type DreAnualChartMode } from './_components/DreAnualView';
import type { DreOverviewResponse } from './_types';

type Periodo = 'mensal' | 'anual';

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function addMonthKey(key: string, delta: number) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLong(key: string) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export default function DrePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { projectType } = useProject();

  const [periodo, setPeriodo] = useState<Periodo>('mensal');
  const [monthKey, setMonthKey] = useState(currentMonthKey());
  const [eixoMensal, setEixoMensal] = useState<DreEixoMensal>('competencia');
  const [anualMode, setAnualMode] = useState<DreAnualChartMode>('receitaDespesa');

  const year = useMemo(() => Number(monthKey.slice(0, 4)), [monthKey]);

  const { data, isLoading, error } = useQuery<DreOverviewResponse>({
    queryKey: ['dre-overview', projectId, monthKey, year],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/dre-overview?month=${monthKey}&year=${year}`),
    enabled: !!projectId,
  });

  if (projectType && projectType !== 'PESSOAL') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
        A tela de DRE está disponível apenas para projetos do tipo <strong>Pessoal</strong>.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
              <FileText className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                DRE pessoal
              </p>
              <h1 className="truncate text-base font-bold tracking-tight text-slate-950 xl:text-lg">
                {periodo === 'mensal' ? monthLong(monthKey) : `Ano ${year}`}
              </h1>
            </div>
          </div>
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
            <button
              type="button"
              onClick={() => setPeriodo('mensal')}
              className={`h-11 rounded-lg px-4 text-sm font-semibold transition ${
                periodo === 'mensal'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              mensal
            </button>
            <button
              type="button"
              onClick={() => setPeriodo('anual')}
              className={`h-11 rounded-lg px-4 text-sm font-semibold transition ${
                periodo === 'anual'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              anual
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            aria-label="Mês anterior"
            onClick={() => setMonthKey((current) => addMonthKey(current, -1))}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Próximo mês"
            onClick={() => setMonthKey((current) => addMonthKey(current, 1))}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setMonthKey(currentMonthKey())}
            className="h-11 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700"
          >
            mês atual
          </button>
        </div>
      </header>

      {isLoading && (
        <div className="space-y-3">
          <div className="h-32 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-64 animate-pulse rounded-2xl bg-slate-100" />
        </div>
      )}

      {error && !isLoading && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Não foi possível carregar o DRE agora.
        </div>
      )}

      {data && !isLoading && (
        <>
          {periodo === 'mensal' ? (
            <DreMensalView
              data={data.mensal}
              eixo={eixoMensal}
              onChangeEixo={setEixoMensal}
            />
          ) : (
            <DreAnualView
              data={data.anual}
              mode={anualMode}
              onChangeMode={setAnualMode}
            />
          )}
        </>
      )}
    </div>
  );
}
