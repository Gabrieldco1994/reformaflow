'use client';

import { useMemo, useState } from 'react';
import { fmtMoneyExact, fmtPct } from '../../monthly/_cockpit/format';
import type { PlanningExpenseTypeRow } from '../_types';

interface PlanningExpenseTypesProps {
  rows: PlanningExpenseTypeRow[];
  onChangeType: (typeCode: string, monthlyCents: number) => void;
}

const DEFAULT_VISIBLE_ROWS = 10;

function reaisToCents(value: number): number {
  return Math.max(0, Math.round(value * 100));
}

export default function PlanningExpenseTypes({
  rows,
  onChangeType,
}: PlanningExpenseTypesProps) {
  const [showAll, setShowAll] = useState(false);
  const orderedRows = useMemo(
    () => [...rows].sort((a, b) => b.monthlyCents - a.monthlyCents),
    [rows],
  );
  const visibleRows = showAll ? orderedRows : orderedRows.slice(0, DEFAULT_VISIBLE_ROWS);
  const totalCents = orderedRows.reduce((sum, row) => sum + row.monthlyCents, 0);

  return (
    <section className="rounded-2xl border border-darc-linen bg-white p-4 md:p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-darc-velvet">Gastos por tipo de despesa</h2>
          <p className="text-xs text-darc-velvet/60">
            Ajuste o valor mensal de cada tipo para simular cenários de consumo.
          </p>
        </div>
        <p className="text-sm font-semibold text-darc-velvet">
          Total: {fmtMoneyExact(totalCents)}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {visibleRows.map((row) => (
          <label
            key={row.typeCode}
            className="rounded-xl border border-darc-linen px-3 py-2 space-y-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-darc-velvet">{row.label}</span>
              <span className="text-[11px] text-darc-velvet/55">{fmtPct(row.sharePct, 1)}</span>
            </div>
            <input
              type="number"
              min={0}
              step={1}
              value={Math.round(row.monthlyCents / 100)}
              onChange={(e) => onChangeType(row.typeCode, reaisToCents(Number(e.target.value)))}
              className="w-full rounded-lg border border-darc-linen px-2.5 py-1.5 text-sm text-darc-velvet bg-white"
            />
          </label>
        ))}
      </div>

      {orderedRows.length > DEFAULT_VISIBLE_ROWS && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="text-xs font-medium text-darc-red hover:underline"
        >
          {showAll ? 'mostrar menos tipos' : `mostrar todos (${orderedRows.length})`}
        </button>
      )}
    </section>
  );
}
