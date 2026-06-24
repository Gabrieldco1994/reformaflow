'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CreditCard, Landmark } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import type { CardInvoicesYearlyResponse } from '../_types';

const CARD_COLORS = ['#f97316', '#0ea5e9', '#22c55e', '#a855f7', '#ef4444', '#eab308'];
const CONTA_COLORS = ['#0f766e', '#7c3aed', '#b45309'];

function compactBRL(value: number) {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

export function FaturasAnuaisChart({
  data,
  selectedKey,
  onSelectKey,
}: {
  data: CardInvoicesYearlyResponse;
  selectedKey: string | null;
  onSelectKey: (key: string | null) => void;
}) {
  // Cor estável por origem (independe do filtro).
  const colorByKey = new Map<string, string>();
  let ci = 0;
  let ai = 0;
  for (const origin of data.origins) {
    colorByKey.set(origin.key, origin.kind === 'conta' ? CONTA_COLORS[ai++ % CONTA_COLORS.length] : CARD_COLORS[ci++ % CARD_COLORS.length]);
  }

  const visibleOrigins = selectedKey
    ? data.origins.filter((o) => o.key === selectedKey)
    : data.origins;

  const chartData = data.months.map((month) => {
    const row: Record<string, number | string> = { label: month.label, mes: month.mes };
    for (const origin of visibleOrigins) {
      row[origin.key] = (month.porOrigem[origin.key] ?? 0) / 100;
    }
    return row;
  });

  const totalVisivel = data.months.reduce(
    (sum, month) => sum + visibleOrigins.reduce((s, o) => s + (month.porOrigem[o.key] ?? 0), 0),
    0,
  );

  const hasData = totalVisivel > 0;

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {selectedKey ? 'Origem · ' : 'Faturas e conta · '}
            {data.year}
          </p>
          <p className="text-lg font-bold text-slate-950">{formatCurrency(totalVisivel / 100)}</p>
        </div>
      </div>

      {/* Chips de filtro por origem */}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onSelectKey(null)}
          className={`inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-semibold transition ${
            selectedKey === null
              ? 'bg-slate-900 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          Todos
        </button>
        {data.origins.map((origin) => {
          const active = selectedKey === origin.key;
          const color = colorByKey.get(origin.key);
          const Icon = origin.kind === 'conta' ? Landmark : CreditCard;
          return (
            <button
              key={origin.key}
              type="button"
              onClick={() => onSelectKey(active ? null : origin.key)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition ${
                active
                  ? 'border-transparent text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
              style={active ? { backgroundColor: color } : undefined}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: active ? '#fff' : color }}
              />
              <Icon className="h-3 w-3" />
              {origin.nickname} · {origin.last4}
            </button>
          );
        })}
      </div>

      {!hasData ? (
        <div className="flex h-56 items-center justify-center rounded-xl bg-slate-50 text-sm text-slate-500">
          Sem lançamentos em {data.year}.
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
                          const origin = data.origins.find((o) => o.key === item.dataKey);
                          return (
                            <div key={item.dataKey as string} className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-1.5 text-slate-600">
                                <span
                                  className="inline-block h-2 w-2 rounded-full"
                                  style={{ backgroundColor: item.color }}
                                />
                                {origin ? `${origin.nickname} · ${origin.last4}` : (item.dataKey as string)}
                              </span>
                              <span className="font-medium text-slate-900">
                                {formatCurrency(Number(item.value))}
                              </span>
                            </div>
                          );
                        })}
                      {payload.length > 1 && (
                        <div className="mt-1 flex items-center justify-between gap-3 border-t border-slate-100 pt-1">
                          <span className="font-semibold text-slate-700">Total</span>
                          <span className="font-bold text-slate-900">{formatCurrency(total)}</span>
                        </div>
                      )}
                    </div>
                  );
                }}
              />
              {visibleOrigins.map((origin) => (
                <Bar
                  key={origin.key}
                  dataKey={origin.key}
                  name={origin.key}
                  fill={colorByKey.get(origin.key)}
                  radius={[3, 3, 0, 0]}
                  maxBarSize={selectedKey ? 40 : 28}
                  onClick={() => onSelectKey(selectedKey === origin.key ? null : origin.key)}
                  cursor="pointer"
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
