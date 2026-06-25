'use client';

import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import type { DreAnual } from '../_types';
import { DreIcon } from './DreIcon';

export type DreAnualChartMode = 'receitaDespesa' | 'margem';

function monthShort(mes: string) {
  const [year, month] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '');
}

function miniPointTone(receita: number, despesa: number) {
  const margem = receita - despesa;
  if (margem < 0) return 'bg-[#D85A30]';
  if (receita > 0 && despesa / receita > 0.9) return 'bg-[#BA7517]';
  return 'bg-[#1D9E75]';
}

function chartRows(data: DreAnual) {
  return data.serie.map((row) => ({
    ...row,
    mesLabel: monthShort(row.mes),
    receitaReal: row.receita,
    despesaReal: row.despesa,
    receitaProj: row.projecaoReceita,
    despesaProj: row.projecaoDespesa,
    margemReal:
      row.margem ??
      (row.receita != null && row.despesa != null ? row.receita - row.despesa : null),
    margemProj:
      row.projecaoMargem ??
      (row.projecaoReceita != null && row.projecaoDespesa != null
        ? row.projecaoReceita - row.projecaoDespesa
        : null),
  }));
}

export function DreAnualView({
  data,
  mode,
  onChangeMode,
}: {
  data: DreAnual;
  mode: DreAnualChartMode;
  onChangeMode: (next: DreAnualChartMode) => void;
}) {
  const rows = chartRows(data);
  const maxBar = rows.reduce((max, row) => {
    const receita = row.receitaReal ?? row.receitaProj ?? 0;
    const despesa = row.despesaReal ?? row.despesaProj ?? 0;
    return Math.max(max, receita, despesa);
  }, 1);

  const riskRow = rows.find((row) => row.isCritical || (row.margemReal ?? row.margemProj ?? 0) < 600);
  const riskTone = riskRow ? 'bg-[#FAEEDA] border-[#EFD9B6] text-[#BA7517]' : 'bg-[#E1F5EE] border-[#BFE9DA] text-[#1D9E75]';

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3">
        <SummaryCard
          label="entrou no ano"
          value={formatCurrency(data.totalEntrou / 100)}
          sub={data.ateOMes}
          tone="green"
        />
        <SummaryCard
          label="saiu no ano"
          value={formatCurrency(data.totalSaiu / 100)}
          sub={`média ${formatCurrency(data.mediaMensal / 100)}/mês`}
          tone="red"
        />
        <SummaryCard
          label="resultado acumulado"
          value={formatCurrency(data.resultadoAcumulado / 100)}
          sub="entradas − saídas − guardado"
          tone={data.resultadoAcumulado >= 0 ? 'green' : 'red'}
        />
        <SummaryCard
          label="mês mais crítico"
          value={monthShort(data.mesCritico.mes)}
          sub={`margem ${formatCurrency(data.mesCritico.margem / 100)}`}
          tone="amber"
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => onChangeMode('receitaDespesa')}
            className={`h-11 rounded-lg px-4 text-sm font-semibold ${
              mode === 'receitaDespesa' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            receita × despesa
          </button>
          <button
            type="button"
            onClick={() => onChangeMode('margem')}
            className={`h-11 rounded-lg px-4 text-sm font-semibold ${
              mode === 'margem' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            margem
          </button>
        </div>

        <div className="mt-3 h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="mesLabel" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip
                formatter={(value: number) => formatCurrency((value ?? 0) / 100)}
                labelFormatter={(label) => `Mês ${label}`}
              />

              {mode === 'receitaDespesa' ? (
                <>
                  <Line
                    type="monotone"
                    dataKey="receitaReal"
                    stroke="#1D9E75"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#1D9E75' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="despesaReal"
                    stroke="#D85A30"
                    strokeWidth={2}
                    dot={(props) => {
                      const fill = props.payload?.isCritical ? '#BA7517' : '#D85A30';
                      return <circle cx={props.cx} cy={props.cy} r={3} fill={fill} />;
                    }}
                  />
                  <Line type="monotone" dataKey="receitaProj" stroke="#1D9E75" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                  <Line type="monotone" dataKey="despesaProj" stroke="#D85A30" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                </>
              ) : (
                <>
                  <ReferenceLine y={0} stroke="#BA7517" strokeDasharray="4 4" />
                  <Line
                    type="monotone"
                    dataKey="margemReal"
                    stroke="#1D9E75"
                    strokeWidth={2}
                    dot={(props) => {
                      const value = Number(props.payload?.margemReal ?? 0);
                      const fill = value < 600 ? '#BA7517' : '#1D9E75';
                      return <circle cx={props.cx} cy={props.cy} r={3} fill={fill} />;
                    }}
                  />
                  <Line type="monotone" dataKey="margemProj" stroke="#1D9E75" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-[#1D9E75]" /> receita
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-[#D85A30]" /> despesa
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-[2px] w-4 border-t-2 border-dashed border-slate-400" /> projeção
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-[2px] w-4 border-t-2 border-dashed border-[#BA7517]" /> breakpoint
          </span>
        </div>

        <article className={`mt-3 rounded-xl border px-3 py-2 text-sm ${riskTone}`}>
          {riskRow ? (
            <p>
              atenção em <strong>{monthShort(riskRow.mes)}</strong>: despesas encostando no limite.
              Reforce corte de custos ou aumento de entradas.
            </p>
          ) : (
            <p>margem anual estável até agora. Mantenha o ritmo atual.</p>
          )}
        </article>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">mês a mês</h3>
        <div className="mt-2 space-y-2">
          {rows.map((row) => {
            const receita = row.receitaReal ?? row.receitaProj ?? 0;
            const despesa = row.despesaReal ?? row.despesaProj ?? 0;
            const margem = receita - despesa;
            return (
              <div key={row.mes} className="flex min-h-11 items-center gap-3">
                <span className="w-8 text-xs font-semibold uppercase text-slate-500">{row.mesLabel}</span>
                <div className="flex-1 space-y-1">
                  <div className="h-2 rounded-full bg-[#E1F5EE]">
                    <div className="h-2 rounded-full bg-[#1D9E75]" style={{ width: `${(receita / maxBar) * 100}%` }} />
                  </div>
                  <div className="h-2 rounded-full bg-[#FCEBEB]">
                    <div className="h-2 rounded-full bg-[#D85A30]" style={{ width: `${(despesa / maxBar) * 100}%` }} />
                  </div>
                </div>
                <span className={`h-2.5 w-2.5 rounded-full ${miniPointTone(receita, despesa)}`} />
                <span className={`w-20 text-right text-xs font-semibold ${margem >= 0 ? 'text-[#1D9E75]' : 'text-[#D85A30]'}`}>
                  {margem >= 0 ? '+' : '−'} {formatCurrency(Math.abs(margem) / 100)}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <AnnualTotalSection title="O que entrou" rows={data.totaisEntradas} tone="green" />
        <AnnualTotalSection title="O que saiu" rows={data.totaisSaidas} tone="red" />
        <AnnualTotalSection title="O que guardou" rows={data.totaisGuardado} tone="amber" />
        <div className={`mt-3 rounded-xl border px-3 py-2 text-sm font-semibold ${
          data.resultadoAcumulado >= 0 ? 'bg-[#E1F5EE] border-[#BFE9DA] text-[#1D9E75]' : 'bg-[#FCEBEB] border-[#F3D0D0] text-[#D85A30]'
        }`}>
          resultado acumulado · {formatCurrency(data.resultadoAcumulado / 100)}
        </div>
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'green' | 'red' | 'amber';
}) {
  const tones = {
    green: 'border-[#BFE9DA] bg-[#E1F5EE] text-[#1D9E75]',
    red: 'border-[#F3D0D0] bg-[#FCEBEB] text-[#D85A30]',
    amber: 'border-[#EFD9B6] bg-[#FAEEDA] text-[#BA7517]',
  } as const;
  return (
    <article className={`rounded-2xl border p-3 ${tones[tone]}`}>
      <p className="text-[11px] uppercase tracking-[0.12em] font-semibold">{label}</p>
      <p className="mt-2 text-base font-bold">{value}</p>
      <p className="mt-1 text-xs opacity-80">{sub}</p>
    </article>
  );
}

function AnnualTotalSection({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: Array<{ label: string; icon: string; total: number; mediaMensal: number }>;
  tone: 'green' | 'red' | 'amber';
}) {
  const toneClasses = {
    green: 'text-[#1D9E75]',
    red: 'text-[#D85A30]',
    amber: 'text-[#BA7517]',
  } as const;
  return (
    <div className="mt-2 border-b border-slate-100 pb-2 last:border-b-0">
      <p className="mb-1 text-sm font-semibold text-slate-900">{title}</p>
      <table className="w-full table-fixed text-xs">
        <tbody>
          {rows.map((row) => (
            <tr key={`${title}-${row.label}`} className="h-11 border-t border-slate-100">
              <td className="w-[52%] pr-2">
                <div className="flex items-center gap-2 text-slate-700">
                  <DreIcon name={row.icon} className={`h-4 w-4 ${toneClasses[tone]}`} />
                  <span className="truncate">{row.label}</span>
                </div>
              </td>
              <td className={`w-[24%] text-right font-semibold ${toneClasses[tone]}`}>
                {formatCurrency(row.total / 100)}
              </td>
              <td className="w-[24%] text-right text-slate-500">
                {formatCurrency(row.mediaMensal / 100)}/mês
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
