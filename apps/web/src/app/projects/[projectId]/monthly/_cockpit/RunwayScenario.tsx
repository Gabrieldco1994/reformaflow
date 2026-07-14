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

  const dezembro = forward.at(-1) ? forward.at(-1)!.saldoProjetado + deltaMonth : null;
  const hojeSaldo = dailySerie[Math.max(0, hoje - 1)]?.realizado ?? dailySerie[0]?.realizado ?? dailySerie[0]?.projetado ?? 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--ck-muted)]">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#0A6CF0]" /> Fluxo realizado</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#B5803A]" /> Fluxo projetado</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#1E924A]" /> Vai até dezembro</span>
      </div>
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
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8A857C' }} stroke="#ECE8E1" interval="preserveStartEnd" />
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
              strokeWidth={2.5}
              connectNulls={true}
              dot={{ r: 2.5 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--ck-muted)]">Hoje</p>
          <p className="font-geist text-sm font-semibold tabular-nums text-[var(--ck-text)]">{fmtMoney(hojeSaldo)}</p>
        </div>
        <div className="rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--ck-muted)]">Fechamento do mês</p>
          <p className="font-geist text-sm font-semibold tabular-nums text-[var(--ck-text)]">{fmtMoney(dailyEnd + deltaMonth)}</p>
        </div>
        <div className="rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--ck-muted)]">Projeção dezembro</p>
          <p className="font-geist text-sm font-semibold tabular-nums text-[var(--ck-text)]">{dezembro === null ? '—' : fmtMoney(dezembro)}</p>
        </div>
      </div>
    </div>
  );
}
