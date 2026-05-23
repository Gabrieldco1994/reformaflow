'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { ORIGIN_COLORS, ORIGIN_ICONS, formatMesLabel, type MonthlyOverviewRow } from '../_types';

interface Props {
  meses: MonthlyOverviewRow[];
}

const ORDERED_ORIGINS = ['PESSOAL', 'REFORMA', 'CASA', 'CARRO', 'OUTROS'];

export default function MonthlyByOriginChart({ meses }: Props) {
  // Coleta todas origens presentes nos dados
  const origins = new Set<string>();
  for (const m of meses) {
    for (const k of Object.keys(m.porOrigem)) origins.add(k);
  }
  const orderedOrigins = ORDERED_ORIGINS.filter((o) => origins.has(o));
  for (const o of origins) {
    if (!orderedOrigins.includes(o)) orderedOrigins.push(o);
  }

  // Pega só os últimos 6 meses (incluindo o atual)
  const data = meses.slice(-6).map((m) => {
    const row: Record<string, unknown> = { mes: formatMesLabel(m.mes) };
    for (const o of orderedOrigins) {
      row[o] = (m.porOrigem[o]?.despesas ?? 0) / 100;
    }
    return row;
  });

  if (data.length === 0) {
    return (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h3 className="text-sm font-semibold text-darc-velvet">Gastos por origem (últimos 6 meses)</h3>
        <p className="text-xs text-darc-velvet/60 mt-2">Ainda não há dados para exibir.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-darc-velvet">Gastos por origem</h3>
        <p className="text-[10px] text-darc-velvet/60">últimos 6 meses</p>
      </div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `R$ ${(v / 1000).toFixed(0)}k`} />
            <Tooltip
              formatter={(value: number, name: string) => [formatCurrency(value), `${ORIGIN_ICONS[name] ?? ''} ${name}`]}
              labelClassName="text-darc-velvet font-medium"
            />
            <Legend
              wrapperStyle={{ fontSize: '11px' }}
              formatter={(value) => `${ORIGIN_ICONS[value] ?? ''} ${value}`}
            />
            {orderedOrigins.map((o) => (
              <Bar
                key={o}
                dataKey={o}
                stackId="a"
                fill={ORIGIN_COLORS[o] ?? '#999'}
                radius={[0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
