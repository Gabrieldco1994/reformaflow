'use client';

import { Edit2, Trash2 } from 'lucide-react';
import {
  getMaintenanceDisplay,
  type MaintenanceLog,
  type MaintenanceProjectType,
} from '../_display';

interface MaintenanceHistoryViewProps {
  logs: MaintenanceLog[];
  projectType: MaintenanceProjectType;
  onEdit: (log: MaintenanceLog) => void;
  onDelete: (id: string) => void;
}

export function MaintenanceHistoryView({
  logs,
  projectType,
  onEdit,
  onDelete,
}: MaintenanceHistoryViewProps) {
  const rows = logs.map((log) => getMaintenanceDisplay(log, projectType));
  const isCar = projectType === 'CARRO';

  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border bg-white md:block">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Tipo
              </th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">
                Realizada
              </th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">
                Próxima
              </th>
              {isCar && (
                <th className="px-4 py-3 text-right font-medium text-gray-600">
                  Km
                </th>
              )}
              <th className="px-4 py-3 text-right font-medium text-gray-600">
                Custo
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Fornecedor
              </th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">
                Ações
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.source.id}>
                <td className="px-4 py-3 font-medium">{row.type}</td>
                <td className="px-4 py-3 text-center">{row.completedDate}</td>
                <td className="px-4 py-3 text-center">
                  <span className={row.nextColor}>
                    {row.nextDate}
                    {row.nextText ? ` (${row.nextText})` : ''}
                  </span>
                </td>
                {isCar && (
                  <td className="px-4 py-3 text-right font-mono">
                    {row.mileage}
                  </td>
                )}
                <td className="px-4 py-3 text-right font-mono">{row.cost}</td>
                <td className="px-4 py-3">{row.supplier}</td>
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => onEdit(row.source)}
                      className="p-1 text-gray-400 hover:text-brand-600"
                      aria-label="Editar"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(row.source.id)}
                      className="p-1 text-gray-400 hover:text-red-500"
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
            aria-label={row.type}
            className="rounded-2xl border bg-white p-3.5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">{row.type}</p>
                <p className="mt-0.5 text-[12.5px] text-gray-500">
                  Realizada {row.completedDate}
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={() => onEdit(row.source)}
                  aria-label="Editar"
                  className="inline-flex h-11 w-11 items-center justify-center text-gray-400 hover:text-brand-600"
                >
                  <Edit2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(row.source.id)}
                  aria-label="Excluir"
                  className="inline-flex h-11 w-11 items-center justify-center text-gray-400 hover:text-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 text-[13px]">
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Próxima
                </dt>
                <dd className={row.nextColor}>
                  {row.nextDate}
                  {row.nextText ? ` (${row.nextText})` : ''}
                </dd>
              </div>
              {isCar && (
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                    Km
                  </dt>
                  <dd className="font-mono text-gray-600">
                    {row.mileage === '—' ? row.mileage : `${row.mileage} km`}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Custo
                </dt>
                <dd className="font-mono font-semibold text-gray-900">
                  {row.cost}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Fornecedor
                </dt>
                <dd className="text-gray-600">{row.supplier}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </>
  );
}
