'use client';

import { fmtMoneyExact } from '../../monthly/_cockpit/format';
import type { PlanningSummary as PlanningSummaryData } from '../_types';

interface PlanningSummaryProps {
  summary: PlanningSummaryData;
}

export default function PlanningSummary({ summary }: PlanningSummaryProps) {
  return (
    <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-2xl border border-darc-linen bg-white p-4">
        <p className="text-xs uppercase tracking-[0.14em] text-darc-velvet/55">Saldo atual</p>
        <p className="mt-1 text-xl font-semibold text-darc-velvet">{fmtMoneyExact(summary.startBalanceCents)}</p>
      </div>

      <div className="rounded-2xl border border-darc-linen bg-white p-4">
        <p className="text-xs uppercase tracking-[0.14em] text-darc-velvet/55">Saldo final projetado</p>
        <p
          className={`mt-1 text-xl font-semibold ${
            summary.endBalanceCents >= 0 ? 'text-emerald-600' : 'text-red-600'
          }`}
        >
          {fmtMoneyExact(summary.endBalanceCents)}
        </p>
      </div>

      <div className="rounded-2xl border border-darc-linen bg-white p-4">
        <p className="text-xs uppercase tracking-[0.14em] text-darc-velvet/55">Sobra média mensal</p>
        <p
          className={`mt-1 text-xl font-semibold ${
            summary.averageMonthlyBalanceCents >= 0 ? 'text-emerald-600' : 'text-red-600'
          }`}
        >
          {fmtMoneyExact(summary.averageMonthlyBalanceCents)}
        </p>
      </div>

      <div className="rounded-2xl border border-darc-linen bg-white p-4">
        <p className="text-xs uppercase tracking-[0.14em] text-darc-velvet/55">Ponto crítico</p>
        <p className="mt-1 text-xl font-semibold text-darc-velvet">
          {summary.firstNegativeMonthLabel ?? 'Sem saldo negativo'}
        </p>
        <p className="text-xs text-darc-velvet/60 mt-1">
          Pior saldo: {fmtMoneyExact(summary.worstBalanceCents)}
        </p>
      </div>
    </section>
  );
}
