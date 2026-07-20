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
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(addMonthKey(month, -1))}
        aria-label="Mês anterior"
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2 transition hover:bg-lifeone-sidebar"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <label className="relative block w-[8.5rem] min-w-0 sm:w-[9rem]">
        <span className="sr-only">{monthLabelLong(month)}</span>
        <input
          type="month"
          value={month}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Selecionar mês"
          className="h-10 w-full min-w-0 rounded-xl border border-lifeone-hairline bg-lifeone-surface px-2 text-[13px] font-medium text-lifeone-ink-2 outline-none ring-0 transition focus:border-lifeone-blue sm:px-2.5 sm:text-sm"
        />
      </label>
      <button
        type="button"
        onClick={() => onChange(addMonthKey(month, 1))}
        aria-label="Próximo mês"
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2 transition hover:bg-lifeone-sidebar"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
}
