'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addMonthKey, monthLabelLong } from '../_lib';

function monthShort(month: string) {
  const [year, mm] = month.split('-');
  const names = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const idx = Number(mm) - 1;
  return `${names[idx] ?? mm}/${year}`;
}

export function ContaMonthPicker({
  month,
  onChange,
}: {
  month: string;
  onChange: (month: string) => void;
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto">
      <button
        type="button"
        onClick={() => onChange(addMonthKey(month, -1))}
        aria-label="Mês anterior"
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2 transition hover:bg-lifeone-sidebar"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className="flex h-10 min-w-0 flex-1 items-center rounded-xl border border-lifeone-hairline bg-lifeone-surface px-2.5 text-sm font-medium text-lifeone-ink-2 sm:flex-none">
        <span className="truncate sm:hidden">{monthShort(month)}</span>
        <label className="relative hidden w-[9rem] min-w-0 sm:block">
          <span className="sr-only">{monthLabelLong(month)}</span>
          <input
            type="month"
            value={month}
            onChange={(event) => onChange(event.target.value)}
            aria-label="Selecionar mês"
            className="h-10 w-full min-w-0 border-0 bg-transparent px-0 text-sm font-medium text-lifeone-ink-2 outline-none ring-0 transition focus:border-lifeone-blue"
          />
        </label>
      </div>
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
