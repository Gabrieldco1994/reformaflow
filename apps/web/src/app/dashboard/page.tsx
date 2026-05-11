'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { DashboardResponse } from '@/types';

const PROJECT_ID = 'dev-project-1';

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

export default function DashboardPage() {
  const { data, isLoading, error } = useQuery<DashboardResponse>({
    queryKey: ['dashboard'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/dashboard`),
  });

  const despesasChartData = useMemo(() =>
    (data?.despesasMensal ?? []).map((d) => ({
      ...d,
      mesLabel: formatMesLabel(d.mes),
    })),
    [data?.despesasMensal]
  );

  const saldoChartData = useMemo(() =>
    (data?.saldoAcumuladoMensal ?? []).map((d) => ({
      ...d,
      mesLabel: formatMesLabel(d.mes),
    })),
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

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className={`rounded-xl border p-4 ${kpi.color}`}>
            <p className="text-xs font-medium opacity-75">{kpi.label}</p>
            <p className="text-lg font-bold mt-1">{formatCurrency(kpi.value / 100)}</p>
          </div>
        ))}
      </div>

      {/* Gráficos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Despesas Mensais: Planejado vs Pago */}
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

        {/* Saldo Acumulado Mensal */}
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
              {data.resumoPorAmbiente?.map((room) => (
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
              {data.resumoPorTipoDespesa?.map((item) => (
                <tr key={item.label} className="hover:bg-gray-50">
                  <td className="px-4 py-2">{item.label}</td>
                  <td className="px-4 py-2 text-right">{formatCurrency(item.total / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
              {data.resumoPorCategoria?.map((item) => (
                <tr key={item.label} className="hover:bg-gray-50">
                  <td className="px-4 py-2">{item.label}</td>
                  <td className="px-4 py-2 text-right">{formatCurrency(item.total / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
