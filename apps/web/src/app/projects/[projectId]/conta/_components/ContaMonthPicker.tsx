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
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm xl:flex xl:flex-col xl:justify-between xl:p-4">
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Mês da conta
        </p>
        <p className="hidden text-sm text-slate-600 xl:block">
          Troque o mês sem sair da mesma leitura de caixa.
        </p>
      </div>
      <div className="flex items-center gap-2 xl:mt-4">
        <button
          type="button"
          onClick={() => onChange(addMonthKey(month, -1))}
          aria-label="Mês anterior"
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700 transition hover:bg-slate-100"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <label className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-slate-900 xl:text-base">
            {monthLabelLong(month)}
          </span>
          <input
            type="month"
            value={month}
            onChange={(event) => onChange(event.target.value)}
            className="mt-1 h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none ring-0 transition focus:border-slate-300 xl:h-12"
          />
        </label>
        <button
          type="button"
          onClick={() => onChange(addMonthKey(month, 1))}
          aria-label="Próximo mês"
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700 transition hover:bg-slate-100"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
