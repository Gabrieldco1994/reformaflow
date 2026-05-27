'use client';
import React, { useMemo } from 'react';
import { formatCurrency } from '@/lib/utils';
import { currentMonthKey, mesKeyFromDate, mesLabelFromKey } from '../_lib/grouping';
import type { Receipt } from '@/types';

interface Props {
  receipts: Receipt[];
}

function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  const date = new Date(y, m, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function ReceiptsKpiCardsImpl({ receipts }: Props) {
  const stats = useMemo(() => {
    const curKey = currentMonthKey();
    const nextKey = nextMonthKey(curKey);

    let monthEmCaixa = 0;
    let monthPrevisto = 0;
    let nextMonthTotal = 0;
    let totalConsolidadoEmCaixa = 0;
    let totalConsolidadoGeral = 0;

    for (const r of receipts) {
      totalConsolidadoGeral += r.valor;
      if (r.status === 'EM_CAIXA') {
        totalConsolidadoEmCaixa += r.valor;
      }
      
      const k = mesKeyFromDate(r.data);
      if (k === curKey) {
        if (r.status === 'EM_CAIXA') monthEmCaixa += r.valor;
        else monthPrevisto += r.valor;
      } else if (k === nextKey) {
        nextMonthTotal += r.valor;
      }
    }

    const monthTotal = monthEmCaixa + monthPrevisto;
    const progress = monthTotal > 0 ? (monthEmCaixa / monthTotal) * 100 : 0;

    return {
      monthEmCaixa,
      monthPrevisto,
      monthTotal,
      progress,
      nextMonthTotal,
      totalConsolidadoEmCaixa,
      totalConsolidadoGeral,
      curLabel: mesLabelFromKey(curKey),
      nextLabel: mesLabelFromKey(nextKey),
    };
  }, [receipts]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Card principal: mês atual com progresso */}
        <div className="md:col-span-2 rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-darc-velvet/60">
                {stats.curLabel}
              </p>
              <p className="font-editorial italic text-xl text-darc-velvet leading-tight">
                {stats.monthTotal > 0 ? 'Recebimentos do mês' : 'Sem recebimentos este mês'}
              </p>
            </div>
            {stats.monthTotal > 0 && (
              <p className="text-sm tabular-nums text-darc-velvet/70">
                <span className="font-bold text-darc-velvet">{formatCurrency(stats.monthEmCaixa / 100)}</span>
                <span className="mx-1.5 text-darc-velvet/40">de</span>
                <span>{formatCurrency(stats.monthTotal / 100)}</span>
              </p>
            )}
          </div>

          {stats.monthTotal > 0 && (
            <>
              <div className="mt-3 h-2 w-full rounded-full bg-darc-linen overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-darc-mist to-darc-velvet/70 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, stats.progress)}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 text-darc-velvet/70">
                  <span className="w-2 h-2 rounded-full bg-darc-velvet/70" />
                  Recebido {Math.round(stats.progress)}%
                </span>
                {stats.monthPrevisto > 0 && (
                  <span className="flex items-center gap-1.5 text-darc-raspberry">
                    <span className="w-2 h-2 rounded-full bg-darc-sunfire" />
                    A receber {formatCurrency(stats.monthPrevisto / 100)}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Card secundário: próximo mês */}
        <div className="rounded-2xl bg-darc-cream/40 shadow-darc-soft border border-darc-linen p-4 flex flex-col justify-center">
          <p className="text-[10px] uppercase tracking-[0.2em] text-darc-velvet/60">
            {stats.nextLabel}
          </p>
          <p className="text-[11px] text-darc-velvet/70 mt-0.5">Próximo mês</p>
          <p className="font-bold text-darc-velvet tabular-nums mt-2 text-lg">
            {stats.nextMonthTotal > 0 ? formatCurrency(stats.nextMonthTotal / 100) : '—'}
          </p>
        </div>
      </div>

      {/* Card terciário: total consolidado (nova linha) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Em Caixa Total */}
        <div className="rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 shadow-darc-soft border border-emerald-700 p-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/80">
              Total em Caixa
            </p>
            <p className="text-[11px] text-white/90 mt-0.5">Recebimentos confirmados</p>
          </div>
          <p className="font-bold text-white tabular-nums text-2xl">
            {stats.totalConsolidadoEmCaixa > 0 ? formatCurrency(stats.totalConsolidadoEmCaixa / 100) : '—'}
          </p>
        </div>

        {/* Total Geral (Caixa + Previsto) */}
        <div className="rounded-2xl bg-gradient-to-br from-darc-velvet to-darc-velvet/80 shadow-darc-soft border border-darc-velvet p-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/80">
              Total Geral
            </p>
            <p className="text-[11px] text-white/90 mt-0.5">Caixa + Previsto</p>
          </div>
          <p className="font-bold text-white tabular-nums text-2xl">
            {stats.totalConsolidadoGeral > 0 ? formatCurrency(stats.totalConsolidadoGeral / 100) : '—'}
          </p>
        </div>
      </div>
    </div>
  );
}

export const ReceiptsKpiCards = React.memo(ReceiptsKpiCardsImpl);
