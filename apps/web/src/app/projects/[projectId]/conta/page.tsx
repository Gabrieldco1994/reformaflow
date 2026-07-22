'use client';

import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { useRef, useState, useEffect } from 'react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { LoadingBlock } from '@/app/_components/LoadingBlock';
import { currentMonthKey, monthLabelLong } from './_lib';
import { ContaMonthPicker } from './_components/ContaMonthPicker';
import { ResumoCards, type ResumoQuickFilterKey } from './_components/ResumoCards';
import { CartoesSection } from './_components/CartoesSection';
import { MovimentacoesSection } from './_components/MovimentacoesSection';
import { PagarFaturaDialog } from './_components/PagarFaturaDialog';
import { InvoiceInterventionDialog } from './_components/InvoiceInterventionDialog';
import { FaturasAnuaisChart } from './_components/FaturasAnuaisChart';
import { DespesasRelacionadas } from './_components/DespesasRelacionadas';
import { TodasDespesasAno } from './_components/TodasDespesasAno';
import { ContaQuickActions } from './_components/ContaQuickActions';
import { NovaDespesaLauncher } from '../expenses/_components/NovaDespesaLauncher';
import { PendenciasQueueCard } from '../monthly/_cockpit/PendenciasQueueCard';
import type {
  AccountViewResponse,
  CardInvoicesYearlyResponse,
  OriginItemsYearlyResponse,
} from './_types';
import type { DreOverviewResponse } from '../dre/_types';

