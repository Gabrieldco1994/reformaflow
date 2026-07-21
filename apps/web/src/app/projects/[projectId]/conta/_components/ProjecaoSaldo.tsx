'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { InfoHint } from '@/components/InfoHint';
import { monthLabelShort, monthLabelLong } from '../_lib';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';

function compactBRL(cents: number) {
  const reais = cents / 100;
  const abs = Math.abs(reais);
  if (abs >= 1000) return `${(reais / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
  return reais.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

type BarPoint = { mes: string; label: string; saldo: number; negativo: boolean };

function SaldoTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: BarPoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="min-w-[160px] rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2.5 text-xs shadow-lifeone-card">
      <p className="font-semibold text-lifeone-ink">{monthLabelLong(p.mes)}</p>
      <p className={p.negativo ? 'text-[#D92D20]' : 'text-[#1E924A]'}>
        {formatCurrency(p.saldo / 100)}
      </p>
    </div>
  );
}

export function ProjecaoSaldo({
  serie,
  currentMonth,
  simulatedRitmo,
  baseRitmo,
}: {
  serie: DreSaldoAcumuladoRow[];
  currentMonth: string;
  simulatedRitmo?: number;
  baseRitmo?: number;
}) {
  const forward = serie.filter((row) => row.mes >= currentMonth).slice(0, 6);
  if (forward.length < 2) return null;

  const isSimulating = simulatedRitmo !== undefined && simulatedRitmo !== baseRitmo;

  // Recalcular série quando ritmo muda: saldo(n) = saldo(n-1) + fixoLiquido(n) − (ritmo × dias)
  let chartData: BarPoint[];
  if (isSimulating && simulatedRitmo !== undefined) {
    // Simulação: recalcular a partir do primeiro mês
    chartData = [];
    let accSaldo = forward[0]?.saldoProjetado ?? 0;
    
    for (let i = 0; i < forward.length; i++) {
      const row = forward[i];
      const label = monthLabelShort(row.mes);
      
      // Se for o primeiro mês (atual), usar saldo atual; caso contrário, recalcular
      if (i === 0) {
        accSaldo = row.saldoProjetado;
      } else {
        // saldo(n) = saldo(n-1) + fixoLiquido(n) − (ritmo × dias do mês)
        const daysInMonth = new Date(parseInt(row.mes.split('-')[0]), parseInt(row.mes.split('-')[1]), 0).getDate();
        const variavelMes = simulatedRitmo * daysInMonth;
        const fixo = forward[i]?.fixoLiquido ?? (row.recebimentos - row.despesas);
        accSaldo = accSaldo + fixo - variavelMes;
      }
      
      chartData.push({
        mes: row.mes,
        label,
        saldo: accSaldo,
        negativo: accSaldo < 0,
      });
    }
  } else {
    // Default: usar série do backend
    chartData = forward.map((row) => ({
      mes: row.mes,
      label: monthLabelShort(row.mes),
      saldo: row.saldoProjetado,
      negativo: row.saldoProjetado < 0,
    }));
  }

  const crossover = chartData.find((row) => row.negativo) ?? null;
  const lowest = chartData.reduce((min, row) => (row.saldo < min.saldo ? row : min), chartData[0]);
  const last = chartData[chartData.length - 1];

  // Dinâmica visual: escala se o simulador mudou
  const allValues = chartData.map(d => d.saldo);
  const min = Math.min(...allValues, 0);
  const max = Math.max(...allValues, 0);
  const margin = Math.abs(max - min) * 0.1 || 50000;

  return (
    <section className="rounded-3xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card xl:p-6">
      <div className="flex items-center justify-between gap-2 mb-3">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
          Vai dar até {monthLabelShort(last.mes)}?
          <InfoHint
            text="Projeção do saldo real da conta, mês a mês: parte do que você tem hoje e vai descontando as contas a pagar e somando as receitas previstas, CARREGANDO o saldo de um mês para o outro. Inclui parcelas de outros projetos pagas por esta conta; ignora transferências internas e faturas já contadas nas compras."
            className="text-lifeone-ink-3"
          />
        </p>
        {isSimulating && (
          <span className="text-[11px] text-lifeone-ink-2 italic">simulação</span>
        )}
      </div>

      {crossover ? (
        <div className="mt-2 flex items-start gap-2.5 rounded-2xl border border-[#F2C6C1] bg-[#FCEBE9] px-3.5 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#D92D20]" />
          <div className="leading-snug">
            <p className="text-sm font-bold text-[#D92D20]">
              {isSimulating ? 'Com esse ritmo' : 'No ritmo atual'}, o saldo fica negativo em {monthLabelLong(crossover.mes)}.
            </p>
            <p className="mt-0.5 text-xs text-[#B5803A]">
              Pior ponto: <span className="font-semibold">{formatCurrency(lowest.saldo / 100)}</span> em{' '}
              {monthLabelLong(lowest.mes)}.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-start gap-2.5 rounded-2xl border border-[#BFE6CC] bg-[#E3F6EA] px-3.5 py-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#1E924A]" />
          <div className="leading-snug">
            <p className="text-sm font-bold text-[#1E924A]">
              {isSimulating ? 'Com esse ritmo' : 'No ritmo atual'}, o saldo se mantém positivo até {monthLabelLong(last.mes)}.
            </p>
            <p className="mt-0.5 text-xs text-lifeone-ink-3">
              Menor ponto: <span className="font-semibold">{formatCurrency(lowest.saldo / 100)}</span> em{' '}
              {monthLabelLong(lowest.mes)}.
            </p>
          </div>
        </div>
      )}

      {/* Gráfico de barras */}
      <div className="mt-4 h-40 md:h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 4, bottom: 32, left: 2 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EDE8DF" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: '#8A857C' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#8A857C' }}
              axisLine={false}
              tickLine={false}
              width={40}
              tickFormatter={(v: number) => compactBRL(v)}
              domain={[min - margin, max + margin]}
            />
            <ReferenceLine y={0} stroke="#D92D20" strokeWidth={1} strokeDasharray="4 3" />
            <Tooltip content={<SaldoTooltip />} />
            <Bar dataKey="saldo" radius={[4, 4, 0, 0]} maxBarSize={32}>
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.negativo ? '#D92D20' : '#1E924A'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-center text-[11px] text-lifeone-ink-3">valores em milhares</p>
    </section>
  );
}
