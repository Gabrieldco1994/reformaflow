'use client';

import { useMemo } from 'react';
import { fmtMoneyExact } from '../../monthly/_cockpit/format';
import type { PlanningMatrixExpenseRow } from '../_types';
import PlanningFillAverage from './PlanningFillAverage';

interface PlanningMatrixProps {
  months: string[];
  incomeByMonthCents: Record<string, number>;
  expenseRows: PlanningMatrixExpenseRow[];
  averageByCodeCents: Record<string, number>;
  onAddMonth: () => void;
  onIncomeChange: (monthKey: string, cents: number) => void;
  onExpenseChange: (monthKey: string, typeCode: string, cents: number) => void;
  onFillWithAverage: (monthKeys: string[]) => void;
  onClearAll: () => void;
}

const SHORT_MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function reaisToCents(value: number): number {
  return Math.max(0, Math.round(value * 100));
}

function monthLabel(monthKey: string): string {
  const [yearRaw, monthRaw] = monthKey.split('-').map((n) => Number.parseInt(n, 10));
  return `${SHORT_MONTHS[(monthRaw || 1) - 1]}/${String(yearRaw || 0).slice(-2)}`;
}

export default function PlanningMatrix({
  months,
  incomeByMonthCents,
  expenseRows,
  averageByCodeCents,
  onAddMonth,
  onIncomeChange,
  onExpenseChange,
  onFillWithAverage,
  onClearAll,
}: PlanningMatrixProps) {
  const expenseTotalByMonth = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const monthKey of months) {
      totals[monthKey] = expenseRows.reduce(
        (sum, row) => sum + (row.valuesByMonthCents[monthKey] ?? 0),
        0,
      );
    }
    return totals;
  }, [expenseRows, months]);

  const balanceByMonth = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const monthKey of months) {
      const income = incomeByMonthCents[monthKey] ?? 0;
      const expense = expenseTotalByMonth[monthKey] ?? 0;
      totals[monthKey] = income - expense;
    }
    return totals;
  }, [expenseTotalByMonth, incomeByMonthCents, months]);

  return (
    <section className="rounded-2xl border border-darc-linen bg-white p-4 md:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-darc-velvet">Matriz mensal (modo planilha)</h2>
          <p className="text-xs text-darc-velvet/60">
            Edite mês a mês as entradas e cada tipo de despesa.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  'Limpar tudo? Isso zera as entradas e todas as despesas de todos os meses deste planning.',
                )
              ) {
                onClearAll();
              }
            }}
            className="rounded-lg border border-darc-linen px-3 py-2 text-xs font-semibold text-darc-velvet/80 hover:bg-slate-50"
          >
            Limpar tudo
          </button>
          <button
            type="button"
            onClick={onAddMonth}
            className="rounded-lg bg-darc-red px-3 py-2 text-xs font-semibold text-white hover:bg-darc-red/90"
          >
            + Adicionar mês
          </button>
        </div>
      </div>

      <PlanningFillAverage
        months={months}
        averageByCodeCents={averageByCodeCents}
        onFill={onFillWithAverage}
      />

      <div className="overflow-x-auto rounded-xl border border-darc-linen">
        <table className="min-w-[980px] w-full text-sm">
          <thead className="bg-slate-50 border-b border-darc-linen">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-darc-velvet min-w-[220px]">
                Tipo / mês
              </th>
              {months.map((monthKey) => (
                <th key={monthKey} className="px-2 py-2 text-center font-semibold text-darc-velvet min-w-[120px]">
                  {monthLabel(monthKey)}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-semibold text-darc-velvet min-w-[150px]">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-darc-linen/70 bg-emerald-50/40">
              <td className="px-3 py-2 font-semibold text-emerald-800">Entradas</td>
              {months.map((monthKey) => (
                <td key={`income-${monthKey}`} className="px-2 py-2">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={Math.round((incomeByMonthCents[monthKey] ?? 0) / 100)}
                    onChange={(e) => onIncomeChange(monthKey, reaisToCents(Number(e.target.value)))}
                    className="w-full rounded-lg border border-emerald-200 px-2 py-1.5 text-sm text-emerald-900 bg-white text-right"
                  />
                </td>
              ))}
              <td className="px-3 py-2 text-right font-semibold text-emerald-800">
                {fmtMoneyExact(
                  months.reduce((sum, monthKey) => sum + (incomeByMonthCents[monthKey] ?? 0), 0),
                )}
              </td>
            </tr>

            {expenseRows.map((row) => (
              <tr key={row.typeCode} className="border-b border-darc-linen/70">
                <td className="px-3 py-2 text-darc-velvet font-medium">{row.label}</td>
                {months.map((monthKey) => (
                  <td key={`${row.typeCode}-${monthKey}`} className="px-2 py-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={Math.round((row.valuesByMonthCents[monthKey] ?? 0) / 100)}
                      onChange={(e) =>
                        onExpenseChange(monthKey, row.typeCode, reaisToCents(Number(e.target.value)))
                      }
                      className="w-full rounded-lg border border-darc-linen px-2 py-1.5 text-sm text-darc-velvet bg-white text-right"
                    />
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold text-darc-velvet">
                  {fmtMoneyExact(row.totalCents)}
                </td>
              </tr>
            ))}

            <tr className="border-b border-darc-linen/70 bg-red-50/40">
              <td className="px-3 py-2 font-semibold text-red-800">Total despesas</td>
              {months.map((monthKey) => (
                <td key={`expense-total-${monthKey}`} className="px-2 py-2 text-right font-semibold text-red-700">
                  {fmtMoneyExact(expenseTotalByMonth[monthKey] ?? 0)}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-semibold text-red-800">
                {fmtMoneyExact(
                  months.reduce((sum, monthKey) => sum + (expenseTotalByMonth[monthKey] ?? 0), 0),
                )}
              </td>
            </tr>

            <tr className="bg-slate-100/60">
              <td className="px-3 py-2 font-semibold text-darc-velvet">Saldo do mês</td>
              {months.map((monthKey) => (
                <td
                  key={`balance-${monthKey}`}
                  className={`px-2 py-2 text-right font-semibold ${
                    (balanceByMonth[monthKey] ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {fmtMoneyExact(balanceByMonth[monthKey] ?? 0)}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-semibold text-darc-velvet">
                {fmtMoneyExact(months.reduce((sum, monthKey) => sum + (balanceByMonth[monthKey] ?? 0), 0))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
