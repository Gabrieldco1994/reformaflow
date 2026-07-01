'use client';

import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { ChartTooltip } from './ui';
import { fmtK, fmtMoney } from './format';
import type { DiaSaldo } from './derive';

export default function SaldoMesChart({ serie, hoje }: { serie: DiaSaldo[]; hoje: number }) {
  const data = serie.map((s) => ({
    dia: s.dia,
    realizado: s.realizado === null ? null : s.realizado / 100,
    projetado: s.projetado === null ? null : s.projetado / 100,
  }));

  return (
    <div className="h-[280px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 5, right: 8, left: -8, bottom: 5 }}>
          <defs>
            <linearGradient id="ckSaldoFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0A6CF0" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#0A6CF0" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#ECE8E1" />
          <XAxis dataKey="dia" tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" />
          <YAxis tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" tickFormatter={(v) => fmtK(v)} width={56} />
          <Tooltip
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                payload={payload as never}
                label={`Dia ${label}`}
                formatter={(v) => fmtMoney(v * 100)}
              />
            )}
          />
          <ReferenceLine y={0} stroke="#D92D20" strokeDasharray="3 3" />
          {hoje > 0 && hoje < data.length && (
            <ReferenceLine x={hoje} stroke="#B5803A" strokeDasharray="4 4" label={{ value: 'hoje', fontSize: 10, fill: '#B5803A', position: 'top' }} />
          )}
          <Area
            type="monotone"
            dataKey="realizado"
            name="Realizado"
            stroke="#0A6CF0"
            strokeWidth={2.5}
            fill="url(#ckSaldoFill)"
            connectNulls={false}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="projetado"
            name="Projetado"
            stroke="#B5803A"
            strokeWidth={2}
            strokeDasharray="5 4"
            connectNulls={false}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
