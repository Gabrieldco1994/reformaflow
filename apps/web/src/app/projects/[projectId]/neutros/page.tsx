'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, RotateCcw, Shuffle } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { NeutrosResponse } from './_types';
import { NeutroRow } from './_components/NeutroRow';

type Filtro = 'todos' | 'entradas' | 'saidas';

export default function NeutrosPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { projectType } = useProject();

  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const [filtro, setFiltro] = useState<Filtro>('todos');

  const { data, isLoading, error, refetch } = useQuery<NeutrosResponse>({
    queryKey: ['neutros', projectId, year],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview/neutros?year=${year}`),
    enabled: !!projectId,
  });

  const itensFiltrados = useMemo(() => {
    const itens = data?.itens ?? [];
    if (filtro === 'entradas') return itens.filter((i) => i.kind === 'entrada');
    if (filtro === 'saidas') return itens.filter((i) => i.kind === 'saida');
    return itens;
  }, [data?.itens, filtro]);

  if (projectType && projectType !== 'PESSOAL') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
        A visão de <strong>Neutros</strong> está disponível apenas para projetos do tipo <strong>Pessoal</strong>.
      </div>
    );
  }

  const chipCls = (active: boolean) =>
    `h-9 rounded-lg px-3 text-xs font-semibold transition ${
      active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
    }`;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <header className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
              <Shuffle className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Lançamentos neutros
              </p>
              <h1 className="truncate text-base font-bold tracking-tight text-slate-950 xl:text-lg">
                Neutros · {year}
              </h1>
            </div>
          </div>
          <div className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-0.5">
            <button type="button" onClick={() => setYear((y) => y - 1)} className="rounded-lg p-1.5 text-slate-500 hover:bg-white hover:text-slate-800" aria-label="Ano anterior">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-1.5 text-sm font-semibold tabular-nums text-slate-800">{year}</span>
            <button type="button" onClick={() => setYear((y) => y + 1)} className="rounded-lg p-1.5 text-slate-500 hover:bg-white hover:text-slate-800" aria-label="Próximo ano">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Transferências, aportes/resgates e pagamentos de fatura — não entram no consumo/renda dos KPIs, mas movimentam o caixa (exceto os marcados <em>fora do caixa</em>). Editar o valor ou excluir aqui reflete direto na despesa/entrada real. Use <RotateCcw className="inline h-3 w-3 align-[-1px]" /> para <strong>tirar do neutro</strong> e voltar a contabilizar em tudo.
        </p>
      </header>

      {/* Resumo */}
      <section className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Entradas neutras</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-[#1E924A]">
            {formatCurrency((data?.totalEntradas ?? 0) / 100)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Saídas neutras</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-[#D92D20]">
            {formatCurrency((data?.totalSaidas ?? 0) / 100)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Líquido</p>
          <p className={`mt-1 text-lg font-bold tabular-nums ${(data?.totalLiquido ?? 0) >= 0 ? 'text-[#1E924A]' : 'text-[#D92D20]'}`}>
            {formatCurrency((data?.totalLiquido ?? 0) / 100)}
          </p>
        </div>
      </section>

      {/* Filtro */}
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
        <button type="button" onClick={() => setFiltro('todos')} className={chipCls(filtro === 'todos')}>Todos</button>
        <button type="button" onClick={() => setFiltro('entradas')} className={chipCls(filtro === 'entradas')}>Entradas</button>
        <button type="button" onClick={() => setFiltro('saidas')} className={chipCls(filtro === 'saidas')}>Saídas</button>
      </div>

      {/* Lista */}
      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Não foi possível carregar os neutros: {(error as Error).message}
        </div>
      ) : isLoading ? (
        <p className="py-8 text-center text-sm text-slate-500">Carregando…</p>
      ) : itensFiltrados.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">Nenhum lançamento neutro neste filtro.</p>
      ) : (
        <ul className="space-y-1.5">
          {itensFiltrados.map((item) => (
            <NeutroRow key={`${item.kind}-${item.id}`} item={item} projectId={projectId} onChanged={() => refetch()} />
          ))}
        </ul>
      )}
    </div>
  );
}
