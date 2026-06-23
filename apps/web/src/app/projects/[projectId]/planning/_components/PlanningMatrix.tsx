'use client';

import { useEffect, useMemo, useState } from 'react';
import { fmtMoneyExact } from '../../monthly/_cockpit/format';
import type { PlanningMatrixExpenseRow } from '../_types';

interface PlanningMatrixProps {
  months: string[];
  incomeByMonthCents: Record<string, number>;
  expenseRows: PlanningMatrixExpenseRow[];
  addableExpenseTypes: Array<{ value: string; label: string }>;
  onAddMonth: () => void;
  onIncomeChange: (monthKey: string, cents: number) => void;
  onExpenseChange: (monthKey: string, typeCode: string, cents: number) => void;
  onAddExpenseType: (typeCode: string) => void;
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
  addableExpenseTypes,
  onAddMonth,
  onIncomeChange,
  onExpenseChange,
  onAddExpenseType,
}: PlanningMatrixProps) {
  const [quickMonth, setQuickMonth] = useState(months[0] ?? '');
  const [quickType, setQuickType] = useState(expenseRows[0]?.typeCode ?? '');
  const [quickValue, setQuickValue] = useState('');
  const [newType, setNewType] = useState(addableExpenseTypes[0]?.value ?? '');

  useEffect(() => {
    if (!months.includes(quickMonth)) {
      setQuickMonth(months[0] ?? '');
    }
  }, [months, quickMonth]);

  useEffect(() => {
    if (expenseRows.length === 0) {
      setQuickType('');
      return;
    }
    if (!expenseRows.some((row) => row.typeCode === quickType)) {
      setQuickType(expenseRows[0]!.typeCode);
    }
  }, [expenseRows, quickType]);

  useEffect(() => {
    if (addableExpenseTypes.length === 0) {
      setNewType('');
      return;
    }
    if (!addableExpenseTypes.some((option) => option.value === newType)) {
      setNewType(addableExpenseTypes[0]!.value);
    }
  }, [addableExpenseTypes, newType]);

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
        <button
          type="button"
          onClick={onAddMonth}
          className="rounded-lg bg-darc-red px-3 py-2 text-xs font-semibold text-white hover:bg-darc-red/90"
        >
          + Adicionar mês
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-darc-linen p-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-darc-velvet/60">
            Edição rápida
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <select
              value={quickMonth}
              onChange={(e) => setQuickMonth(e.target.value)}
              className="rounded-lg border border-darc-linen px-2.5 py-2 text-sm text-darc-velvet bg-white"
            >
              {months.map((monthKey) => (
                <option key={monthKey} value={monthKey}>
                  {monthLabel(monthKey)}
                </option>
              ))}
            </select>
            <select
              value={quickType}
              onChange={(e) => setQuickType(e.target.value)}
              className="rounded-lg border border-darc-linen px-2.5 py-2 text-sm text-darc-velvet bg-white sm:col-span-2"
            >
              {expenseRows.map((row) => (
                <option key={row.typeCode} value={row.typeCode}>
                  {row.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              step={1}
              value={quickValue}
              onChange={(e) => setQuickValue(e.target.value)}
              placeholder="R$"
              className="rounded-lg border border-darc-linen px-2.5 py-2 text-sm text-darc-velvet bg-white"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              if (!quickMonth || !quickType) return;
              onExpenseChange(quickMonth, quickType, reaisToCents(Number(quickValue)));
            }}
            className="rounded-lg border border-darc-linen px-3 py-2 text-xs font-semibold text-darc-velvet hover:bg-darc-linen/40"
          >
            Aplicar valor
          </button>
        </div>

        <div className="rounded-xl border border-darc-linen p-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-darc-velvet/60">
            Adicionar tipo de despesa
          </p>
          {addableExpenseTypes.length === 0 ? (
            <p className="text-sm text-darc-velvet/60">Todos os tipos já estão na matriz.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                className="min-w-[220px] rounded-lg border border-darc-linen px-2.5 py-2 text-sm text-darc-velvet bg-white"
              >
                {addableExpenseTypes.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => newType && onAddExpenseType(newType)}
                className="rounded-lg border border-darc-linen px-3 py-2 text-xs font-semibold text-darc-velvet hover:bg-darc-linen/40"
              >
                Adicionar linha
              </button>
            </div>
          )}
        </div>
      </div>

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
