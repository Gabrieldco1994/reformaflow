'use client';

import type { PlanningAssumptions } from '../_types';

interface PlanningAssumptionsProps {
  assumptions: PlanningAssumptions;
  onChange: (patch: Partial<PlanningAssumptions>) => void;
}

function reaisToCents(value: number): number {
  return Math.max(0, Math.round(value * 100));
}

export default function PlanningAssumptions({
  assumptions,
  onChange,
}: PlanningAssumptionsProps) {
  return (
    <section className="rounded-2xl border border-darc-linen bg-white p-4 md:p-5 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-darc-velvet">Parâmetros do cenário</h2>
        <p className="text-xs text-darc-velvet/60">
          A matriz abaixo é mensal; estes parâmetros ajudam no preenchimento de novos meses.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Meses no cenário</span>
          <input
            type="number"
            value={assumptions.monthsAhead}
            readOnly
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-slate-50"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Entrada média (R$/mês)</span>
          <input
            type="number"
            value={Math.round(assumptions.monthlyIncomeCents / 100)}
            readOnly
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-slate-50"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Despesa média (R$/mês)</span>
          <input
            type="number"
            value={Math.round(assumptions.monthlyExpenseCents / 100)}
            readOnly
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-slate-50"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Cresc. entrada (% a.m.)</span>
          <input
            type="number"
            step={0.1}
            value={assumptions.incomeGrowthPct}
            onChange={(e) => onChange({ incomeGrowthPct: Number(e.target.value) })}
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-white"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Cresc. despesa (% a.m.)</span>
          <input
            type="number"
            step={0.1}
            value={assumptions.expenseGrowthPct}
            onChange={(e) => onChange({ expenseGrowthPct: Number(e.target.value) })}
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-white"
          />
        </label>
      </div>

      <label className="space-y-1.5 block max-w-xs">
        <span className="text-xs font-medium text-darc-velvet/70">Meta de sobra (R$/mês)</span>
        <input
          type="number"
          min={0}
          step={1}
          value={Math.round(assumptions.targetMonthlySurplusCents / 100)}
          onChange={(e) =>
            onChange({ targetMonthlySurplusCents: reaisToCents(Number(e.target.value)) })
          }
          className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-white"
        />
      </label>
    </section>
  );
}
