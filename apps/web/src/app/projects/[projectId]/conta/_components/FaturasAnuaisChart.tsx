'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import type { CardInvoicesYearlyResponse } from '../_types';

const CARD_COLORS = ['#f97316', '#0ea5e9', '#22c55e', '#a855f7', '#ef4444', '#eab308', '#14b8a6', '#6366f1'];

function compactBRL(value: number) {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

export function FaturasAnuaisChart({ data }: { data: CardInvoicesYearlyResponse }) {
  const chartData = data.months.map((month) => {
    const row: Record<string, number | string> = { label: month.label, mes: month.mes };
    for (const card of data.cards) {
      row[card.last4] = (month.porCartao[card.last4] ?? 0) / 100;
    }
    return row;
  });

  const hasData = data.totalAno > 0;

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Faturas por cartão · {data.year}
          </p>
          <p className="text-lg font-bold text-slate-950">{formatCurrency(data.totalAno / 100)}</p>
        </div>
      </div>

      {!hasData ? (
        <div className="flex h-56 items-center justify-center rounded-xl bg-slate-50 text-sm text-slate-500">
          Sem faturas registradas em {data.year}.
        </div>
      ) : (
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} stroke="#e2e8f0" />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748b' }}
                stroke="#e2e8f0"
                width={52}
                tickFormatter={(value) => compactBRL(Number(value))}
              />
              <Tooltip
                cursor={{ fill: 'rgba(15,23,42,.04)' }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const total = payload.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
                  return (
                    <div className="rounded-xl border border-slate-200 bg-white p-2.5 text-xs shadow-lg">
                      <p className="mb-1 font-semibold text-slate-900">{label}</p>
                      {payload
                        .filter((item) => Number(item.value) > 0)
                        .map((item) => {
                          const card = data.cards.find((c) => c.last4 === item.dataKey);
                          return (
                            <div key={item.dataKey as string} className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-1.5 text-slate-600">
                                <span
                                  className="inline-block h-2 w-2 rounded-full"
                                  style={{ backgroundColor: item.color }}
                                />
                                {card ? `${card.nickname} · ${card.last4}` : item.dataKey}
                              </span>
                              <span className="font-medium text-slate-900">
                                {formatCurrency(Number(item.value))}
                              </span>
                            </div>
                          );
                        })}
                      <div className="mt-1 flex items-center justify-between gap-3 border-t border-slate-100 pt-1">
                        <span className="font-semibold text-slate-700">Total</span>
                        <span className="font-bold text-slate-900">{formatCurrency(total)}</span>
                      </div>
                    </div>
                  );
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '11px' }}
                formatter={(value) => {
                  const card = data.cards.find((c) => c.last4 === value);
                  return card ? `${card.nickname} · ${card.last4}` : value;
                }}
              />
              {data.cards.map((card, index) => (
                <Bar
                  key={card.last4}
                  dataKey={card.last4}
                  name={card.last4}
                  fill={CARD_COLORS[index % CARD_COLORS.length]}
                  radius={[3, 3, 0, 0]}
                  maxBarSize={28}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
