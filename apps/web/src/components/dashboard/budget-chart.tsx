'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { RoomSummary } from '@/types/dashboard';
import { formatCurrency } from '@/lib/utils';

interface BudgetChartProps {
  rooms: RoomSummary[];
}

export function BudgetChart({ rooms }: BudgetChartProps) {
  const chartData = rooms
    .filter((r) => r.planned > 0 || r.actual > 0)
    .map((r) => ({
      name: r.roomName.length > 12 ? r.roomName.slice(0, 12) + '…' : r.roomName,
      Previsto: r.planned,
      Realizado: r.actual,
    }));

  if (chartData.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">
          📊 Previsto × Realizado por Ambiente
        </h2>
        <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
          Nenhum valor previsto cadastrado ainda
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">
        📊 Previsto × Realizado por Ambiente
      </h2>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="name" fontSize={11} tickLine={false} />
          <YAxis
            fontSize={11}
            tickLine={false}
            tickFormatter={(v: number) => `R$${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip
            formatter={(value: number) => formatCurrency(value)}
            labelStyle={{ fontWeight: 600 }}
          />
          <Legend />
          <Bar dataKey="Previsto" fill="#3b82f6" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Realizado" fill="#ef4444" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
