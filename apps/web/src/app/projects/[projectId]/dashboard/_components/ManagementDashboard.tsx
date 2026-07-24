'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { KpiTile } from '@/components/KpiTile';
import { moneyGlance } from '@/lib/money';
import { isBillOverdue } from '@/lib/recurring-bill-status';
import {
  BillCategoryLabels, BillFrequencyLabels,
  ReminderPriorityLabels, hasFeature, type ProjectType,
} from '@reformaflow/domain';
import ManagementGlance from './ManagementGlance';
import ManagementFocus from './ManagementFocus';
import { useAuth } from '@/contexts/auth-context';

export interface Bill { id: string; nome: string; valor: number; categoria: string; frequencia: string; diaVencimento: number; status: string; }
export interface Maintenance { id: string; tipo: string; dataRealizada: string; dataProxima?: string; custo: number; fornecedor?: string; }
export interface Reminder { id: string; titulo: string; descricao?: string; data: string; prioridade: string; recorrencia: string; status: string; }
export interface VehicleDocument { id: string; titulo: string; tipo: string; dataVencimento: string; }
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

  const activeBills = (bills ?? []).filter(b => b.status === 'ATIVO');
  const totalMensal = activeBills.reduce((sum, b) => sum + b.valor, 0);

  const today = new Date();
  const upcomingMaintenance = (maintenance ?? [])
    .filter(m => m.dataProxima && new Date(m.dataProxima) >= today)
    .sort((a, b) => new Date(a.dataProxima!).getTime() - new Date(b.dataProxima!).getTime())
    .slice(0, 5);

  const pendingReminders = (reminders ?? [])
    .filter(r => r.status === 'PENDENTE')
    .sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime())
    .slice(0, 5);

  const overdueBills = activeBills.filter(b => isBillOverdue(b.diaVencimento, today));

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
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet">🏦 Financiamento</h2>
            <Link href={`/projects/${projectId}/financing`} className="inline-flex min-h-[44px] items-center text-sm text-darc-velvet/70 hover:underline">
              Ver detalhes
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <p className="text-xs text-darc-velvet/60">Saldo Devedor</p>
              <p className="font-bold text-darc-velvet">{formatCurrency(financing.summary.saldoDevedor / 100)}</p>
            </div>
            <div>
              <p className="text-xs text-darc-velvet/60">Progresso</p>
              <p className="font-bold text-darc-velvet">
                {financing.summary.progresso}% ({financing.summary.parcelasPagas}/{financing.summary.totalParcelas})
              </p>
              <div
                role="progressbar"
                aria-label="Progresso do financiamento"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={financing.summary.progresso}
                className="mt-2 h-2 overflow-hidden rounded-full bg-darc-linen"
              >
                <div
                  className="h-full bg-darc-red"
                  style={{ width: `${financing.summary.progresso}%` }}
                />
              </div>
            </div>
            <div>
              <p className="text-xs text-darc-velvet/60">Valor Pago</p>
              <p className="font-bold text-darc-velvet">{formatCurrency(financing.summary.valorPago / 100)}</p>
            </div>
            <div>
              <p className="text-xs text-darc-velvet/60">Próxima Parcela</p>
              <p className="font-bold text-darc-velvet">
                {financing.summary.proximaParcela
                  ? `${formatCurrency(financing.summary.proximaParcela.valorPrevisto / 100)} · ${formatDateBR(financing.summary.proximaParcela.dataVencimento)}`
                  : 'Quitado'}
              </p>
            </div>
          </div>
        </section>
      )}

      {canViewVehicleDocuments && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet">📄 Documentos</h2>
              <p className="mt-1 text-sm text-darc-velvet/60">
                {(vehicleDocuments ?? []).length === 0
                  ? 'Cadastre IPVA, seguro e licenciamento.'
                  : `${vehicleDocuments?.length} documento(s) acompanhado(s).`}
              </p>
            </div>
            <Link href={`/projects/${projectId}/vehicle-documents`} className="inline-flex min-h-[44px] items-center text-sm text-darc-velvet/70 hover:underline">
              Ver documentos
            </Link>
          </div>
          {(vehicleDocuments ?? []).slice(0, 3).map((document) => (
            <div key={document.id} className="mt-3 flex items-center justify-between gap-3 border-t border-darc-linen pt-3 text-sm">
              <span className="min-w-0 truncate font-medium text-darc-velvet">{document.titulo}</span>
              <span className="whitespace-nowrap text-darc-velvet/60">{formatDateBR(document.dataVencimento)}</span>
            </div>
          ))}
        </section>
      )}

      <section className="hidden md:block rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">📋 Contas Recorrentes</h2>
        {activeBills.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">Nenhuma conta cadastrada.</p>
        ) : (
          <div className="divide-y divide-darc-linen">
            {activeBills.map((bill) => {
              const isOverdue = today.getDate() > bill.diaVencimento;
              return (
                <div key={bill.id} className={`flex items-center justify-between gap-3 py-3 ${isOverdue ? 'bg-darc-red-bright/5 -mx-2 px-2 rounded-lg' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-darc-velvet truncate">
                      {bill.nome}
                      {isOverdue && <span className="ml-2 text-xs text-darc-red">⚠ Vencida</span>}
                    </p>
                    <p className="text-xs text-darc-velvet/60 mt-0.5">
                      {BillCategoryLabels[bill.categoria as keyof typeof BillCategoryLabels] ?? bill.categoria}
                      {' · '}
                      Dia {bill.diaVencimento}
                      {' · '}
                      {BillFrequencyLabels[bill.frequencia as keyof typeof BillFrequencyLabels] ?? bill.frequencia}
                    </p>
                  </div>
                  <span className="text-sm font-bold text-darc-velvet whitespace-nowrap">{formatCurrency(bill.valor / 100)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="hidden md:block rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">🔧 Próximas Manutenções</h2>
        {upcomingMaintenance.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">Nenhuma manutenção agendada.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {upcomingMaintenance.map((m) => {
              const daysUntil = Math.ceil((new Date(m.dataProxima!).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              const accent = daysUntil <= 7 ? 'bg-darc-red-bright' : daysUntil <= 30 ? 'bg-darc-sunfire' : 'bg-darc-mist';
              return (
                <div key={m.id} className="rounded-xl bg-darc-linen/40 p-3 relative overflow-hidden">
                  <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-r-full ${accent}`} />
                  <p className="font-semibold text-darc-velvet pl-2">{m.tipo}</p>
                  <p className="text-sm text-darc-velvet/70 mt-1 pl-2">Próxima: {formatDateBR(m.dataProxima!)}</p>
                  <p className="text-xs text-darc-velvet/60 pl-2">{daysUntil <= 0 ? '⚠ Atrasada!' : `Em ${daysUntil} dias`}</p>
                  {m.fornecedor && <p className="text-xs text-darc-velvet/50 mt-1 pl-2">📞 {m.fornecedor}</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="hidden md:block rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">🔔 Lembretes Pendentes</h2>
        {pendingReminders.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">Nenhum lembrete pendente.</p>
        ) : (
          <div className="space-y-2">
            {pendingReminders.map((r) => {
              const daysUntil = Math.ceil((new Date(r.data).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              const priorityColors: Record<string, string> = {
                URGENTE: 'border-l-darc-red-bright',
                ALTA: 'border-l-darc-sunfire',
                MEDIA: 'border-l-darc-pink',
                BAIXA: 'border-l-darc-mist',
              };
              return (
                <div key={r.id} className={`border-l-4 ${priorityColors[r.prioridade] ?? 'border-l-darc-mist'} bg-darc-linen/40 rounded-r-lg p-3`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-darc-velvet">{r.titulo}</p>
                    <span className="text-[10px] uppercase tracking-[0.15em] px-2 py-0.5 rounded-full bg-white border border-darc-linen text-darc-velvet/70">
                      {ReminderPriorityLabels[r.prioridade as keyof typeof ReminderPriorityLabels] ?? r.prioridade}
                    </span>
                  </div>
                  {r.descricao && <p className="text-sm text-darc-velvet/70 mt-1">{r.descricao}</p>}
                  <p className="text-xs text-darc-velvet/60 mt-1">
                    {formatDateBR(r.data)} · {daysUntil <= 0 ? '⚠ Atrasado!' : `Em ${daysUntil} dias`}
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
