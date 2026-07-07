'use client';

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { moneyShort } from '@/lib/money';
import type { DreDespesasPorOrigem, DreSaldoAcumuladoRow } from '../_types';

function monthShort(mes: string) {
  const [year, month] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '');
}

const CONTA_LABEL = 'Conta Corrente';
const OUTROS_LABEL = 'Outros';
const SALDO_LABEL = 'Saldo';
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
  payload?: { name: string; value: number | null; color: string; dataKey?: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  // Separa as barras de origem (empilhadas) da linha de Saldo.
  const barras = payload.filter((p) => p.dataKey !== SALDO_LABEL && (p.value ?? 0) > 0);
  const saldo = payload.find((p) => p.dataKey === SALDO_LABEL);
  const total = barras.reduce((s, p) => s + (p.value ?? 0), 0);
  if (barras.length === 0 && saldo?.value == null) return null;
  return (
    <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card p-2.5 text-xs shadow-lifeone-hover">
      <p className="mb-1 font-semibold text-lifeone-ink">{label}</p>
      {barras.map((p) => (
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
      {barras.length > 0 && (
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-lifeone-hairline-3 pt-1">
          <span className="text-lifeone-ink-2">Total do mês</span>
          <span className="font-semibold text-lifeone-ink tabular-nums">
            {formatCurrency(total / 100)}
          </span>
        </div>
      )}
      {saldo?.value != null && (
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-lifeone-hairline-3 pt-1">
          <span className="flex items-center gap-1.5 text-lifeone-ink-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: saldo.color }} />
            {SALDO_LABEL} acumulado
          </span>
          <span className="font-semibold text-lifeone-ink tabular-nums">
            {formatCurrency((saldo.value ?? 0) / 100)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Barras empilhadas: despesa de cada mês quebrada por ORIGEM de pagamento
 * (Conta Corrente, cada cartão, Outros), com uma LINHA de Saldo acumulado
 * sobreposta (eixo Y secundário, pois a escala do acumulado difere das saídas
 * mensais). O modo controla o que aparece:
 *  - 'projetado': total (realizado + planejado); meses futuros com opacidade
 *    reduzida; linha = saldoProjetado.
 *  - 'realizado': só saídas pagas (planejados/futuros zeram); linha = saldoRealizado.
 * Valores em centavos (mesma unidade da série de saldo).
 */
export default function DespesasPorOrigemChart({
  data,
  saldoSerie,
  mode,
}: {
  data: DreDespesasPorOrigem;
  saldoSerie: DreSaldoAcumuladoRow[];
  mode: 'projetado' | 'realizado';
}) {
  const { origens } = data;
  const cardOrder = origens.filter((o) => o !== CONTA_LABEL && o !== OUTROS_LABEL);
  const saldoByMes = new Map(saldoSerie.map((r) => [r.mes, r] as const));

  const rows = data.serie.map((row) => {
    const src = mode === 'realizado' ? row.origensRealizado : row.origens;
    const saldoRow = saldoByMes.get(row.mes);
    const r: Record<string, number | string | boolean | null> = {
      mesLabel: monthShort(row.mes),
      // No modo realizado, meses futuros não são atenuados (já vêm zerados).
      isFuture: mode === 'projetado' ? row.isFuture : false,
      [SALDO_LABEL]:
        mode === 'realizado'
          ? (saldoRow?.saldoRealizado ?? null)
          : (saldoRow?.saldoProjetado ?? null),
    };
    for (const o of origens) r[o] = src[o] ?? 0;
    return r;
  });

  return (
    <div className="h-[280px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ECE8E1" vertical={false} />
          <XAxis
            dataKey="mesLabel"
            tick={{ fontSize: 11, fill: '#8A857C' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="despesa"
            tick={{ fontSize: 11, fill: '#8A857C' }}
            width={56}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => moneyShort(v).replace('R$ ', '')}
          />
          <YAxis
            yAxisId="saldo"
            orientation="right"
            tick={{ fontSize: 11, fill: '#0F6B4D' }}
            width={56}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => moneyShort(v).replace('R$ ', '')}
          />
          <Tooltip content={<OrigemTooltip />} cursor={{ fill: 'rgba(10,108,240,.05)' }} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
          {origens.map((origem) => (
            <Bar
              key={origem}
              yAxisId="despesa"
              dataKey={origem}
              name={origem}
              stackId="despesa"
              fill={colorFor(origem, cardOrder.indexOf(origem))}
            >
              {rows.map((r, i) => (
                <Cell key={i} fillOpacity={r.isFuture ? 0.4 : 1} />
              ))}
            </Bar>
          ))}
          <Line
            yAxisId="saldo"
            type="monotone"
            dataKey={SALDO_LABEL}
            name={mode === 'realizado' ? 'Saldo realizado' : 'Saldo projetado'}
            isAnimationActive={false}
            stroke="#0F6B4D"
            strokeWidth={2}
            strokeDasharray={mode === 'projetado' ? '6 4' : undefined}
            dot={{ r: 2.5, fill: '#0F6B4D' }}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
