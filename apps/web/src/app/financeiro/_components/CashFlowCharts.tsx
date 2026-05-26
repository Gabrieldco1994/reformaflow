'use client';

import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { PROJECT_TYPE_COLORS } from '../_types';
import type { ConsolidatedCashFlowPoint, ProjectBreakdownRow } from '../_types';

function formatMesLabel(mes: string) {
  const [y, m] = mes.split('-');
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${meses[parseInt(m) - 1]}/${y.slice(2)}`;
}

function compactCurrency(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1000000) return `R$ ${(value / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `R$ ${(value / 1000).toFixed(0)}k`;
  return `R$ ${value.toFixed(0)}`;
}

export default function CashFlowCharts({
  cashFlow,
  byProject,
}: {
  cashFlow: ConsolidatedCashFlowPoint[];
  byProject: ProjectBreakdownRow[];
}) {
  const chartData = cashFlow.map((p) => ({
    ...p,
    mesLabel: formatMesLabel(p.mes),
    pagoR: p.pago / 100,
    planejadoR: p.planejado / 100,
    recebidoR: p.recebido / 100,
    saldoR: p.saldoAcumulado / 100,
  }));

  const stackData = cashFlow.map((p) => {
    const row: Record<string, number | string> = { mes: formatMesLabel(p.mes) };
    for (const proj of byProject) {
      const v = (p.byProject[proj.projectId]?.pago ?? 0) / 100;
      row[proj.projectId] = v;
    }
    return row;
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
      {/* Linha: planejado vs pago vs recebido */}
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h3 className="font-editorial italic text-base md:text-lg text-darc-velvet mb-3">Fluxo Mensal Consolidado</h3>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f5e7e0" />
              <XAxis dataKey="mesLabel" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => compactCurrency(v)} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="pagoR" name="Pago" stroke="#a3253d" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="planejadoR" name="Planejado" stroke="#ef6c00" strokeWidth={2} dot={false} strokeDasharray="5 5" />
              <Line type="monotone" dataKey="recebidoR" name="Recebido" stroke="#0f766e" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="saldoR" name="Saldo Acum." stroke="#4c1d95" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Barras empilhadas por projeto */}
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h3 className="font-editorial italic text-base md:text-lg text-darc-velvet mb-3">Gastos por Projeto (pago)</h3>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stackData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f5e7e0" />
              <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => compactCurrency(v)} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {byProject.map((p) => (
                <Bar
                  key={p.projectId}
                  dataKey={p.projectId}
                  name={p.name}
                  stackId="a"
                  fill={PROJECT_TYPE_COLORS[p.type] ?? '#999'}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
