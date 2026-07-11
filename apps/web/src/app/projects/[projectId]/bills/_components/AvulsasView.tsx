'use client';

import type { ProjectType } from '@reformaflow/domain';
import { Edit2, Trash2 } from 'lucide-react';
import { getAvulsaDisplay, type AvulsaRow } from '../_display';

interface AvulsasViewProps {
  expenses: AvulsaRow[];
  projectType: ProjectType;
  onEdit: (expense: AvulsaRow) => void;
  onDelete: (id: string) => void;
}

export function AvulsasView({
  expenses,
  projectType,
  onEdit,
  onDelete,
}: AvulsasViewProps) {
  const rows = expenses.map((expense) =>
    getAvulsaDisplay(expense, projectType),
  );

  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border bg-white md:block">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Data
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Título
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Categoria
              </th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">
                Valor
              </th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">
                Status
              </th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">
                Ações
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.source.id}>
                <td className="px-4 py-3 text-gray-700">{row.date}</td>
                <td className="px-4 py-3 font-medium">{row.title}</td>
                <td className="px-4 py-3 text-gray-600">{row.category}</td>
                <td className="px-4 py-3 text-right font-mono">{row.value}</td>
                <td className="px-4 py-3 text-center">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${row.className}`}
                  >
                    {row.label}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => onEdit(row.source)}
                      className="p-1 text-gray-400 hover:text-brand-600"
                      title="Editar"
                      aria-label="Editar"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(row.source.id)}
                      className="p-1 text-gray-400 hover:text-red-500"
                      title="Excluir"
                      aria-label="Excluir"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-2.5 md:hidden">
        {rows.map((row) => (
          <article
            key={row.source.id}
            aria-label={row.title}
            className="rounded-2xl border bg-white p-3.5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">
                  {row.title}
                </p>
                <p className="mt-0.5 text-[12.5px] text-gray-500">
                  {row.category} · {row.date}
                </p>
              </div>
              <p className="shrink-0 font-mono text-[15px] font-bold">
                {row.value}
              </p>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${row.className}`}
              >
                {row.label}
              </span>
              <div className="flex items-center text-[13px] font-semibold">
                <button
                  type="button"
                  onClick={() => onEdit(row.source)}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center px-3 text-brand-600"
                >
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(row.source.id)}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center px-3 text-red-500"
                >
                  Excluir
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
