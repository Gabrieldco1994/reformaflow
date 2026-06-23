'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import type { PlanningProjectionRow } from '../_types';

interface PlanningProjectionChartProps {
  rows: PlanningProjectionRow[];
  targetMonthlySurplusCents: number;
}

function formatAxis(value: number): string {
  if (Math.abs(value) >= 1000) {
    return `R$ ${Math.round(value / 1000)}k`;
  }
  return `R$ ${Math.round(value)}`;
}

export default function PlanningProjectionChart({
  rows,
  targetMonthlySurplusCents,
}: PlanningProjectionChartProps) {
  const chartData = rows.map((row) => ({
    mes: row.monthLabel,
    recebimentos: row.plannedIncomeCents / 100,
    despesas: row.plannedExpenseCents / 100,
    sobra: row.monthlyBalanceCents / 100,
    saldo: row.closingBalanceCents / 100,
  }));

  return (
    <section className="rounded-2xl border border-darc-linen bg-white p-4 md:p-5">
      <h2 className="text-base font-semibold text-darc-velvet">Projeção de saldos futuros</h2>
      <p className="text-xs text-darc-velvet/60 mb-3">
        Simulação de recebimentos, despesas e saldo acumulado por mês.
      </p>

      <div className="h-[340px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ede2de" />
            <XAxis dataKey="mes" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={formatAxis} tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(value: number) => formatCurrency(value)}
              labelFormatter={(label) => `Mês: ${label}`}
            />
            <Legend />
            <ReferenceLine y={0} stroke="#e11d48" strokeDasharray="4 4" />
            <ReferenceLine
              y={targetMonthlySurplusCents / 100}
              stroke="#22c55e"
              strokeDasharray="5 5"
              label={{ value: 'meta', position: 'insideTopRight', fontSize: 11 }}
            />
            <Line
              type="monotone"
              dataKey="saldo"
              name="Saldo acumulado"
              stroke="#0f766e"
              strokeWidth={3}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="sobra"
              name="Sobra mensal"
              stroke="#ea580c"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="recebimentos"
              name="Recebimentos"
              stroke="#16a34a"
              strokeWidth={1.8}
              strokeDasharray="4 3"
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="despesas"
              name="Despesas"
              stroke="#dc2626"
              strokeWidth={1.8}
              strokeDasharray="4 3"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
