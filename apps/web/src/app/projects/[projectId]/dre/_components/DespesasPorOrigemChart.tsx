'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { moneyShort } from '@/lib/money';
import type { DreDespesasPorOrigem } from '../_types';

function monthShort(mes: string) {
  const [year, month] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '');
}

const CONTA_LABEL = 'Conta Corrente';
const OUTROS_LABEL = 'Outros';
// Paleta para cartões (Conta e Outros têm cor fixa para consistência).
const CARD_COLORS = ['#0A6CF0', '#7C3AED', '#DB2777', '#EA580C', '#0891B2', '#CA8A04'];

function colorFor(origem: string, cardIndex: number): string {
  if (origem === CONTA_LABEL) return '#1D9E75';
  if (origem === OUTROS_LABEL) return '#94A3B8';
  return CARD_COLORS[cardIndex % CARD_COLORS.length]!;
}

function OrigemTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number | null; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const items = payload.filter((p) => (p.value ?? 0) > 0);
  if (items.length === 0) return null;
  const total = items.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card p-2.5 text-xs shadow-lifeone-hover">
      <p className="mb-1 font-semibold text-lifeone-ink">{label}</p>
      {items.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-lifeone-ink-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
            {p.name}
          </span>
          <span className="font-semibold text-lifeone-ink tabular-nums">
            {formatCurrency((p.value ?? 0) / 100)}
          </span>
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-lifeone-hairline-3 pt-1">
        <span className="text-lifeone-ink-2">Total</span>
        <span className="font-semibold text-lifeone-ink tabular-nums">
          {formatCurrency(total / 100)}
        </span>
      </div>
    </div>
  );
}

/**
 * Barras empilhadas: despesa de cada mês quebrada por ORIGEM de pagamento
 * (Conta Corrente, cada cartão, Outros). Meses futuros/projetados aparecem com
 * opacidade reduzida (mesma convenção do gráfico de fluxo anual). Valores em
 * centavos (mesma unidade da série de saldo).
 */
export default function DespesasPorOrigemChart({ data }: { data: DreDespesasPorOrigem }) {
  const { origens, serie } = data;
  const cardOrder = origens.filter((o) => o !== CONTA_LABEL && o !== OUTROS_LABEL);

  const rows = serie.map((row) => {
    const r: Record<string, number | string | boolean> = {
      mesLabel: monthShort(row.mes),
      isFuture: row.isFuture,
    };
    for (const o of origens) r[o] = row.origens[o] ?? 0;
    return r;
  });

  return (
    <div className="h-[280px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ECE8E1" vertical={false} />
          <XAxis
            dataKey="mesLabel"
            tick={{ fontSize: 11, fill: '#8A857C' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#8A857C' }}
            width={56}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => moneyShort(v).replace('R$ ', '')}
          />
          <Tooltip content={<OrigemTooltip />} cursor={{ fill: 'rgba(10,108,240,.05)' }} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
          {origens.map((origem) => (
            <Bar key={origem} dataKey={origem} name={origem} stackId="despesa" fill={colorFor(origem, cardOrder.indexOf(origem))}>
              {rows.map((r, i) => (
                <Cell key={i} fillOpacity={r.isFuture ? 0.4 : 1} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
