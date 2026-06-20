'use client';
import { Calendar } from 'lucide-react';
import { periodLabel, currentPeriod } from '../_lib/personal-hierarchy';
import type { PeriodFilter } from '../_lib/personal-hierarchy';

/**
 * Seletor de período do PESSOAL — versão enxuta: dropdown de mês + "Ano todo".
 * A navegação ◂ ▸ vive no PersonalMonthHeader (evita dois navegadores).
 */
export function PersonalPeriodPicker({
  period,
  periodYear,
  allPeriods,
  onChange,
}: {
  period: PeriodFilter;
  periodYear: number;
  allPeriods: string[];
  onChange: (p: PeriodFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Calendar className="h-4 w-4 text-orange-600" />
      <select
        value={period}
        onChange={(e) => onChange(e.target.value as PeriodFilter)}
        className="rounded-lg border border-darc-linen bg-white px-2.5 py-1.5 text-xs font-medium text-darc-velvet"
      >
        <option value="ALL">Ano todo ({periodYear})</option>
        {allPeriods.map((p) => (
          <option key={p} value={p}>{periodLabel(p)}</option>
        ))}
        {!allPeriods.includes(currentPeriod()) && (
          <option value={currentPeriod()}>{periodLabel(currentPeriod())} (sem despesas)</option>
        )}
      </select>
      <button
        type="button"
        onClick={() => onChange('ALL')}
        className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
          period === 'ALL'
            ? 'bg-orange-500 text-white'
            : 'border border-darc-linen bg-white text-orange-700 hover:bg-orange-50'
        }`}
      >
        Ano todo
      </button>
    </div>
  );
}
