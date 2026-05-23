'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import type { MonthlyOverviewResponse } from './_types';
import MonthlyKpis from './_components/MonthlyKpis';
import TopCategoriasCard from './_components/TopCategoriasCard';
import MonthlyEntriesList from './_components/MonthlyEntriesList';

const MonthlyByOriginChart = dynamic(
  () => import('./_components/MonthlyByOriginChart'),
  {
    ssr: false,
    loading: () => (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 h-[320px] animate-pulse" />
    ),
  },
);

function formatMesLabel(mes: string) {
  const [y, m] = mes.split('-');
  const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  return `${meses[parseInt(m ?? '1') - 1]} ${y}`;
}

export default function MonthlyOverviewPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { projectType } = useProject();

  const { data, isLoading, error } = useQuery<MonthlyOverviewResponse>({
    queryKey: ['monthly-overview', projectId],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview`),
    enabled: !!projectId,
  });

  if (projectType && projectType !== 'PESSOAL') {
    return (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-6 text-center">
        <p className="text-sm text-darc-velvet">
          Visão consolidada mensal disponível apenas para projetos do tipo <strong>Pessoal</strong>.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-24 rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
          ))}
        </div>
        <div className="h-[320px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-2xl bg-darc-red-pastel/15 border border-darc-red-pastel/40 p-4 text-sm text-darc-red">
        Não foi possível carregar a visão mensal. Tente novamente.
      </div>
    );
  }

  const current = data.comparativo.current ?? data.meses[data.meses.length - 1] ?? null;
  const projetosAtivos = data.projetos.filter((p) => p.type !== 'PESSOAL');

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-br from-indigo-50 to-rose-50 border border-indigo-100 p-4 md:p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-indigo-700">Visão consolidada</p>
            <h1 className="text-lg md:text-xl font-semibold text-darc-velvet mt-1">
              {formatMesLabel(data.mesAtual)}
            </h1>
            <p className="text-xs text-darc-velvet/70 mt-1">
              Soma de todos os projetos do seu acervo: lançamentos próprios + Reforma + Casa + Carro.
            </p>
          </div>
          {projetosAtivos.length > 0 && (
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              {projetosAtivos.map((p) => (
                <span
                  key={p.id}
                  className="px-2 py-1 rounded-full bg-white/70 border border-indigo-200 text-indigo-800"
                >
                  {p.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <MonthlyKpis current={current} comparison={data.comparativo} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <MonthlyByOriginChart meses={data.meses} />
        </div>
        <TopCategoriasCard current={current} />
      </div>

      <MonthlyEntriesList entries={data.mesAtualEntries} />
    </div>
  );
}
