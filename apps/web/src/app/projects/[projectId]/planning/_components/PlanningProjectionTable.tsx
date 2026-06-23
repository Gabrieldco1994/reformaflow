'use client';

import { fmtMoneyExact } from '../../monthly/_cockpit/format';
import type { PlanningProjectionRow } from '../_types';

interface PlanningProjectionTableProps {
  rows: PlanningProjectionRow[];
  targetMonthlySurplusCents: number;
}

export default function PlanningProjectionTable({
  rows,
  targetMonthlySurplusCents,
}: PlanningProjectionTableProps) {
  return (
    <section className="rounded-2xl border border-darc-linen bg-white p-4 md:p-5">
      <h2 className="text-base font-semibold text-darc-velvet">Grade de planejamento mensal</h2>
      <p className="text-xs text-darc-velvet/60 mb-3">
        Meta mensal: <strong>{fmtMoneyExact(targetMonthlySurplusCents)}</strong>
      </p>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-darc-velvet/70 border-b border-darc-linen">
            <tr>
              <th className="px-3 py-2 font-medium">Mês</th>
              <th className="px-3 py-2 font-medium">Recebimentos</th>
              <th className="px-3 py-2 font-medium">Despesas</th>
              <th className="px-3 py-2 font-medium">Sobra</th>
              <th className="px-3 py-2 font-medium">Saldo acumulado</th>
              <th className="px-3 py-2 font-medium">Base</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const aboveTarget = row.monthlyBalanceCents >= targetMonthlySurplusCents;
              return (
                <tr key={row.monthKey} className="border-b border-darc-linen/70">
                  <td className="px-3 py-2 text-darc-velvet font-medium">{row.monthLabel}</td>
                  <td className="px-3 py-2 text-emerald-700">{fmtMoneyExact(row.plannedIncomeCents)}</td>
                  <td className="px-3 py-2 text-red-700">{fmtMoneyExact(row.plannedExpenseCents)}</td>
                  <td
                    className={`px-3 py-2 font-semibold ${
                      row.monthlyBalanceCents >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {fmtMoneyExact(row.monthlyBalanceCents)}
                    {!aboveTarget && (
                      <span className="ml-1 text-[11px] text-amber-700">
                        ({fmtMoneyExact(row.targetGapCents)})
                      </span>
                    )}
                  </td>
                  <td
                    className={`px-3 py-2 font-semibold ${
                      row.closingBalanceCents >= 0 ? 'text-darc-velvet' : 'text-red-700'
                    }`}
                  >
                    {fmtMoneyExact(row.closingBalanceCents)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        row.source === 'known'
                          ? 'bg-emerald-50 text-emerald-700'
                          : row.source === 'mixed'
                            ? 'bg-sky-50 text-sky-700'
                            : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {row.source === 'known'
                        ? 'Lançamentos reais'
                        : row.source === 'mixed'
                          ? 'Misto'
                          : 'Modelagem'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
