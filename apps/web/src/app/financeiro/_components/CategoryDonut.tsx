'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatCurrency } from '@/lib/utils';
import type { CategoryRow } from '../_types';

const COLORS = ['#a3253d', '#ef6c00', '#0f766e', '#4c1d95', '#be185d', '#1e3a8a', '#0891b2', '#65a30d'];

export default function CategoryDonut({ rows }: { rows: CategoryRow[] }) {
  if (rows.length === 0) return null;

  // Top 6 + outros
  const top = rows.slice(0, 6);
  const restoTotal = rows.slice(6).reduce((s, r) => s + r.total, 0);
  const data = restoTotal > 0
    ? [...top, { key: '__outros__', label: 'Outros', total: restoTotal }]
    : top;

  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
      <h3 className="font-editorial italic text-base md:text-lg text-darc-velvet mb-3">Distribuição por Categoria</h3>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="total"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              paddingAngle={2}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(v: number) => formatCurrency(v / 100)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
