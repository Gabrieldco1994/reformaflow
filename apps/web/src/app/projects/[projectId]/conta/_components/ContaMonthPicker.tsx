'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addMonthKey, monthLabelLong } from '../_lib';

export function ContaMonthPicker({
  month,
  onChange,
}: {
  month: string;
  onChange: (month: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(addMonthKey(month, -1))}
        aria-label="Mês anterior"
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700 transition hover:bg-slate-100"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <label className="relative">
        <span className="sr-only">{monthLabelLong(month)}</span>
        <input
          type="month"
          value={month}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Selecionar mês"
          className="h-10 rounded-xl border border-slate-200 bg-slate-50 px-2.5 text-sm font-medium text-slate-700 outline-none ring-0 transition focus:border-slate-300"
        />
      </label>
      <button
        type="button"
        onClick={() => onChange(addMonthKey(month, 1))}
        aria-label="Próximo mês"
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700 transition hover:bg-slate-100"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
}
