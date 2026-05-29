'use client';

import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { formatMesLabel, type AccumulatedRow } from '../_types';

interface Props {
  meses: AccumulatedRow[];
}

export default function AccumulatedBalanceChart({ meses }: Props) {
  const data = meses.map((m) => ({
    mes: formatMesLabel(m.mes),
    projetado: m.saldoAcumulado / 100,
    realizado: m.saldoAcumuladoRealizado / 100,
  }));

  if (data.length === 0) {
    return (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h3 className="text-sm font-semibold text-darc-velvet">Saldo acumulado</h3>
        <p className="text-xs text-darc-velvet/60 mt-2">Ainda não há dados para exibir.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-darc-velvet">Saldo acumulado consolidado</h3>
        <p className="text-[10px] text-darc-velvet/60">caixa real vs projetado</p>
      </div>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
            <defs>
              <linearGradient id="realizadoFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#138A6B" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#138A6B" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `R$ ${(v / 1000).toFixed(0)}k`} />
            <Tooltip
              formatter={(value: number, name: string) => [formatCurrency(value), name]}
              labelClassName="text-darc-velvet font-medium"
            />
            <Legend wrapperStyle={{ fontSize: '11px' }} />
            <ReferenceLine y={0} stroke="#D72631" strokeDasharray="4 4" />
            <Area
              type="monotone"
              dataKey="realizado"
              name="Realizado (caixa)"
              stroke="#138A6B"
              strokeWidth={2}
              fill="url(#realizadoFill)"
            />
            <Line
              type="monotone"
              dataKey="projetado"
              name="Projetado (com planejados)"
              stroke="#4F000B"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
