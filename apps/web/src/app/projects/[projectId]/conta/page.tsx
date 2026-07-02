'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Landmark, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import type { Expense } from '@/types';
import { currentMonthKey, monthLabelLong } from './_lib';
import { ContaMonthPicker } from './_components/ContaMonthPicker';
import { ResumoCards, type ResumoQuickFilterKey } from './_components/ResumoCards';
import { CartoesSection } from './_components/CartoesSection';
import { MovimentacoesSection } from './_components/MovimentacoesSection';
import { PagarFaturaDialog } from './_components/PagarFaturaDialog';
import { TicketMedioSection } from './_components/TicketMedioSection';
import { FaturasAnuaisChart } from './_components/FaturasAnuaisChart';
import { DespesasRelacionadas } from './_components/DespesasRelacionadas';
import { NovaDespesaWizard } from '../expenses/_components/NovaDespesaWizard';
import { getExpenseOptions } from '../expenses/_types';
import { ReceitaModal } from './_components/ReceitaModal';
import type {
  AccountViewResponse,
  CardInvoicesYearlyResponse,
  OriginItemsYearlyResponse,
} from './_types';

function LoadingBlock() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_20rem]">
        <div className="h-36 rounded-3xl bg-lifeone-surface" />
        <div className="h-36 rounded-3xl bg-lifeone-surface" />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-28 rounded-2xl bg-lifeone-surface" />
        ))}
      </div>
      <div className="h-64 rounded-3xl bg-lifeone-surface" />
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
  const [novaDespesaOpen, setNovaDespesaOpen] = useState(false);
  const [novaReceitaOpen, setNovaReceitaOpen] = useState(false);
  const [resumoQuickFilter, setResumoQuickFilter] = useState<ResumoQuickFilterKey | null>(null);

  // Data padrão dos novos lançamentos: hoje se o mês selecionado for o atual;
  // senão, o dia 1 do mês selecionado (mantém o lançamento no mês em foco).
  const defaultLancamentoData =
    selectedMonth === currentMonthKey()
      ? new Date().toISOString().slice(0, 10)
      : `${selectedMonth}-01`;

  const selectedYear = selectedMonth.slice(0, 4);

  const queryClient = useQueryClient();
  const tipoOptions = useMemo(() => getExpenseOptions('PESSOAL'), []);

  const invalidateConta = () => {
    for (const key of ['account-view', 'expenses', 'cash-flow', 'dashboard', 'cross-project-expenses']) {
      queryClient.invalidateQueries({ queryKey: [key, projectId] });
    }
  };

  const { data: plannedExpenses = [] } = useQuery<Expense[]>({
    queryKey: ['expenses', projectId, 'planned'],
    queryFn: () => api.get(`/projects/${projectId}/expenses/planned`),
    enabled: !!projectId && novaDespesaOpen,
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${projectId}/expenses/${id}/pay`, {}),
    onSuccess: () => {
      toast.success('Despesa paga');
      invalidateConta();
      setNovaDespesaOpen(false);
    },
    onError: (e: Error) => toast.error(`Erro ao pagar despesa: ${e.message}`),
  });

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
      <div className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-6 text-center text-sm text-lifeone-ink-2 shadow-lifeone-card">
        A Visão Conta está disponível apenas para projetos do tipo <strong>Pessoal</strong>.
      </div>
    );
  }

  return (
    <div className="space-y-4 xl:space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl border border-lifeone-hairline bg-lifeone-card px-3 py-2.5 shadow-lifeone-card xl:flex-nowrap xl:px-4 xl:py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-lifeone-surface text-lifeone-ink-2">
            <Landmark className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
              Visão Conta
            </p>
            <h1
              className="truncate text-base font-bold tracking-tight text-lifeone-ink xl:text-lg font-geist not-italic"
              style={{ fontFamily: "'Geist', var(--font-sans), system-ui, sans-serif", fontStyle: 'normal' }}
            >
              {viewMode === 'ano' ? `Ano ${selectedYear}` : monthLabelLong(selectedMonth)}
            </h1>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex shrink-0 items-center rounded-xl border border-lifeone-hairline bg-lifeone-sidebar p-0.5">
            <button
              type="button"
              onClick={() => {
                setViewMode('mes');
                setSelectedOriginKey(null);
                setSelectedYearMonth(null);
              }}
              className={`h-9 rounded-lg px-3 text-xs font-semibold transition ${
                viewMode === 'mes' ? 'bg-lifeone-card text-lifeone-ink shadow-lifeone-card' : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
              }`}
            >
              Mês
            </button>
            <button
              type="button"
              onClick={() => setViewMode('ano')}
              className={`h-9 rounded-lg px-3 text-xs font-semibold transition ${
                viewMode === 'ano' ? 'bg-lifeone-card text-lifeone-ink shadow-lifeone-card' : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
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

      {/* Ações rápidas: novos lançamentos manuais */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setNovaDespesaOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#F2C6C1] bg-[#FCEBE9] px-3 py-2 text-sm font-semibold text-[#D92D20] transition hover:bg-[#F8DAD6]"
        >
          <ArrowDownCircle className="h-4 w-4" /> Nova Despesa
        </button>
        <button
          type="button"
          onClick={() => setNovaReceitaOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#BFE6CC] bg-[#E3F6EA] px-3 py-2 text-sm font-semibold text-[#1E924A] transition hover:bg-[#D2EFDC]"
        >
          <ArrowUpCircle className="h-4 w-4" /> Nova Receita
        </button>
      </div>

      {viewMode === 'ano' ? (
        <>
          {yearlyLoading && <div className="h-[380px] animate-pulse rounded-2xl bg-lifeone-surface" />}
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
            <div className="rounded-2xl border border-[#EAD9C0] bg-[#FBEBDC] p-4 text-sm text-[#B5803A]">
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
                recebimentosPrevistosMes={data.recebimentosPrevistosMes}
                sobraPrevista={data.sobraPrevista}
                activeQuickFilter={resumoQuickFilter}
                onQuickFilterSelect={(key) => {
                  setOriginFilter(null);
                  setResumoQuickFilter(key);
                }}
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
                summaryQuickFilter={resumoQuickFilter}
                onClearSummaryQuickFilter={() => setResumoQuickFilter(null)}
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

      <NovaDespesaWizard
        open={novaDespesaOpen}
        mode="PAGA"
        projectId={projectId}
        projectType="PESSOAL"
        allowRecorrente
        tipoOptions={tipoOptions}
        roomOptions={[]}
        showRooms={false}
        plannedExpenses={plannedExpenses}
        onPay={(id) => payMutation.mutate(id)}
        payDisabled={payMutation.isPending}
        onClose={() => setNovaDespesaOpen(false)}
        onCreated={invalidateConta}
      />
      <ReceitaModal
        open={novaReceitaOpen}
        onClose={() => setNovaReceitaOpen(false)}
        projectId={projectId}
        defaultData={defaultLancamentoData}
      />
    </div>
  );
}
