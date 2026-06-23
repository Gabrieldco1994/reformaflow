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
import { MovimentacoesSection } from './_components/MovimentacoesSection';
import { PagarFaturaDialog } from './_components/PagarFaturaDialog';
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
  const [payCardLast4, setPayCardLast4] = useState<string | null>(null);

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
      <header className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm xl:px-4 xl:py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
            <Landmark className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Visão Conta
            </p>
            <h1 className="truncate text-base font-bold tracking-tight text-slate-950 xl:text-lg">
              {monthLabelLong(selectedMonth)}
            </h1>
          </div>
        </div>
        <ContaMonthPicker month={selectedMonth} onChange={setSelectedMonth} />
      </header>

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
          />
          <MovimentacoesSection data={data} projectId={projectId} onPayInvoice={setPayCardLast4} />
          <CartoesSection cartoes={data.cartoes} onPayInvoice={setPayCardLast4} />
          <TicketMedioSection ticket={data.ticketMedio} currentMonth={data.mesSelecionado} />
        </>
      )}

      {payCardLast4 && data && (() => {
        const card = data.cartoes.find((c) => c.last4 === payCardLast4);
        if (!card) return null;
        return (
          <PagarFaturaDialog
            projectId={projectId}
            card={card}
            contas={data.contas ?? []}
            onClose={() => setPayCardLast4(null)}
          />
        );
      })()}
    </div>
  );
}
