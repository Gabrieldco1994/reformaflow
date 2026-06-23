'use client';

import type { PlanningAssumptions } from '../_types';

interface PlanningAssumptionsProps {
  assumptions: PlanningAssumptions;
  onChange: (patch: Partial<PlanningAssumptions>) => void;
}

const HORIZON_OPTIONS = [6, 12, 18, 24, 36];

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
        <h2 className="text-base font-semibold text-darc-velvet">Premissas do planning</h2>
        <p className="text-xs text-darc-velvet/60">
          Ajuste os parâmetros para simular cenários de saldo futuro e budget mensal.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Horizonte (meses)</span>
          <select
            value={assumptions.monthsAhead}
            onChange={(e) =>
              onChange({ monthsAhead: Number.parseInt(e.target.value, 10) || assumptions.monthsAhead })
            }
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-white"
          >
            {HORIZON_OPTIONS.map((months) => (
              <option key={months} value={months}>
                {months} meses
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Recebimentos médios (R$/mês)</span>
          <input
            type="number"
            min={0}
            step={1}
            value={Math.round(assumptions.monthlyIncomeCents / 100)}
            onChange={(e) => onChange({ monthlyIncomeCents: reaisToCents(Number(e.target.value)) })}
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-white"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">
            Despesas médias (R$/mês)
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={Math.round(assumptions.monthlyExpenseCents / 100)}
            readOnly
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-slate-50"
          />
          <p className="text-[11px] text-darc-velvet/55">calculado pela soma dos tipos abaixo</p>
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Crescimento recebimentos (% a.m.)</span>
          <input
            type="number"
            step={0.1}
            value={assumptions.incomeGrowthPct}
            onChange={(e) => onChange({ incomeGrowthPct: Number(e.target.value) })}
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-white"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium text-darc-velvet/70">Crescimento despesas (% a.m.)</span>
          <input
            type="number"
            step={0.1}
            value={assumptions.expenseGrowthPct}
            onChange={(e) => onChange({ expenseGrowthPct: Number(e.target.value) })}
            className="w-full rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-white"
          />
        </label>

        <label className="space-y-1.5">
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
      </div>
    </section>
  );
}
