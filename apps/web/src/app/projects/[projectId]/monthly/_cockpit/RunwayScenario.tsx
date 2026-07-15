'use client';

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';
import type { DiaSaldo } from './derive';
import { ChartTooltip } from './ui';
import { fmtK, fmtMoney, mesCurto } from './format';

/**
 * Gráfico único do desktop: fluxo diário do mês + runway até dezembro.
 * O slider de ritmo ajusta o fechamento do mês e desloca o runway futuro.
 */
export function RunwayScenario({
  dailySerie,
  hoje,
  runwaySerie,
  currentMonth,
  ritmo,
  ritmoBase,
}: {
  dailySerie: DiaSaldo[];
  hoje: number;
  runwaySerie?: DreSaldoAcumuladoRow[];
  currentMonth: string;
  ritmo: number;
  ritmoBase: number;
}) {
  const [yearStr] = currentMonth.split('-');
  const year = Number.parseInt(yearStr ?? '0', 10);
  const cutoff = `${year}-12`;
  const remainingDays = Math.max(0, dailySerie.length - hoje);
  const deltaMonth = -(ritmo - ritmoBase) * remainingDays;
  const dailyEnd = dailySerie.at(-1)?.projetado ?? dailySerie.at(-1)?.realizado ?? 0;
  const lastDay = dailySerie.at(-1)?.dia ?? 0;
  const todayLabel = `D${hoje}`;
  const lastDayLabel = `D${lastDay}`;

  const forward = (runwaySerie ?? []).filter((row) => row.mes >= currentMonth && row.mes <= cutoff);

  const data = dailySerie.map((row) => ({
    key: `d-${row.dia}`,
    label: `D${row.dia}`,
    realizado: row.realizado === null ? null : row.realizado / 100,
    projetado: row.projetado === null ? null : row.projetado / 100,
    runway: null as number | null,
  }));

  if (data.length > 0) {
    const firstRunway = forward[0]?.saldoProjetado ?? dailyEnd;
    data[data.length - 1].runway = (firstRunway + deltaMonth) / 100;
  }

  for (let i = 1; i < forward.length; i += 1) {
    const [y, m] = forward[i].mes.split('-').map((n) => Number.parseInt(n, 10));
    data.push({
      key: `m-${forward[i].mes}`,
      label: `${mesCurto((m || 1) - 1)}/${String(y || 0).slice(-2)}`,
      realizado: null,
      projetado: null,
      runway: (forward[i].saldoProjetado + deltaMonth) / 100,
    });
  }

  return (
    <div className="h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 5, right: 8, left: -8, bottom: 5 }}>
          <defs>
            <linearGradient id="ckSaldoFillMerged" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0A6CF0" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#0A6CF0" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#ECE8E1" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#8A857C' }}
            stroke="#ECE8E1"
            interval="preserveStartEnd"
            tickFormatter={(value: string) => {
              if (!value.startsWith('D')) return value;
              if (value === 'D1' || value === todayLabel || value === lastDayLabel) return value;
              return '';
            }}
          />
          <YAxis tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" tickFormatter={(v) => fmtK(v)} width={56} />
          <Tooltip
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                payload={payload as never}
                label={String(label)}
                formatter={(v) => fmtMoney(v * 100)}
              />
            )}
          />
          <ReferenceLine y={0} stroke="#D92D20" strokeDasharray="3 3" />
          <Area
            type="monotone"
            dataKey="realizado"
            name="Fluxo realizado"
            stroke="#0A6CF0"
            strokeWidth={2.5}
            fill="url(#ckSaldoFillMerged)"
            connectNulls={false}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="projetado"
            name="Fluxo projetado"
            stroke="#B5803A"
            strokeWidth={2}
            strokeDasharray="5 4"
            connectNulls={false}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="runway"
            name="Vai até dezembro"
            stroke="#1E924A"
            strokeWidth={2}
            strokeDasharray="4 4"
            strokeOpacity={0.9}
            connectNulls={true}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
