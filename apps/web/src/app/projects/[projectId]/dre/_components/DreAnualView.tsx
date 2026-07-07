'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { moneyShort } from '@/lib/money';
import { InfoHint } from '@/components/InfoHint';
import type { DreAnual } from '../_types';
import { DreIcon } from './DreIcon';
import DespesasPorOrigemChart from './DespesasPorOrigemChart';

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

function saldoRows(data: DreAnual) {
  return data.saldoAcumuladoSerie.map((row) => ({
    ...row,
    mesLabel: monthShort(row.mes),
  }));
}

function SaldoTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number | null; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card p-2.5 text-xs shadow-lifeone-hover">
      <p className="mb-1 font-semibold text-lifeone-ink">{label}</p>
      {payload
        .filter((p) => p.value != null)
        .map((p) => (
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
    </div>
  );
}

export function DreAnualView({ data }: { data: DreAnual }) {
  const [saldoMode, setSaldoMode] = useState<'saldo' | 'origem'>('saldo');
  const rows = chartRows(data);
  const saldo = saldoRows(data);
  const maxBar = rows.reduce((max, row) => {
    const receita = row.receitaReal ?? row.receitaProj ?? 0;
    const despesa = row.despesaReal ?? row.despesaProj ?? 0;
    return Math.max(max, receita, despesa);
  }, 1);

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3">
        <SummaryCard
          label="entrou no ano"
          value={formatCurrency(data.totalEntrou / 100)}
          sub={data.ateOMes}
          tone="green"
          info="Tudo que entrou no ano até o mês corrente (receitas acumuladas)."
        />
        <SummaryCard
          label="saiu no ano"
          value={formatCurrency(data.totalSaiu / 100)}
          sub={`média ${formatCurrency(data.mediaMensal / 100)}/mês`}
          tone="red"
          info="Tudo que saiu no ano (despesas acumuladas), com a média mensal."
        />
        <SummaryCard
          label="resultado acumulado"
          value={formatCurrency(data.resultadoAcumulado / 100)}
          sub="entradas − saídas − guardado"
          tone={data.resultadoAcumulado >= 0 ? 'green' : 'red'}
          info="Resultado do ano até agora: entradas − saídas − o que foi guardado. Positivo = sobrou no acumulado."
        />
        <SummaryCard
          label="mês mais crítico"
          value={monthShort(data.mesCritico.mes)}
          sub={`margem ${formatCurrency(data.mesCritico.margem / 100)}`}
          tone="amber"
          info="O mês com a menor margem (resultado mais apertado) do ano."
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {saldoMode === 'saldo'
                ? 'Saldo acumulado do fluxo de caixa'
                : 'Despesas do mês por origem'}
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {saldoMode === 'saldo' ? (
                <>
                  <span className="font-semibold">Projetado</span> inclui planejados/previstos;{' '}
                  <span className="font-semibold">Realizado</span> considera apenas pagos e em caixa. O ponto de hoje reconcilia com o caixa da Visão Conta.
                </>
              ) : (
                <>
                  Quanto saiu por mês, quebrado por origem (Conta Corrente e cada cartão); inclui planejados. Meses futuros aparecem mais claros (projeção).
                </>
              )}
            </p>
          </div>
          <div className="inline-flex shrink-0 rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-[11px] font-semibold">
            <button
              type="button"
              onClick={() => setSaldoMode('saldo')}
              className={`rounded-md px-2.5 py-1 transition ${
                saldoMode === 'saldo' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Saldo
            </button>
            <button
              type="button"
              onClick={() => setSaldoMode('origem')}
              className={`rounded-md px-2.5 py-1 transition ${
                saldoMode === 'origem' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Por origem
            </button>
          </div>
        </div>

        {saldoMode === 'origem' ? (
          <div className="mt-3">
            <DespesasPorOrigemChart data={data.despesasPorOrigem} />
          </div>
        ) : (
        <>
        <div className="mt-3 h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={saldo} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ECE8E1" vertical={false} />
              <XAxis dataKey="mesLabel" tick={{ fontSize: 11, fill: '#8A857C' }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 11, fill: '#8A857C' }}
                width={56}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => moneyShort(v).replace('R$ ', '')}
              />
              <Tooltip content={<SaldoTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
              <ReferenceLine y={0} stroke="#D8D2C7" strokeWidth={1} />
              <Line
                type="monotone"
                dataKey="recebimentos"
                name="Recebimentos"
                isAnimationActive={false}
                stroke="#1D9E75"
                strokeWidth={1.5}
                strokeOpacity={0.5}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="despesas"
                name="Despesas"
                isAnimationActive={false}
                stroke="#D85A30"
                strokeWidth={1.5}
                strokeOpacity={0.5}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="saldoProjetado"
                name="Saldo projetado"
                isAnimationActive={false}
                stroke="#8A857C"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="saldoRealizado"
                name="Saldo realizado"
                isAnimationActive={false}
                stroke="#0F6B4D"
                strokeWidth={3}
                dot={{ r: 3, fill: '#0F6B4D' }}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-lifeone-hairline-3 pt-3">
          <p className="text-[11px] text-slate-500">
            saldo hoje · <span className="font-semibold text-[#0F6B4D]">{formatCurrency(data.caixaHoje / 100)}</span>
          </p>
          <p className="text-[11px] text-slate-500">
            projeção fim do ano ·{' '}
            <span className="font-semibold text-slate-700">
              {formatCurrency((saldo[saldo.length - 1]?.saldoProjetado ?? data.caixaHoje) / 100)}
            </span>
          </p>
        </div>
        </>
        )}
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
  info,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'green' | 'red' | 'amber';
  info?: string;
}) {
  const tones = {
    green: 'border-[#BFE9DA] bg-[#E1F5EE] text-[#1D9E75]',
    red: 'border-[#F3D0D0] bg-[#FCEBEB] text-[#D85A30]',
    amber: 'border-[#EFD9B6] bg-[#FAEEDA] text-[#BA7517]',
  } as const;
  return (
    <article className={`rounded-2xl border p-3 ${tones[tone]}`}>
      <p className="flex items-center gap-1 text-[11px] uppercase tracking-[0.12em] font-semibold">
        {label}
        {info && <InfoHint text={info} />}
      </p>
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
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-2 border-b border-slate-100 pb-2 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex min-h-11 w-full items-center justify-between gap-2"
        aria-expanded={expanded}
      >
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <ChevronDown
          className={`h-4 w-4 text-slate-500 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && (
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
      )}
    </div>
  );
}
