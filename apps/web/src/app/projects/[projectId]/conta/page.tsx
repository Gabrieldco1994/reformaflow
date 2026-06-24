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
import { FaturasAnuaisChart } from './_components/FaturasAnuaisChart';
import { DespesasRelacionadas } from './_components/DespesasRelacionadas';
import type {
  AccountViewResponse,
  CardInvoicesYearlyResponse,
  OriginItemsYearlyResponse,
} from './_types';

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
  const [viewMode, setViewMode] = useState<'mes' | 'ano'>('mes');
  const [selectedOriginKey, setSelectedOriginKey] = useState<string | null>(null);
  const [selectedYearMonth, setSelectedYearMonth] = useState<string | null>(null);
  const [payCardLast4, setPayCardLast4] = useState<string | null>(null);
  const [originFilter, setOriginFilter] = useState<string | null>(null);

  const selectedYear = selectedMonth.slice(0, 4);

  const { data, isLoading, error } = useQuery<AccountViewResponse>({
    queryKey: ['account-view', projectId, selectedMonth],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/account-view?month=${selectedMonth}`),
    enabled: !!projectId,
  });

  const { data: yearlyData, isLoading: yearlyLoading } = useQuery<CardInvoicesYearlyResponse>({
    queryKey: ['card-invoices-yearly', projectId, selectedYear],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/card-invoices-yearly?year=${selectedYear}`),
    enabled: !!projectId && viewMode === 'ano',
  });

  const selectedOrigin = yearlyData?.origins.find((o) => o.key === selectedOriginKey) ?? null;

  const { data: originItems, isLoading: originItemsLoading } = useQuery<OriginItemsYearlyResponse>({
    queryKey: ['origin-items-yearly', projectId, selectedYear, selectedOrigin?.kind, selectedOrigin?.last4],
    queryFn: () =>
      api.get(
        `/projects/${projectId}/monthly-overview/origin-items-yearly?year=${selectedYear}&kind=${selectedOrigin!.kind}&last4=${selectedOrigin!.last4}`,
      ),
    enabled: !!projectId && viewMode === 'ano' && !!selectedOrigin,
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
              {viewMode === 'ano' ? `Ano ${selectedYear}` : monthLabelLong(selectedMonth)}
            </h1>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 p-0.5">
            <button
              type="button"
              onClick={() => {
                setViewMode('mes');
                setSelectedOriginKey(null);
                setSelectedYearMonth(null);
              }}
              className={`h-9 rounded-lg px-3 text-xs font-semibold transition ${
                viewMode === 'mes' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Mês
            </button>
            <button
              type="button"
              onClick={() => setViewMode('ano')}
              className={`h-9 rounded-lg px-3 text-xs font-semibold transition ${
                viewMode === 'ano' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Ano todo
            </button>
          </div>
          {viewMode === 'mes' && (
            <ContaMonthPicker month={selectedMonth} onChange={setSelectedMonth} />
          )}
        </div>
      </header>

      {viewMode === 'ano' ? (
        <>
          {yearlyLoading && <div className="h-[380px] animate-pulse rounded-2xl bg-slate-100" />}
          {yearlyData && !yearlyLoading && (
            <>
              <FaturasAnuaisChart
                data={yearlyData}
                selectedKey={selectedOriginKey}
                onSelectKey={(key) => {
                  setSelectedOriginKey(key);
                  setSelectedYearMonth(null);
                }}
                selectedMonth={selectedYearMonth}
                onSelectMonth={setSelectedYearMonth}
              />
              {selectedOrigin && (
                <DespesasRelacionadas
                  origin={selectedOrigin}
                  data={originItems}
                  isLoading={originItemsLoading}
                  selectedMonth={selectedYearMonth}
                />
              )}
            </>
          )}
        </>
      ) : (
        <>
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
              <CartoesSection
                cartoes={data.cartoes}
                contas={data.contas ?? []}
                selected={originFilter}
                onSelect={setOriginFilter}
                onPayInvoice={setPayCardLast4}
              />
              <MovimentacoesSection
                data={data}
                projectId={projectId}
                originFilter={originFilter}
                onClearOrigin={() => setOriginFilter(null)}
                onPayInvoice={setPayCardLast4}
              />
              <TicketMedioSection ticket={data.ticketMedio} currentMonth={data.mesSelecionado} />
            </>
          )}
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
