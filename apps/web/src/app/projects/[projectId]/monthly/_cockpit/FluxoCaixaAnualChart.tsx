'use client';

import {
  ComposedChart, Bar, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { ChartTooltip } from './ui';
import { fmtK, fmtMoney } from './format';
import type { MesAno } from './derive';

export default function FluxoCaixaAnualChart({ meses }: { meses: MesAno[] }) {
  const data = meses.map((m) => ({
    label: m.label,
    receita: m.rec / 100,
    despesa: m.desp / 100,
    sobra: m.sobra / 100,
    real: m.real,
  }));

  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 5, right: 8, left: -8, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ECE8E1" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" />
          <YAxis tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" tickFormatter={(v) => fmtK(v)} width={56} />
          <Tooltip
            cursor={{ fill: 'rgba(10,108,240,.05)' }}
            content={({ active, payload, label }) => (
              <ChartTooltip active={active} payload={payload as never} label={label as string} formatter={(v) => fmtMoney(v * 100)} />
            )}
          />
          <Legend wrapperStyle={{ fontSize: '11px', color: '#8A857C' }} />
          <Bar dataKey="receita" name="Receita" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={`r${i}`} fill="#1E924A" fillOpacity={d.real ? 1 : 0.4} />
            ))}
          </Bar>
          <Bar dataKey="despesa" name="Despesa" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={`d${i}`} fill="#D92D20" fillOpacity={d.real ? 1 : 0.4} />
            ))}
          </Bar>
          <Line type="monotone" dataKey="sobra" name="Sobra" stroke="#0A6CF0" strokeWidth={2} dot={{ r: 2.5, fill: '#0A6CF0' }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
