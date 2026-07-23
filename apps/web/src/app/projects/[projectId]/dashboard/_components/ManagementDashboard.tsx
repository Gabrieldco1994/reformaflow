'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { KpiTile } from '@/components/KpiTile';
import { moneyGlance } from '@/lib/money';
import { daysUntilDue } from '@/lib/recurring-bill-status';
import {
  BillFrequencyLabels,
  ReminderPriorityLabels, hasFeature, type ProjectType,
} from '@reformaflow/domain';
import ManagementGlance from './ManagementGlance';
import ManagementFocus from './ManagementFocus';
import { useAuth } from '@/contexts/auth-context';
import { computeMaintenanceProgress } from '../_lib/maintenance-progress';
import { computeFuelSummary, type FuelExpenseLike } from '../_lib/fuel-summary';

/** "vence em N dias" / "vence hoje" / "Vencida" — mesma fonte que o badge de atraso. */
export function dueDateLabel(dias: number): string {
  if (dias < 0) return 'Vencida';
  if (dias === 0) return 'vence hoje';
  return `vence em ${dias} dia${dias === 1 ? '' : 's'}`;
}

/** "em N dias" / "hoje" / "atrasada" — mesma contagem, sem o prefixo "vence" (usado após substantivos como "próxima parcela"). */
function inDaysLabel(dias: number): string {
  if (dias < 0) return 'atrasada';
  if (dias === 0) return 'hoje';
  return `em ${dias} dia${dias === 1 ? '' : 's'}`;
}

export interface Bill { id: string; nome: string; valor: number; categoria: string; frequencia: string; diaVencimento: number; status: string; }
export interface Maintenance { id: string; tipo: string; dataRealizada: string; dataProxima?: string; custo: number; fornecedor?: string; }
export interface Reminder { id: string; titulo: string; descricao?: string; data: string; prioridade: string; recorrencia: string; status: string; }
export interface VehicleDocument { id: string; titulo: string; tipo: string; dataVencimento: string; }
export interface CarInfo { kmAtual: number | null; }
export interface FinancingSummary {
  instituicao?: string | null;
  sistema: string;
  valorTotalFinanciado: number;
  summary: {
    valorPago: number;
    saldoDevedor: number;
    progresso: number;
    totalParcelas: number;
    parcelasPagas: number;
    proximaParcela: { numeroParcela: number; dataVencimento: string; valorPrevisto: number } | null;
  };
}