export default function ContaPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { projectType } = useProject();
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey());
  const [viewMode, setViewMode] = useState<'mes' | 'ano'>('mes');
  const [selectedOriginKey, setSelectedOriginKey] = useState<string | null>(null);
  const [selectedYearMonth, setSelectedYearMonth] = useState<string | null>(null);
  const [payCardLast4, setPayCardLast4] = useState<string | null>(null);
  const [adjustCardLast4, setAdjustCardLast4] = useState<string | null>(null);
  const [residualCardLast4, setResidualCardLast4] = useState<string | null>(null);
  const [originFilter, setOriginFilter] = useState<string | null>(null);
  const [resumoQuickFilter, setResumoQuickFilter] = useState<ResumoQuickFilterKey | null>(null);
  const openNovaDespesaRef = useRef<() => void>(() => undefined);

  // Seed resumoQuickFilter from ?quick= query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const quick = params.get('quick') as ResumoQuickFilterKey | null;
    if (quick && ['entrouMes', 'saiuMes', 'faltaPagarMes'].includes(quick)) {
      setResumoQuickFilter(quick);
    }
  }, []);

  const selectedYear = selectedMonth.slice(0, 4);

  const queryClient = useQueryClient();

  const invalidateConta = () => {
    for (const key of ['account-view', 'expenses', 'cash-flow', 'dashboard', 'cross-project-expenses']) {
      queryClient.invalidateQueries({ queryKey: [key, projectId] });
    }
  };


  const { data, isLoading, error } = useQuery<AccountViewResponse>({
    queryKey: ['account-view', projectId, selectedMonth],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/account-view?month=${selectedMonth}`),
    enabled: !!projectId,
  });

  // Runway de caixa (visão da verdade): só faz sentido para o ano corrente,
  // pois a série é ancorada no caixa real de hoje. Reaproveita a série já
  // reconciliada do dre-overview (mesmo eixo caixa da Visão Conta).
  const currentYear = currentMonthKey().slice(0, 4);
  const { data: dreData } = useQuery<DreOverviewResponse>({
    queryKey: ['dre-overview', projectId, selectedYear],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/dre-overview?year=${selectedYear}`),
    enabled: !!projectId && viewMode === 'mes' && selectedYear === currentYear,
  });

  const { data: yearlyData, isLoading: yearlyLoading } = useQuery<CardInvoicesYearlyResponse>({
    queryKey: ['card-invoices-yearly', projectId, selectedYear],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/card-invoices-yearly?year=${selectedYear}`),
    enabled: !!projectId && viewMode === 'ano',
  });

  const selectedOrigin = yearlyData?.origins.find((o) => o.key === selectedOriginKey) ?? null;

  // "Sobra prevista" ACUMULADA: saldo projetado do mês selecionado, lido da mesma
  // série do cockpit (carrega o que sobrou/faltou dos meses anteriores, em vez de
  // recomeçar do caixa de hoje a cada mês). Fallback para a sobra do mês
  // (não-acumulada, vinda da account-view) quando a série não está disponível.
  const sobraPrevistaAcumulada = dreData?.anual.saldoAcumuladoSerie.find(
    (row) => row.mes === selectedMonth,
  )?.saldoProjetado;
  const { data: originItems, isLoading: originItemsLoading } = useQuery<OriginItemsYearlyResponse>({
    queryKey: ['origin-items-yearly', projectId, selectedYear, selectedOrigin?.kind, selectedOrigin?.last4],
    queryFn: () =>
      api.get(
        `/projects/${projectId}/monthly-overview/origin-items-yearly?year=${selectedYear}&kind=${selectedOrigin!.kind}&last4=${selectedOrigin!.last4}`,
      ),
    enabled: !!projectId && viewMode === 'ano' && !!selectedOrigin,
  });

  // "Todos" (nenhuma origem selecionada): todas as despesas do ano, todas as origens.
  const { data: allItems, isLoading: allItemsLoading } = useQuery<OriginItemsYearlyResponse>({
    queryKey: ['origin-items-yearly', projectId, selectedYear, 'all'],
    queryFn: () =>
      api.get(`/projects/${projectId}/monthly-overview/origin-items-yearly?year=${selectedYear}&kind=all`),
    enabled: !!projectId && viewMode === 'ano' && !selectedOriginKey,
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
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-2xl border border-lifeone-hairline bg-lifeone-card px-3 py-2.5 shadow-lifeone-card xl:flex-nowrap xl:items-center xl:px-4 xl:py-3">
        <div className="flex min-w-0 w-full flex-1 items-center gap-2.5 xl:w-auto">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-lifeone-surface text-lifeone-ink-2">
            <Landmark className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
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
        <div className="flex w-full shrink-0 items-center overflow-x-auto pb-0.5 xl:w-auto xl:justify-start xl:overflow-visible xl:pb-0">
          <div className="flex shrink-0 items-center gap-1 rounded-xl border border-lifeone-hairline bg-lifeone-surface p-1">
            <div className="flex shrink-0 items-center rounded-lg bg-lifeone-sidebar p-0.5">
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
              <div className="shrink-0">
                <ContaMonthPicker month={selectedMonth} onChange={setSelectedMonth} embedded />
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Ações rápidas: novos lançamentos manuais + plano de recebimentos */}
      <NovaDespesaLauncher
        projectId={projectId}
        projectType={projectType ?? 'PESSOAL'}
        onChanged={invalidateConta}
        trigger={(open) => {
          openNovaDespesaRef.current = open;
          return null;
        }}
      />
      <ContaQuickActions
        onOpenLaunch={() => openNovaDespesaRef.current()}
      />

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
              {selectedOrigin ? (
                <DespesasRelacionadas
                  origin={selectedOrigin}
                  data={originItems}
                  isLoading={originItemsLoading}
                  selectedMonth={selectedYearMonth}
                />
              ) : (
                <TodasDespesasAno data={allItems} isLoading={allItemsLoading} year={selectedYear} />
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
                sobraPrevista={sobraPrevistaAcumulada ?? data.sobraPrevista}
                saiuSemConta={data.saidas
                  .filter((s) => !s.isInvoice && !s.cardLast4 && !s.bankLast4 && s.realizado)
                  .reduce((acc, s) => acc + s.valor, 0)}
                activeQuickFilter={resumoQuickFilter}
                onQuickFilterSelect={(key) => {
                  setOriginFilter(null);
                  setResumoQuickFilter(key);
                }}
              />
              <PendenciasQueueCard
                projectId={projectId}
                monthKey={data.mesSelecionado}
                projectType={projectType}
              />
              <CartoesSection
                projectId={projectId}
                cartoes={data.cartoes}
                contas={data.contas ?? []}
                selected={originFilter}
                onSelect={setOriginFilter}
                onPayInvoice={setPayCardLast4}
                onAdjustInvoice={setAdjustCardLast4}
                onSettleWithResidual={setResidualCardLast4}
              />
              <MovimentacoesSection
                data={data}
                projectId={projectId}
                originFilter={originFilter}
                onClearOrigin={() => setOriginFilter(null)}
                onPayInvoice={setPayCardLast4}
                onAdjustInvoice={setAdjustCardLast4}
                onSettleWithResidual={setResidualCardLast4}
                summaryQuickFilter={resumoQuickFilter}
                onClearSummaryQuickFilter={() => setResumoQuickFilter(null)}
              />
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

      {adjustCardLast4 && data && (() => {
        const card = data.cartoes.find((c) => c.last4 === adjustCardLast4);
        if (!card) return null;
        return (
          <InvoiceInterventionDialog
            projectId={projectId}
            card={card}
            mode="adjust"
            onClose={() => setAdjustCardLast4(null)}
          />
        );
      })()}

      {residualCardLast4 && data && (() => {
        const card = data.cartoes.find((c) => c.last4 === residualCardLast4);
        if (!card) return null;
        return (
          <InvoiceInterventionDialog
            projectId={projectId}
            card={card}
            mode="residual"
            onClose={() => setResidualCardLast4(null)}
          />
        );
      })()}

    </div>
  );
}
