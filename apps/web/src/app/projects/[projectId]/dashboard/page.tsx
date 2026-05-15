'use client';

import { useProject } from '@/contexts/project-context';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { DashboardResponse } from '@/types';
import {
  BillCategoryLabels, BillFrequencyLabels,
  ReminderPriorityLabels,
} from '@reformaflow/domain';

function formatMesLabel(mes: string) {
  const [y, m] = mes.split('-');
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${meses[parseInt(m) - 1]}/${y.slice(2)}`;
}

function ChartTooltipCurrency({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border rounded-lg shadow-lg p-3 text-xs">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {formatCurrency(p.value / 100)}
        </p>
      ))}
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

  if (isLoading) return <div className="text-gray-500">Carregando...</div>;
  if (error) return <div className="text-red-600">Erro ao carregar dashboard.</div>;
  if (!data) return null;

  const kpis = [
    { label: 'Dinheiro Disponível', value: data.kpis.dinheiroDisponivel, color: 'bg-green-50 text-green-700 border-green-200' },
    { label: 'Já Paguei', value: data.kpis.jaPaguei, color: 'bg-red-50 text-red-700 border-red-200' },
    { label: 'Previsão de Gastos', value: data.kpis.previsaoGastos, color: 'bg-orange-50 text-orange-700 border-orange-200' },
    { label: 'Previsão de Recebimentos', value: data.kpis.previsaoRecebimentos, color: 'bg-blue-50 text-blue-700 border-blue-200' },
    { label: 'Previsão de Saldo', value: data.kpis.previsaoSaldo, color: 'bg-purple-50 text-purple-700 border-purple-200' },
    { label: 'Saldo', value: data.kpis.saldo, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  ];

  const showRooms = projectType === 'REFORMA';

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className={`rounded-xl border p-4 ${kpi.color}`}>
            <p className="text-xs font-medium opacity-75">{kpi.label}</p>
            <p className="text-lg font-bold mt-1">{formatCurrency(kpi.value / 100)}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {despesasChartData.length > 0 && (
          <section className="border rounded-xl p-4">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Despesas Mensais (Planejado × Pago)</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={despesasChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="mesLabel" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v: number) => formatCurrency(v / 100)} tick={{ fontSize: 11 }} width={90} />
                <Tooltip content={<ChartTooltipCurrency />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="planejado" name="Planejado" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                <Bar dataKey="pago" name="Pago" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </section>
        )}

        {saldoChartData.length > 0 && (
          <section className="border rounded-xl p-4">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Saldo Acumulado do Fluxo de Caixa</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={saldoChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="mesLabel" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v: number) => formatCurrency(v / 100)} tick={{ fontSize: 11 }} width={90} />
                <Tooltip content={<ChartTooltipCurrency />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="recebimentos" name="Recebimentos" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="despesas" name="Despesas" stroke="#ef4444" strokeWidth={2} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="saldoAcumulado" name="Saldo Acumulado" stroke="#8b5cf6" strokeWidth={3} dot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </section>
        )}
      </div>

      {showRooms && data.resumoPorAmbiente && data.resumoPorAmbiente.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Resumo por Ambiente</h2>
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Ambiente</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600">Planejado</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600">Pago</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.resumoPorAmbiente.map((room) => (
                  <tr key={room.roomName} className="hover:bg-gray-50">
                    <td className="px-4 py-2">{room.roomName}</td>
                    <td className="px-4 py-2 text-right">{formatCurrency(room.planned / 100)}</td>
                    <td className="px-4 py-2 text-right">{formatCurrency(room.actual / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.resumoPorTipoDespesa && data.resumoPorTipoDespesa.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Resumo por Tipo de Despesa</h2>
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Tipo</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.resumoPorTipoDespesa.map((item) => (
                  <tr key={item.label} className="hover:bg-gray-50">
                    <td className="px-4 py-2">{item.label}</td>
                    <td className="px-4 py-2 text-right">{formatCurrency(item.total / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.resumoPorCategoria && data.resumoPorCategoria.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Resumo por Categoria</h2>
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Categoria</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.resumoPorCategoria.map((item) => (
                  <tr key={item.label} className="hover:bg-gray-50">
                    <td className="px-4 py-2">{item.label}</td>
                    <td className="px-4 py-2 text-right">{formatCurrency(item.total / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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

  const kpis = [
    { label: 'Contas Ativas', value: `${activeBills.length}`, color: 'bg-blue-50 text-blue-700 border-blue-200' },
    { label: 'Custo Mensal Estimado', value: formatCurrency(totalMensal / 100), color: 'bg-orange-50 text-orange-700 border-orange-200' },
    { label: 'Manutenções Próximas', value: `${upcomingMaintenance.length}`, color: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
    { label: 'Lembretes Pendentes', value: `${pendingReminders.length}`, color: 'bg-purple-50 text-purple-700 border-purple-200' },
    { label: 'Contas Vencidas', value: `${overdueBills.length}`, color: overdueBills.length > 0 ? 'bg-red-50 text-red-700 border-red-200' : 'bg-green-50 text-green-700 border-green-200' },
  ];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className={`rounded-xl border p-4 ${kpi.color}`}>
            <p className="text-xs font-medium opacity-75">{kpi.label}</p>
            <p className="text-lg font-bold mt-1">{kpi.value}</p>
          </div>
        ))}
      </div>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">📋 Contas Recorrentes</h2>
        {activeBills.length === 0 ? (
          <p className="text-gray-500 text-sm">Nenhuma conta cadastrada.</p>
        ) : (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Conta</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Categoria</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600">Valor</th>
                  <th className="text-center px-4 py-2 font-medium text-gray-600">Vencimento</th>
                  <th className="text-center px-4 py-2 font-medium text-gray-600">Frequência</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {activeBills.map((bill) => {
                  const isOverdue = today.getDate() > bill.diaVencimento;
                  return (
                    <tr key={bill.id} className={isOverdue ? 'bg-red-50' : 'hover:bg-gray-50'}>
                      <td className="px-4 py-2 font-medium">{bill.nome}{isOverdue && <span className="ml-2 text-xs text-red-600">⚠ Vencida</span>}</td>
                      <td className="px-4 py-2">{BillCategoryLabels[bill.categoria as keyof typeof BillCategoryLabels] ?? bill.categoria}</td>
                      <td className="px-4 py-2 text-right">{formatCurrency(bill.valor / 100)}</td>
                      <td className="px-4 py-2 text-center">Dia {bill.diaVencimento}</td>
                      <td className="px-4 py-2 text-center">{BillFrequencyLabels[bill.frequencia as keyof typeof BillFrequencyLabels] ?? bill.frequencia}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">🔧 Próximas Manutenções</h2>
        {upcomingMaintenance.length === 0 ? (
          <p className="text-gray-500 text-sm">Nenhuma manutenção agendada.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {upcomingMaintenance.map((m) => {
              const daysUntil = Math.ceil((new Date(m.dataProxima!).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              const urgency = daysUntil <= 7 ? 'border-red-300 bg-red-50' : daysUntil <= 30 ? 'border-yellow-300 bg-yellow-50' : 'border-gray-200';
              return (
                <div key={m.id} className={`border rounded-xl p-4 ${urgency}`}>
                  <p className="font-semibold text-gray-900">{m.tipo}</p>
                  <p className="text-sm text-gray-600 mt-1">Próxima: {new Date(m.dataProxima!).toLocaleDateString('pt-BR')}</p>
                  <p className="text-xs text-gray-500">{daysUntil <= 0 ? '⚠ Atrasada!' : `Em ${daysUntil} dias`}</p>
                  {m.fornecedor && <p className="text-xs text-gray-400 mt-1">📞 {m.fornecedor}</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">🔔 Lembretes Pendentes</h2>
        {pendingReminders.length === 0 ? (
          <p className="text-gray-500 text-sm">Nenhum lembrete pendente.</p>
        ) : (
          <div className="space-y-2">
            {pendingReminders.map((r) => {
              const daysUntil = Math.ceil((new Date(r.data).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              const priorityColors: Record<string, string> = {
                URGENTE: 'border-l-red-500 bg-red-50',
                ALTA: 'border-l-orange-500 bg-orange-50',
                MEDIA: 'border-l-yellow-500 bg-yellow-50',
                BAIXA: 'border-l-gray-400 bg-gray-50',
              };
              return (
                <div key={r.id} className={`border-l-4 rounded-lg p-3 ${priorityColors[r.prioridade] ?? 'bg-gray-50'}`}>
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-gray-900">{r.titulo}</p>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white border">
                      {ReminderPriorityLabels[r.prioridade as keyof typeof ReminderPriorityLabels] ?? r.prioridade}
                    </span>
                  </div>
                  {r.descricao && <p className="text-sm text-gray-600 mt-1">{r.descricao}</p>}
                  <p className="text-xs text-gray-500 mt-1">
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
  const { projectId, projectType } = useProject();

  const isFinancial = projectType === 'REFORMA' || projectType === 'COMPRA';
  const isManagement = projectType === 'CASA' || projectType === 'CARRO';

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      {isFinancial && <FinancialDashboard projectId={projectId} projectType={projectType} />}
      {isManagement && <ManagementDashboard projectId={projectId} projectType={projectType} />}
    </div>
  );
}
