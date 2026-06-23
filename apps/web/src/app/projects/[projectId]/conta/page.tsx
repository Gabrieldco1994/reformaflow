'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { useState } from 'react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { currentMonthKey, monthLabelLong } from './_lib';
import { ContaMonthPicker } from './_components/ContaMonthPicker';
import { ResumoCards } from './_components/ResumoCards';
import { CartoesSection } from './_components/CartoesSection';
import { EntradasSection, SaidasSection } from './_components/MovementsSection';
import { TicketMedioSection } from './_components/TicketMedioSection';
import type { AccountViewResponse } from './_types';

function LoadingBlock() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_20rem]">
        <div className="h-36 rounded-3xl bg-slate-100" />
        <div className="h-36 rounded-3xl bg-slate-100" />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-28 rounded-2xl bg-slate-100" />
        ))}
      </div>
      <div className="h-64 rounded-3xl bg-slate-100" />
    </div>
  );
}

export default function ContaPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { projectType } = useProject();
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey());

  const { data, isLoading, error } = useQuery<AccountViewResponse>({
    queryKey: ['account-view', projectId, selectedMonth],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/account-view?month=${selectedMonth}`),
    enabled: !!projectId,
  });

  if (projectType && projectType !== 'PESSOAL') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
        A Visão Conta está disponível apenas para projetos do tipo <strong>Pessoal</strong>.
      </div>
    );
  }

  return (
    <div className="space-y-4 xl:space-y-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_20rem] xl:items-stretch">
        <header className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm xl:p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-700 xl:h-12 xl:w-12">
              <Landmark className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Visão Conta
              </p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 xl:text-3xl">
                {monthLabelLong(selectedMonth)}
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-600 xl:text-[15px] xl:leading-6">
                Quanto você tem, quanto entrou, quanto saiu e quanto ainda vai sair da conta.
              </p>
            </div>
          </div>
        </header>

        <ContaMonthPicker month={selectedMonth} onChange={setSelectedMonth} />
      </div>

      {isLoading && <LoadingBlock />}

      {error && !isLoading && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Não foi possível carregar a Visão Conta agora.
        </div>
      )}

      {data && !isLoading && (
        <>
          <ResumoCards
            caixaHoje={data.caixaHoje}
            entrouMes={data.entrouMes}
            saiuMes={data.saiuMes}
            faltaPagarMes={data.faltaPagarMes}
            sobraPrevista={data.sobraPrevista}
            devoCartaoTotal={data.devoCartaoTotal}
          />
          <CartoesSection cartoes={data.cartoes} />
          <div className="grid gap-4 xl:grid-cols-2">
            <SaidasSection items={data.saidas} />
            <EntradasSection items={data.entradas} />
          </div>
          <TicketMedioSection ticket={data.ticketMedio} currentMonth={data.mesSelecionado} />
        </>
      )}
    </div>
  );
}
