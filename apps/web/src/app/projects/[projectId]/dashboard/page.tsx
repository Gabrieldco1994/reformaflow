'use client';

import { useProject } from '@/contexts/project-context';
import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { DashboardResponse } from '@/types';
import {
  BillCategoryLabels, BillFrequencyLabels,
  ReminderPriorityLabels,
} from '@reformaflow/domain';

const DashboardCharts = dynamic(
  () => import('./_components/DashboardCharts'),
  {
    ssr: false,
    loading: () => (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 h-[340px] animate-pulse" />
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 h-[340px] animate-pulse" />
      </div>
    ),
  },
);

function formatMesLabel(mes: string) {
  const [y, m] = mes.split('-');
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${meses[parseInt(m) - 1]}/${y.slice(2)}`;
}

// ─── Skeleton para reservar layout (evita CLS) ──────────────

function FinancialDashboardSkeleton() {
  return (
    <div className="space-y-6 md:space-y-8 animate-pulse">
      {/* KPIs mobile */}
      <div className="md:hidden -mx-4 px-4 overflow-x-hidden">
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-[78%] h-[88px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
          <div className="flex-shrink-0 w-[78%] h-[88px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        </div>
      </div>
      {/* KPIs desktop (6 cards) */}
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[96px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        ))}
      </div>
      {/* Charts (2x 340px) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        <div className="h-[340px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        <div className="h-[340px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
      </div>
      {/* Resumo section */}
      <div className="h-[200px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
    </div>
  );
}

// ─── Financial Dashboard (REFORMA / COMPRA) ──────────────────

function FinancialDashboard({ projectId, projectType }: { projectId: string; projectType: string }) {
  const { data, isLoading, error } = useQuery<DashboardResponse>({
    queryKey: ['dashboard', projectId],
    queryFn: () => api.get(`/projects/${projectId}/dashboard`),
  });

  const despesasChartData = useMemo(() =>
    (data?.despesasMensal ?? []).map((d) => ({ ...d, mesLabel: formatMesLabel(d.mes) })),
    [data?.despesasMensal]
  );

  const saldoChartData = useMemo(() =>
    (data?.saldoAcumuladoMensal ?? []).map((d) => ({ ...d, mesLabel: formatMesLabel(d.mes) })),
    [data?.saldoAcumuladoMensal]
  );

  if (isLoading) return <FinancialDashboardSkeleton />;
  if (error) return <div className="text-darc-red">Erro ao carregar dashboard.</div>;
  if (!data) return null;

  const kpis: { label: string; value: number; accent: string }[] = [
    { label: 'Dinheiro Disponível', value: data.kpis.dinheiroDisponivel, accent: 'bg-darc-mist' },
    { label: 'Já Paguei', value: data.kpis.jaPaguei, accent: 'bg-darc-raspberry' },
    { label: 'Previsão de Gastos', value: data.kpis.previsaoGastos, accent: 'bg-darc-sunfire' },
    { label: 'Previsão de Recebimentos', value: data.kpis.previsaoRecebimentos, accent: 'bg-darc-pink-logo' },
    { label: 'Previsão de Saldo', value: data.kpis.previsaoSaldo, accent: 'bg-darc-velvet' },
    { label: 'Saldo', value: data.kpis.saldo, accent: 'bg-darc-red-bright' },
  ];

  const showRooms = projectType === 'REFORMA';

  return (
    <div className="space-y-6 md:space-y-8">
      {/* KPIs — scroll horizontal premium no mobile, grid no desktop */}
      <div className="md:hidden -mx-4 px-4 overflow-x-auto scrollbar-hide">
        <div className="flex gap-3 snap-x snap-mandatory">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="snap-start flex-shrink-0 w-[78%] rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 relative overflow-hidden"
            >
              <span className={`absolute left-0 top-4 bottom-4 w-1 rounded-r-full ${kpi.accent}`} />
              <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 pl-3">{kpi.label}</p>
              <p className="text-2xl font-bold text-darc-velvet mt-2 pl-3">{formatCurrency(kpi.value / 100)}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5 relative overflow-hidden"
          >
            <span className={`absolute left-0 top-5 bottom-5 w-1 rounded-r-full ${kpi.accent}`} />
            <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 pl-3">{kpi.label}</p>
            <p className="text-xl lg:text-2xl font-bold text-darc-velvet mt-2 pl-3">{formatCurrency(kpi.value / 100)}</p>
          </div>
        ))}
      </div>

      <DashboardCharts
        despesasChartData={despesasChartData}
        saldoChartData={saldoChartData}
      />

      {showRooms && data.resumoPorAmbiente && data.resumoPorAmbiente.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">Resumo por Ambiente</h2>
          {/* Desktop: tabela */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-darc-linen">
                  <th className="text-left px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">Ambiente</th>
                  <th className="text-right px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">Planejado</th>
                  <th className="text-right px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">Pago</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-darc-linen">
                {data.resumoPorAmbiente.map((room) => (
                  <tr key={room.roomName} className="hover:bg-darc-linen/40">
                    <td className="px-3 py-3 text-darc-velvet">{room.roomName}</td>
                    <td className="px-3 py-3 text-right text-darc-velvet">{formatCurrency(room.planned / 100)}</td>
                    <td className="px-3 py-3 text-right font-semibold text-darc-raspberry">{formatCurrency(room.actual / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile: lista */}
          <div className="md:hidden space-y-2">
            {data.resumoPorAmbiente.map((room) => (
              <div key={room.roomName} className="flex items-center justify-between py-2 border-b border-darc-linen last:border-0">
                <span className="text-sm font-medium text-darc-velvet">{room.roomName}</span>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-[0.15em] text-darc-velvet/50">{formatCurrency(room.planned / 100)} planejado</p>
                  <p className="text-sm font-bold text-darc-raspberry">{formatCurrency(room.actual / 100)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.resumoPorTipoDespesa && data.resumoPorTipoDespesa.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">Resumo por Tipo de Despesa</h2>
          <div className="divide-y divide-darc-linen">
            {data.resumoPorTipoDespesa.map((item) => (
              <div key={item.label} className="flex items-center justify-between py-2.5">
                <span className="text-sm text-darc-velvet">{item.label}</span>
                <span className="text-sm font-semibold text-darc-velvet">{formatCurrency(item.total / 100)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.resumoPorCategoria && data.resumoPorCategoria.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">Resumo por Categoria</h2>
          <div className="divide-y divide-darc-linen">
            {data.resumoPorCategoria.map((item) => (
              <div key={item.label} className="flex items-center justify-between py-2.5">
                <span className="text-sm text-darc-velvet">{item.label}</span>
                <span className="text-sm font-semibold text-darc-velvet">{formatCurrency(item.total / 100)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Management Dashboard (CASA / CARRO) ────────────────────

interface Bill { id: string; nome: string; valor: number; categoria: string; frequencia: string; diaVencimento: number; status: string; }
interface Maintenance { id: string; tipo: string; dataRealizada: string; dataProxima?: string; custo: number; fornecedor?: string; }
interface Reminder { id: string; titulo: string; descricao?: string; data: string; prioridade: string; recorrencia: string; status: string; }

function ManagementDashboard({ projectId }: { projectId: string; projectType: string }) {
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

  const overdueBills = activeBills.filter(b => today.getDate() > b.diaVencimento);

  const kpis: { label: string; value: string; accent: string }[] = [
    { label: 'Contas Ativas', value: `${activeBills.length}`, accent: 'bg-darc-mist' },
    { label: 'Custo Mensal Estimado', value: formatCurrency(totalMensal / 100), accent: 'bg-darc-sunfire' },
    { label: 'Manutenções Próximas', value: `${upcomingMaintenance.length}`, accent: 'bg-darc-pink-logo' },
    { label: 'Lembretes Pendentes', value: `${pendingReminders.length}`, accent: 'bg-darc-velvet' },
    { label: 'Contas Vencidas', value: `${overdueBills.length}`, accent: overdueBills.length > 0 ? 'bg-darc-red-bright' : 'bg-darc-raspberry' },
  ];

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="md:hidden -mx-4 px-4 overflow-x-auto scrollbar-hide">
        <div className="flex gap-3 snap-x snap-mandatory">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="snap-start flex-shrink-0 w-[78%] rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 relative overflow-hidden"
            >
              <span className={`absolute left-0 top-4 bottom-4 w-1 rounded-r-full ${kpi.accent}`} />
              <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 pl-3">{kpi.label}</p>
              <p className="text-2xl font-bold text-darc-velvet mt-2 pl-3">{kpi.value}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5 relative overflow-hidden"
          >
            <span className={`absolute left-0 top-5 bottom-5 w-1 rounded-r-full ${kpi.accent}`} />
            <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 pl-3">{kpi.label}</p>
            <p className="text-xl lg:text-2xl font-bold text-darc-velvet mt-2 pl-3">{kpi.value}</p>
          </div>
        ))}
      </div>

      <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
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

      <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
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
                  <p className="text-sm text-darc-velvet/70 mt-1 pl-2">Próxima: {new Date(m.dataProxima!).toLocaleDateString('pt-BR')}</p>
                  <p className="text-xs text-darc-velvet/60 pl-2">{daysUntil <= 0 ? '⚠ Atrasada!' : `Em ${daysUntil} dias`}</p>
                  {m.fornecedor && <p className="text-xs text-darc-velvet/50 mt-1 pl-2">📞 {m.fornecedor}</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
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
                    {new Date(r.data).toLocaleDateString('pt-BR')} · {daysUntil <= 0 ? '⚠ Atrasado!' : `Em ${daysUntil} dias`}
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

// ─── Main Dashboard ─────────────────────────────────────────

export default function DashboardPage() {
  const { projectId, projectType, projectName } = useProject();

  const isFinancial = projectType === 'REFORMA' || projectType === 'COMPRA';
  const isManagement = projectType === 'CASA' || projectType === 'CARRO';

  return (
    <div className="space-y-6 md:space-y-8">
      <header className="hidden md:block">
        <p className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60">Visão geral</p>
        <h1 className="font-editorial italic text-3xl text-darc-velvet">{projectName}</h1>
      </header>
      <header className="md:hidden -mt-2">
        <p className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60">Dashboard</p>
        <h1 className="font-editorial italic text-2xl text-darc-velvet leading-tight">{projectName}</h1>
      </header>
      {isFinancial && <FinancialDashboard projectId={projectId} projectType={projectType} />}
      {isManagement && <ManagementDashboard projectId={projectId} projectType={projectType} />}
    </div>
  );
}
