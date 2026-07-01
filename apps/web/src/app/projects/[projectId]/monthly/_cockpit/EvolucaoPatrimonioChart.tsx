'use client';

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { ChartTooltip } from './ui';
import { fmtK, fmtMoney } from './format';
import type { MesAno } from './derive';

export default function EvolucaoPatrimonioChart({ meses }: { meses: MesAno[] }) {
  const data = meses.map((m) => ({ label: m.label, patrimonio: m.patrimonio / 100 }));

  return (
    <div className="h-[280px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 8, left: -8, bottom: 5 }}>
          <defs>
            <linearGradient id="ckPatrimonioFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1E924A" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#1E924A" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#ECE8E1" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" />
          <YAxis tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" tickFormatter={(v) => fmtK(v)} width={56} />
          <Tooltip
            content={({ active, payload, label }) => (
              <ChartTooltip active={active} payload={payload as never} label={label as string} formatter={(v) => fmtMoney(v * 100)} />
            )}
          />
          <ReferenceLine y={0} stroke="#D92D20" strokeDasharray="3 3" />
          <Area type="monotone" dataKey="patrimonio" name="Patrimônio" stroke="#1E924A" strokeWidth={2.5} fill="url(#ckPatrimonioFill)" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
