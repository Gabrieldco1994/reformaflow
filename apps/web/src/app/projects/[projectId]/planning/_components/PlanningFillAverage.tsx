'use client';

import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { fmtMoneyExact } from '../../monthly/_cockpit/format';

const SHORT_MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map((n) => Number.parseInt(n, 10));
  return `${SHORT_MONTHS[(m || 1) - 1]}/${String(y || 0).slice(-2)}`;
}

/**
 * Preenche um ou mais meses do cenário com a média histórica (÷12) de cada
 * categoria de gasto. Multi-seleção de meses por chips + preview do total médio
 * por mês. Reusa a base de médias do cockpit (só gastos reais, sem neutros).
 */
export default function PlanningFillAverage({
  months,
  averageByCodeCents,
  onFill,
}: {
  months: string[];
  averageByCodeCents: Record<string, number>;
  onFill: (monthKeys: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const codes = useMemo(() => Object.keys(averageByCodeCents), [averageByCodeCents]);
  const totalMedioMes = useMemo(
    () => codes.reduce((sum, code) => sum + (averageByCodeCents[code] ?? 0), 0),
    [codes, averageByCodeCents],
  );

  const toggle = (monthKey: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(monthKey)) next.delete(monthKey);
      else next.add(monthKey);
      return next;
    });

  const allSelected = months.length > 0 && months.every((m) => selected.has(m));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(months));

  const apply = () => {
    if (selected.size === 0) return;
    onFill(Array.from(selected));
    setSelected(new Set());
  };

  if (codes.length === 0) {
    return (
      <div className="rounded-xl border border-darc-linen bg-slate-50 p-3 text-xs text-darc-velvet/60">
        Sem histórico de gastos suficiente para calcular a média por categoria.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-purple-200 bg-purple-50/50 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#7A3FC2]">
          <Sparkles className="h-3.5 w-3.5" />
          Preencher com média histórica
        </p>
        <span className="text-[11px] text-darc-velvet/60">
          {codes.length} categorias · {fmtMoneyExact(totalMedioMes)}/mês
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={toggleAll}
          className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
            allSelected
              ? 'border-transparent bg-[#7A3FC2] text-white'
              : 'border-darc-linen bg-white text-darc-velvet hover:border-[#7A3FC2]'
          }`}
        >
          {allSelected ? 'Nenhum' : 'Todos'}
        </button>
        {months.map((monthKey) => {
          const active = selected.has(monthKey);
          return (
            <button
              key={monthKey}
              type="button"
              onClick={() => toggle(monthKey)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                active
                  ? 'border-transparent bg-[#7A3FC2] text-white'
                  : 'border-darc-linen bg-white text-darc-velvet hover:border-[#7A3FC2]'
              }`}
            >
              {monthLabel(monthKey)}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-darc-velvet/60">
          {selected.size === 0
            ? 'Selecione os meses a preencher'
            : `${selected.size} mês(es) — sobrescreve as categorias com a média`}
        </span>
        <button
          type="button"
          onClick={apply}
          disabled={selected.size === 0}
          className="rounded-lg bg-[#7A3FC2] px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-95 disabled:opacity-40"
        >
          Aplicar médias
        </button>
      </div>
    </div>
  );
}
