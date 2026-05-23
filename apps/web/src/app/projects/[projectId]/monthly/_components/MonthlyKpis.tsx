'use client';

import { TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import type { MonthComparison, MonthlyOverviewRow } from '../_types';

interface Props {
  current: MonthlyOverviewRow | null;
  comparison: MonthComparison;
}

function Delta({ value, pct }: { value: number; pct: number | null }) {
  if (!pct && value === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-darc-velvet/60">
        <Minus className="w-3 h-3" /> sem variação
      </span>
    );
  }
  const positive = value > 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  const color = positive ? 'text-darc-red' : 'text-emerald-700';
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${color}`}>
      <Icon className="w-3 h-3" />
      {positive ? '+' : ''}{formatCurrency(value / 100)}
      {pct !== null && (
        <span className="opacity-80">({positive ? '+' : ''}{pct.toFixed(0)}%)</span>
      )}
    </span>
  );
}

export default function MonthlyKpis({ current, comparison }: Props) {
  const despesas = current?.totalDespesas ?? 0;
  const recebimentos = current?.totalRecebimentos ?? 0;
  const saldo = current?.saldoMes ?? 0;
  const realizadoDesp = current?.despesasRealizadas ?? 0;
  const realizadoSaldo = current?.saldoMesRealizado ?? 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4">
        <p className="text-[10px] uppercase tracking-wider text-darc-velvet/70">Gasto no mês</p>
        <p className="font-bold tabular-nums text-darc-red text-xl mt-1">
          {formatCurrency(despesas / 100)}
        </p>
        <div className="mt-2">
          <Delta value={comparison.deltaDespesas} pct={comparison.deltaDespesasPct} />
        </div>
        <p className="text-[10px] text-darc-velvet/50 mt-1 tabular-nums">
          Realizado: {formatCurrency(realizadoDesp / 100)}
        </p>
      </div>

      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4">
        <p className="text-[10px] uppercase tracking-wider text-darc-velvet/70">Recebido no mês</p>
        <p className="font-bold tabular-nums text-emerald-700 text-xl mt-1">
          {formatCurrency(recebimentos / 100)}
        </p>
        <div className="mt-2">
          <Delta value={comparison.deltaRecebimentos} pct={comparison.deltaRecebimentosPct} />
        </div>
        <p className="text-[10px] text-darc-velvet/50 mt-1 tabular-nums">
          Realizado: {formatCurrency((current?.recebimentosRealizados ?? 0) / 100)}
        </p>
      </div>

      <div
        className={`rounded-2xl shadow-darc-soft border p-4 ${
          saldo >= 0
            ? 'bg-darc-mist/30 border-darc-mist/50'
            : 'bg-darc-red-pastel/15 border-darc-red-pastel/40'
        }`}
      >
        <p className="text-[10px] uppercase tracking-wider text-darc-velvet/70">Saldo projetado do mês</p>
        <p className={`font-bold tabular-nums text-xl mt-1 ${saldo >= 0 ? 'text-darc-velvet' : 'text-darc-red'}`}>
          {formatCurrency(saldo / 100)}
        </p>
        <p className="text-[10px] text-darc-velvet/50 mt-2 tabular-nums">
          vs mês anterior: <Delta value={comparison.deltaSaldo} pct={null} />
        </p>
      </div>

      <div
        className={`rounded-2xl shadow-darc-soft border p-4 ${
          realizadoSaldo >= 0
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-darc-red-pastel/15 border-darc-red-pastel/40'
        }`}
      >
        <p className="text-[10px] uppercase tracking-wider text-emerald-700/80">Saldo realizado do mês</p>
        <p className={`font-bold tabular-nums text-xl mt-1 ${realizadoSaldo >= 0 ? 'text-emerald-700' : 'text-darc-red'}`}>
          {formatCurrency(realizadoSaldo / 100)}
        </p>
        <p className="text-[10px] text-darc-velvet/50 mt-2">
          Apenas PAGO / EM_CAIXA
        </p>
      </div>
    </div>
  );
}
