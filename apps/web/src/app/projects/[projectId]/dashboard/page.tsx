'use client';

import { useProject } from '@/contexts/project-context';
import { useAuth } from '@/contexts/auth-context';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock, Check } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { getProjectAccentColor } from '@/lib/project-colors';
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

  const accentColor = getProjectAccentColor(projectType);

  const kpis: { label: string; value: number; accent: string }[] = [
    { label: 'Dinheiro Disponível', value: data.kpis.dinheiroDisponivel, accent: accentColor },
    { label: 'Já Paguei', value: data.kpis.jaPaguei, accent: accentColor },
    { label: 'Previsão de Gastos', value: data.kpis.previsaoGastos, accent: accentColor },
    { label: 'Previsão de Recebimentos', value: data.kpis.previsaoRecebimentos, accent: accentColor },
    { label: 'Previsão de Saldo', value: data.kpis.previsaoSaldo, accent: accentColor },
    { label: 'Saldo', value: data.kpis.saldo, accent: accentColor },
  ];

  const showRooms = projectType === 'REFORMA';

  return (
    <div className="space-y-6 md:space-y-8">
      {projectType === 'PESSOAL' && (
        <Link
          href={`/projects/${projectId}/monthly`}
          className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-gradient-to-br from-indigo-50 to-rose-50 border border-indigo-100 hover:border-indigo-300 transition-colors group"
        >
          <div className="flex items-center gap-3">
            <CalendarClock className="w-5 h-5 text-indigo-700 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-darc-velvet">Visão Mensal Consolidada</p>
              <p className="text-[11px] text-darc-velvet/70 leading-snug">
                Gasto, recebido e saldo do mês — agrega Reforma, Casa e Carro
              </p>
            </div>
          </div>
          <span className="text-xs text-indigo-700 group-hover:translate-x-0.5 transition-transform">
            Ver →
          </span>
        </Link>
      )}

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
interface Maintenance { id: string; tipo: string; dataRealizada: string; dataProxima?: string; custo: number; fornecedor?: string; plantId?: string | null; }
interface Reminder { id: string; titulo: string; descricao?: string; data: string; prioridade: string; recorrencia: string; status: string; plantId?: string | null; }

function ManagementDashboard({ projectId, projectType }: { projectId: string; projectType: string }) {
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

  const accentColor = getProjectAccentColor(projectType);

  const kpis: { label: string; value: string; accent: string }[] = [
    { label: 'Contas Ativas', value: `${activeBills.length}`, accent: accentColor },
    { label: 'Custo Mensal Estimado', value: formatCurrency(totalMensal / 100), accent: accentColor },
    { label: 'Manutenções Próximas', value: `${upcomingMaintenance.length}`, accent: accentColor },
    { label: 'Lembretes Pendentes', value: `${pendingReminders.length}`, accent: accentColor },
    { label: 'Contas Vencidas', value: `${overdueBills.length}`, accent: overdueBills.length > 0 ? 'bg-darc-red-bright' : accentColor },
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
                  <p className="text-sm text-darc-velvet/70 mt-1 pl-2">Próxima: {formatDateBR(m.dataProxima!)}</p>
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

interface PlantTask {
  id: string;
  titulo: string;
  descricao?: string;
  data: string;
  origem: 'reminder' | 'maintenance';
  plantId?: string | null;
}

interface PlantSummary {
  id: string;
  nome: string;
}

function dayGroupLabel(date: Date, today: Date) {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfDay(date).getTime() - startOfDay(today).getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'Atrasadas';
  if (diffDays === 0) return 'Hoje';
  if (diffDays === 1) return 'Amanhã';
  const weekday = date.toLocaleDateString('pt-BR', { weekday: 'long' });
  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

function PlantDashboard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [completingKeys, setCompletingKeys] = useState<Set<string>>(new Set());
  const { data: maintenance } = useQuery<Maintenance[]>({
    queryKey: ['maintenance-logs', projectId],
    queryFn: () => api.get(`/projects/${projectId}/maintenance-logs`),
  });
  const { data: reminders } = useQuery<Reminder[]>({
    queryKey: ['reminders', projectId],
    queryFn: () => api.get(`/projects/${projectId}/reminders`),
  });
  const { data: plants } = useQuery<PlantSummary[]>({
    queryKey: ['plants', projectId],
    queryFn: () => api.get(`/projects/${projectId}/plants`),
  });
  const plantNameById = useMemo(
    () => new Map((plants ?? []).map((p) => [p.id, p.nome])),
    [plants],
  );

  const today = new Date();
  const in7Days = new Date(today);
  in7Days.setDate(today.getDate() + 7);

  const tasks = useMemo<PlantTask[]>(() => {
    const fromReminders = (reminders ?? [])
      .filter((r) => r.status === 'PENDENTE')
      .map((r) => ({
        id: r.id,
        titulo: r.titulo,
        descricao: r.descricao,
        data: r.data,
        origem: 'reminder' as const,
        plantId: r.plantId,
      }));

    const fromMaintenance = (maintenance ?? [])
      .filter((m) => m.dataProxima)
      .map((m) => ({
        id: m.id,
        titulo: `Cuidado: ${m.tipo}`,
        descricao: m.fornecedor,
        data: m.dataProxima!,
        origem: 'maintenance' as const,
        plantId: m.plantId,
      }));

    return [...fromReminders, ...fromMaintenance]
      .filter((t) => {
        const due = new Date(t.data);
        return due <= in7Days;
      })
      .sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());
  }, [reminders, maintenance, in7Days]);

  const overdueCount = tasks.filter((t) => new Date(t.data) < today).length;
  const thisWeekCount = tasks.length - overdueCount;

  // Agrupa por dia (Atrasadas / Hoje / Amanhã / dia da semana) preservando a ordem cronológica.
  const groupedTasks = useMemo(() => {
    const groups = new Map<string, PlantTask[]>();
    for (const task of tasks) {
      const label = dayGroupLabel(new Date(task.data), today);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(task);
    }
    return Array.from(groups.entries());
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  async function completeTask(task: PlantTask) {
    const key = `${task.origem}-${task.id}`;
    setCompletingKeys((prev) => new Set(prev).add(key));
    try {
      if (task.origem === 'reminder') {
        await api.patch(`/projects/${projectId}/reminders/${task.id}`, { status: 'CONCLUIDO' });
      } else {
        await api.patch(`/projects/${projectId}/maintenance-logs/${task.id}`, { dataProxima: null });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['reminders', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['maintenance-logs', projectId] }),
      ]);
    } finally {
      setCompletingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5">
          <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60">Atrasadas</p>
          <p className="text-2xl font-bold text-darc-red mt-2">{overdueCount}</p>
        </div>
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5">
          <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60">Próximos 7 dias</p>
          <p className="text-2xl font-bold text-darc-velvet mt-2">{thisWeekCount}</p>
        </div>
        <Link
          href={`/projects/${projectId}/plants-ai`}
          className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5 hover:border-darc-red transition-colors"
        >
          <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60">IA</p>
          <p className="text-lg font-semibold text-darc-velvet mt-2">Diagnosticar nova planta</p>
        </Link>
      </div>

      <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">📅 Cronograma semanal</h2>
        {tasks.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">Sem tarefas para os próximos 7 dias.</p>
        ) : (
          <div className="space-y-5">
            {groupedTasks.map(([label, groupTasks]) => (
              <div key={label}>
                <h3
                  className={`text-xs font-semibold tracking-[0.14em] uppercase mb-2 ${
                    label === 'Atrasadas' ? 'text-darc-red' : 'text-darc-velvet/60'
                  }`}
                >
                  {label}
                </h3>
                <div className="space-y-2">
                  {groupTasks.map((task) => {
                    const due = new Date(task.data);
                    const isOverdue = due < today;
                    const key = `${task.origem}-${task.id}`;
                    const isCompleting = completingKeys.has(key);
                    return (
                      <div
                        key={key}
                        className={`rounded-xl border p-3 flex items-start gap-3 ${isOverdue ? 'border-darc-red bg-darc-red-bright/5' : 'border-darc-linen bg-darc-linen/40'}`}
                      >
                        <button
                          onClick={() => completeTask(task)}
                          disabled={isCompleting}
                          title="Marcar como feita"
                          className={`group mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
                            isCompleting
                              ? 'border-darc-velvet/30 bg-darc-velvet/10'
                              : 'border-darc-velvet/30 hover:border-darc-red hover:bg-darc-red-bright/10'
                          }`}
                        >
                          <Check
                            className={`h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity ${
                              isCompleting ? 'text-darc-velvet/40 opacity-100' : 'text-darc-red'
                            }`}
                          />
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium text-darc-velvet">
                              {task.titulo}
                              {(plants?.length ?? 0) > 1 && task.plantId && plantNameById.has(task.plantId) && (
                                <span className="ml-2 text-xs font-normal text-darc-velvet/60">
                                  🪴 {plantNameById.get(task.plantId)}
                                </span>
                              )}
                            </p>
                            <span className="text-xs text-darc-velvet/70 whitespace-nowrap">
                              {formatDateBR(task.data)}
                            </span>
                          </div>
                          {task.descricao && <p className="text-sm text-darc-velvet/70 mt-1">{task.descricao}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { projectId, projectType, projectName } = useProject();
  const { hasModule } = useAuth();

  // PESSOAL usa o Cockpit (rota /monthly) como visão principal — redireciona.
  useEffect(() => {
    if (projectType === 'PESSOAL') {
      router.replace(`/projects/${projectId}/monthly`);
    }
  }, [projectType, projectId, router]);

  if (projectType === 'PESSOAL') return null;

  const isFinancial = projectType === 'REFORMA' || projectType === 'COMPRA';
  const isManagement = projectType === 'CASA' || projectType === 'CARRO';
  const isPlants = projectType === 'PLANTAS';

  return (
    <div className="space-y-6 md:space-y-8">
      {hasModule('financialDashboard') && (
      <Link
        href="/financeiro"
        className="hidden md:inline-flex items-center gap-1.5 text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 hover:text-darc-red transition-colors"
      >
        ← Visão Geral
      </Link>
      )}
      <header className="hidden md:block -mt-4">
        <p className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60">Visão geral do projeto</p>
        <h1 className="font-editorial italic text-3xl text-darc-velvet">{projectName}</h1>
      </header>
      <header className="md:hidden -mt-2">
        {hasModule('financialDashboard') && (
        <Link
          href="/financeiro"
          className="text-[10px] tracking-[0.18em] uppercase text-darc-velvet/60 hover:text-darc-red"
        >
          ← Visão Geral
        </Link>
        )}
        <h1 className="font-editorial italic text-2xl text-darc-velvet leading-tight mt-1">{projectName}</h1>
      </header>
      {isFinancial && <FinancialDashboard projectId={projectId} projectType={projectType} />}
      {isManagement && <ManagementDashboard projectId={projectId} projectType={projectType} />}
      {isPlants && <PlantDashboard projectId={projectId} />}
    </div>
  );
}
