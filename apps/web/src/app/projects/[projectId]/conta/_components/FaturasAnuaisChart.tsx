'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CreditCard, Landmark } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import type { CardInvoicesYearlyResponse } from '../_types';

const CARD_COLORS = ['#0A6CF0', '#1E924A', '#C2691E', '#7A3FC2', '#D92D20', '#5E5A52'];
const CONTA_COLORS = ['#0857C4', '#7A3FC2', '#B5803A'];

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
  selectedMonth,
  onSelectMonth,
}: {
  data: CardInvoicesYearlyResponse;
  selectedKey: string | null;
  onSelectKey: (key: string | null) => void;
  selectedMonth: string | null;
  onSelectMonth: (mes: string | null) => void;
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

  const selectedMonthLabel = selectedMonth
    ? data.months.find((m) => m.mes === selectedMonth)?.label ?? null
    : null;

  return (
    <section className="space-y-3 rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
            {selectedKey ? 'Origem · ' : 'Faturas e conta · '}
            {data.year}
          </p>
          <p className="text-lg font-bold text-lifeone-ink font-geist tabular-nums">{formatCurrency(totalVisivel / 100)}</p>
        </div>
        {selectedKey && (
          selectedMonthLabel ? (
            <button
              type="button"
              onClick={() => onSelectMonth(null)}
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-lifeone-ink px-2.5 text-[11px] font-semibold text-[#FFFFFF]"
            >
              {selectedMonthLabel} · {data.year}
              <span className="text-lifeone-ink-4">✕</span>
            </button>
          ) : (
            <span className="text-[11px] text-lifeone-ink-4">Clique numa barra para ver o mês</span>
          )
        )}
      </div>

      {/* Chips de filtro por origem */}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onSelectKey(null)}
          className={`inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-semibold transition ${
            selectedKey === null
              ? 'bg-lifeone-ink text-[#FFFFFF]'
              : 'bg-lifeone-surface text-lifeone-ink-2 hover:bg-lifeone-sidebar'
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
                  ? 'border-transparent text-[#FFFFFF]'
                  : 'border-lifeone-hairline bg-lifeone-card text-lifeone-ink-2 hover:border-lifeone-blue'
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
        <div className="flex h-56 items-center justify-center rounded-xl bg-lifeone-surface text-sm text-lifeone-ink-3">
          Sem lançamentos em {data.year}.
        </div>
      ) : (
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ECE8E1" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" />
              <YAxis
                tick={{ fontSize: 11, fill: '#8A857C' }}
                stroke="#ECE8E1"
                width={52}
                tickFormatter={(value) => compactBRL(Number(value))}
              />
              <Tooltip
                cursor={{ fill: 'rgba(28,28,30,.04)' }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const total = payload.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
                  return (
                    <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card p-2.5 text-xs shadow-lifeone-hover">
                      <p className="mb-1 font-semibold text-lifeone-ink">{label}</p>
                      {payload
                        .filter((item) => Number(item.value) > 0)
                        .map((item) => {
                          const origin = data.origins.find((o) => o.key === item.dataKey);
                          return (
                            <div key={item.dataKey as string} className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-1.5 text-lifeone-ink-2">
                                <span
                                  className="inline-block h-2 w-2 rounded-full"
                                  style={{ backgroundColor: item.color }}
                                />
                                {origin ? `${origin.nickname} · ${origin.last4}` : (item.dataKey as string)}
                              </span>
                              <span className="font-medium text-lifeone-ink">
                                {formatCurrency(Number(item.value))}
                              </span>
                            </div>
                          );
                        })}
                      {payload.length > 1 && (
                        <div className="mt-1 flex items-center justify-between gap-3 border-t border-lifeone-hairline-3 pt-1">
                          <span className="font-semibold text-lifeone-ink-2">Total</span>
                          <span className="font-bold text-lifeone-ink">{formatCurrency(total)}</span>
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
                  radius={[3, 3, 0, 0]}
                  maxBarSize={selectedKey ? 40 : 28}
                  cursor="pointer"
                  onClick={(barData: { payload?: { mes?: string } }) => {
                    if (selectedKey) {
                      // Origem já filtrada: clicar na barra alterna o filtro de mês.
                      const mes = barData?.payload?.mes ?? null;
                      onSelectMonth(selectedMonth === mes ? null : mes);
                    } else {
                      // Sem origem: clicar seleciona a origem.
                      onSelectKey(origin.key);
                    }
                  }}
                >
                  {chartData.map((row) => {
                    const baseColor = colorByKey.get(origin.key)!;
                    const dimmed = !!selectedKey && !!selectedMonth && row.mes !== selectedMonth;
                    return (
                      <Cell
                        key={`${origin.key}-${row.mes}`}
                        fill={baseColor}
                        fillOpacity={dimmed ? 0.3 : 1}
                      />
                    );
                  })}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