export default function ManagementDashboard({ projectId, projectType }: { projectId: string; projectType: string }) {
  const hasFinancing = hasFeature(projectType as ProjectType, 'financing');
  const isCarro = projectType === 'CARRO';
  const { hasModule } = useAuth();
  const canViewVehicleDocuments = isCarro && hasModule('vehicleDocuments');
  const { data: bills } = useQuery<Bill[]>({
    queryKey: ['recurring-bills', projectId],
    queryFn: () => api.get(`/projects/${projectId}/recurring-bills`),
  });
  const { data: maintenance } = useQuery<Maintenance[]>({
    queryKey: ['maintenance-logs', projectId],
    queryFn: () => api.get(`/projects/${projectId}/maintenance-logs`),
  });
  const { data: reminders } = useQuery<Reminder[]>({
    queryKey: ['reminders', projectId],
    queryFn: () => api.get(`/projects/${projectId}/reminders`),
  });
  const { data: financing } = useQuery<FinancingSummary | null>({
    queryKey: ['financing', projectId],
    queryFn: () => api.get(`/projects/${projectId}/financing`),
    enabled: hasFinancing,
  });
  const { data: vehicleDocuments } = useQuery<VehicleDocument[]>({
    queryKey: ['vehicle-documents', projectId],
    queryFn: () => api.get(`/projects/${projectId}/vehicle-documents`),
    enabled: canViewVehicleDocuments,
  });
  const { data: carInfo } = useQuery<CarInfo | null>({
    queryKey: ['car-info', projectId],
    queryFn: () => api.get(`/projects/${projectId}/car-info`),
    enabled: isCarro,
  });
  const { data: expensesPage } = useQuery<{ items: FuelExpenseLike[] }>({
    queryKey: ['expenses', projectId, 'fuel-summary'],
    queryFn: () => api.get(`/projects/${projectId}/expenses?pageSize=500`),
    enabled: isCarro,
  });

  const activeBills = (bills ?? []).filter(b => b.status === 'ATIVO');
  const totalMensal = activeBills.reduce((sum, b) => sum + b.valor, 0);

  const today = new Date();
  const upcomingMaintenance = (maintenance ?? [])
    .filter(m => m.dataProxima && new Date(m.dataProxima) >= today)
    .sort((a, b) => new Date(a.dataProxima!).getTime() - new Date(b.dataProxima!).getTime())
    .slice(0, 5);

  const fuelExpenses = ((expensesPage?.items ?? []) as (FuelExpenseLike & { tipoDespesa?: string })[])
    .filter((e) => e.tipoDespesa === 'GASOLINA');
  const fuelSummary = isCarro ? computeFuelSummary(fuelExpenses, today) : null;

  const pendingReminders = (reminders ?? [])
    .filter(r => r.status === 'PENDENTE')
    .sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime())
    .slice(0, 5);

  const overdueBills = activeBills.filter(b => daysUntilDue(b.diaVencimento, today) < 0);

  const kpis: { label: string; value: string; tone: 'positive' | 'negative' | 'neutral' | 'warning' }[] = [
    { label: 'Contas Ativas', value: `${activeBills.length}`, tone: 'neutral' },
    { label: 'Custo Mensal Estimado', value: moneyGlance(totalMensal), tone: 'neutral' },
    { label: 'Manutenções Próximas', value: `${upcomingMaintenance.length}`, tone: 'neutral' },
    { label: 'Lembretes Pendentes', value: `${pendingReminders.length}`, tone: 'neutral' },
    { label: 'Contas Vencidas', value: `${overdueBills.length}`, tone: overdueBills.length > 0 ? 'negative' : 'neutral' },
  ];

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="md:hidden space-y-4">
        <ManagementGlance
          projectId={projectId}
          totalMensalLabel={formatCurrency(totalMensal / 100)}
          activeCount={activeBills.length}
          overdueCount={overdueBills.length}
          upcomingMaintenanceCount={upcomingMaintenance.length}
          pendingRemindersCount={pendingReminders.length}
        />
        <ManagementFocus
          projectId={projectId}
          activeBills={activeBills}
          upcomingMaintenance={upcomingMaintenance}
          pendingReminders={pendingReminders}
          today={today}
          carKmAtual={isCarro ? carInfo?.kmAtual ?? null : null}
        />
      </div>
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} role="article" aria-label={kpi.label} className="min-w-0">
            <KpiTile
              variant="support"
              layer="glance"
              tone={kpi.tone}
              label={kpi.label}
              value={kpi.value}
            />
          </div>
        ))}
      </div>

      {hasFinancing && financing && (
        <section className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card md:p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">Financiamento</p>
            <Link href={`/projects/${projectId}/financing`} className="inline-flex min-h-[44px] items-center text-sm text-lifeone-blue hover:underline">
              Ver detalhes
            </Link>
          </div>
          <p className="font-geist text-2xl font-bold tabular-nums text-lifeone-ink md:text-[28px]">
            {formatCurrency(financing.summary.valorPago / 100)}
          </p>
          <p className="mt-1 text-sm text-lifeone-ink-3">
            de {formatCurrency(financing.valorTotalFinanciado / 100)}
            {financing.summary.proximaParcela
              ? ` · próxima parcela ${inDaysLabel(daysBetween(financing.summary.proximaParcela.dataVencimento, today))}`
              : ' · financiamento quitado'}
          </p>
          <div
            role="progressbar"
            aria-label="Progresso do financiamento"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={financing.summary.progresso}
            className="mt-3 h-2 overflow-hidden rounded-full bg-lifeone-hairline-3"
          >
            <div
              className={`h-full ${projectType === 'CASA' ? 'bg-type-casa' : 'bg-lifeone-blue'}`}
              style={{ width: `${financing.summary.progresso}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-lifeone-ink-3">
            Saldo devedor {formatCurrency(financing.summary.saldoDevedor / 100)} · {financing.summary.parcelasPagas}/{financing.summary.totalParcelas} parcelas pagas
          </p>
        </section>
      )}

      {canViewVehicleDocuments && (
        <section className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card md:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">Documentos</p>
              <p className="mt-1 text-sm text-lifeone-ink-3">
                {(vehicleDocuments ?? []).length === 0
                  ? 'Cadastre IPVA, seguro e licenciamento.'
                  : `${vehicleDocuments?.length} documento(s) acompanhado(s).`}
              </p>
            </div>
            <Link href={`/projects/${projectId}/vehicle-documents`} className="inline-flex min-h-[44px] items-center text-sm text-lifeone-blue hover:underline">
              Ver documentos
            </Link>
          </div>
          {(vehicleDocuments ?? []).slice(0, 3).map((document) => (
            <div key={document.id} className="mt-3 flex items-center justify-between gap-3 border-t border-lifeone-hairline pt-3 text-sm">
              <span className="min-w-0 truncate font-medium text-lifeone-ink">{document.titulo}</span>
              <span className="whitespace-nowrap font-geist tabular-nums text-lifeone-ink-3">{formatDateBR(document.dataVencimento)}</span>
            </div>
          ))}
        </section>
      )}

      {isCarro && fuelSummary && (
        <section className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card md:p-5">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">Gasto com Combustível</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-lifeone-ink-3">Este mês</p>
              <p className="whitespace-nowrap font-geist text-lg font-bold tabular-nums text-lifeone-ink">
                {formatCurrency(fuelSummary.currentMonthCents / 100)}
              </p>
            </div>
            <div>
              <p className="text-xs text-lifeone-ink-3">Média mensal</p>
              <p className="whitespace-nowrap font-geist text-lg font-bold tabular-nums text-lifeone-ink">
                {fuelSummary.monthsConsidered > 0 ? formatCurrency(fuelSummary.averageMonthlyCents / 100) : 'Sem histórico'}
              </p>
            </div>
          </div>
        </section>
      )}

      <div>
        {overdueBills.length === 0 ? (
          <div className="flex items-start gap-2.5 rounded-2xl border border-[#BFE6CC] bg-[#E3F6EA] px-3.5 py-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#1E924A]" />
            <div className="leading-snug">
              <p className="text-sm font-bold text-[#1E924A]">Tudo em dia</p>
              <p className="mt-0.5 text-xs text-lifeone-ink-3">Nenhuma conta atrasada este mês.</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 rounded-2xl border border-[#F2C6C1] bg-[#FCEBE9] px-3.5 py-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#D92D20]" />
            <div className="leading-snug">
              <p className="text-sm font-bold text-[#D92D20]">
                {overdueBills.length} conta{overdueBills.length === 1 ? '' : 's'} atrasada{overdueBills.length === 1 ? '' : 's'} este mês
              </p>
              <p className="mt-0.5 text-xs text-[#B5803A]">Regularize para não acumular juros e multas.</p>
            </div>
          </div>
        )}
      </div>

      <section className="hidden rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card md:block md:p-5">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">Contas do Mês</p>
        {activeBills.length === 0 ? (
          <p className="text-sm text-lifeone-ink-3">Nenhuma conta cadastrada.</p>
        ) : (
          <div className="divide-y divide-lifeone-hairline">
            {activeBills.map((bill) => {
              const dias = daysUntilDue(bill.diaVencimento, today);
              const isOverdue = dias < 0;
              return (
                <div key={bill.id} className={`flex items-center justify-between gap-3 py-3 ${isOverdue ? '-mx-2 rounded-lg bg-[#FCEBE9] px-2' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-lifeone-ink">
                      {bill.nome}
                      {isOverdue && <span className="ml-2 text-xs font-semibold text-[#D92D20]">Vencida</span>}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-lifeone-ink-3">
                      {bill.frequencia !== 'MENSAL' ? `${BillFrequencyLabels[bill.frequencia as keyof typeof BillFrequencyLabels] ?? bill.frequencia} · ` : ''}
                      {isOverdue ? 'venceu' : dueDateLabel(dias)}
                    </p>
                  </div>
                  <span className="whitespace-nowrap font-geist text-sm font-bold tabular-nums text-lifeone-ink">{formatCurrency(bill.valor / 100)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="hidden rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card md:block md:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">Próximas Manutenções</p>
          {isCarro && carInfo?.kmAtual != null && (
            <span className="whitespace-nowrap font-geist text-xs tabular-nums text-lifeone-ink-3">{carInfo.kmAtual.toLocaleString('pt-BR')} km atuais</span>
          )}
        </div>
        {upcomingMaintenance.length === 0 ? (
          <p className="text-sm text-lifeone-ink-3">Nenhuma manutenção agendada.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {upcomingMaintenance.map((m) => {
              const daysUntil = daysBetween(m.dataProxima!, today);
              const accent = daysUntil <= 7 ? 'bg-[#D92D20]' : daysUntil <= 30 ? 'bg-[#B5803A]' : 'bg-lifeone-ink-4';
              const progress = computeMaintenanceProgress(m.dataRealizada, m.dataProxima!, today);
              return (
                <div key={m.id} className="relative overflow-hidden rounded-xl bg-lifeone-surface p-3">
                  <span className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${accent}`} />
                  <p className="pl-2 text-sm font-semibold text-lifeone-ink">{m.tipo}</p>
                  <p className="mt-1 pl-2 text-xs text-lifeone-ink-3">Próxima: {formatDateBR(m.dataProxima!)}</p>
                  <p className={`pl-2 text-xs ${daysUntil <= 0 ? 'font-semibold text-[#D92D20]' : 'text-lifeone-ink-3'}`}>
                    {daysUntil <= 0 ? 'Atrasada' : `Em ${daysUntil} dias`}
                  </p>
                  <div
                    role="progressbar"
                    aria-label={`Progresso até a próxima manutenção: ${m.tipo}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.percentComplete}
                    className="ml-2 mt-2 h-1.5 overflow-hidden rounded-full bg-lifeone-hairline-3"
                  >
                    <div className={`h-full ${accent}`} style={{ width: `${progress.percentComplete}%` }} />
                  </div>
                  {m.fornecedor && <p className="mt-1 pl-2 text-xs text-lifeone-ink-4">{m.fornecedor}</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="hidden rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card md:block md:p-5">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">Lembretes Pendentes</p>
        {pendingReminders.length === 0 ? (
          <p className="text-sm text-lifeone-ink-3">Nenhum lembrete pendente.</p>
        ) : (
          <div className="space-y-2">
            {pendingReminders.map((r) => {
              const daysUntil = daysBetween(r.data, today);
              const priorityColors: Record<string, string> = {
                URGENTE: 'border-l-[#D92D20]',
                ALTA: 'border-l-[#B5803A]',
                MEDIA: 'border-l-lifeone-blue',
                BAIXA: 'border-l-lifeone-ink-4',
              };
              return (
                <div key={r.id} className={`rounded-r-lg border-l-4 bg-lifeone-surface p-3 ${priorityColors[r.prioridade] ?? 'border-l-lifeone-ink-4'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-lifeone-ink">{r.titulo}</p>
                    <span className="rounded-full border border-lifeone-hairline bg-lifeone-card px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-lifeone-ink-3">
                      {ReminderPriorityLabels[r.prioridade as keyof typeof ReminderPriorityLabels] ?? r.prioridade}
                    </span>
                  </div>
                  {r.descricao && <p className="mt-1 text-sm text-lifeone-ink-3">{r.descricao}</p>}
                  <p className={`mt-1 text-xs ${daysUntil <= 0 ? 'font-semibold text-[#D92D20]' : 'text-lifeone-ink-3'}`}>
                    {formatDateBR(r.data)} · {daysUntil <= 0 ? 'Atrasado' : `Em ${daysUntil} dias`}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/** Dias (arredondados para cima) entre hoje e uma data-calendário completa (não dia-do-mês). */
function daysBetween(dateStr: string, today: Date): number {
  return Math.ceil((new Date(dateStr).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}
