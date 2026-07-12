'use client';

import { Edit2, Pause, Play, Trash2 } from 'lucide-react';
import { CardActionsMenu, type CardAction } from '@/components/CardActionsMenu';
import { getRecurringBillDisplay, type RecurringBillRow } from '../_display';

interface RecurringBillsViewProps {
  bills: RecurringBillRow[];
  onToggleStatus: (bill: RecurringBillRow) => void;
  onEdit: (bill: RecurringBillRow) => void;
  onDelete: (id: string) => void;
}

export function RecurringBillsView({
  bills,
  onToggleStatus,
  onEdit,
  onDelete,
}: RecurringBillsViewProps) {
  const rows = bills.map(getRecurringBillDisplay);

  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border bg-white md:block">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Conta
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">
                Categoria
              </th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">
                Valor
              </th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">
                Frequência
              </th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">
                Vencimento
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
              <tr
                key={row.source.id}
                className={row.active ? '' : 'opacity-50'}
              >
                <td className="px-4 py-3 font-medium">{row.name}</td>
                <td className="px-4 py-3 text-gray-600">{row.category}</td>
                <td className="px-4 py-3 text-right font-mono">{row.value}</td>
                <td className="px-4 py-3 text-center">{row.frequency}</td>
                <td className="px-4 py-3 text-center">{row.dueDate}</td>
                <td className="px-4 py-3 text-center">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${row.className}`}
                  >
                    {row.active ? 'Ativo' : 'Pausado'}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => onToggleStatus(row.source)}
                      className="p-1 text-gray-400 hover:text-brand-600"
                      title={row.actionLabel}
                      aria-label={row.actionLabel}
                    >
                      {row.active ? (
                        <Pause className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </button>
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
        {rows.map((row) => {
          const actions: CardAction[] = [
            {
              label: row.actionLabel,
              onClick: () => onToggleStatus(row.source),
              icon: row.active ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />,
            },
            {
              label: 'Editar',
              onClick: () => onEdit(row.source),
              icon: <Edit2 className="h-4 w-4" />,
            },
            {
              label: 'Excluir',
              onClick: () => onDelete(row.source.id),
              icon: <Trash2 className="h-4 w-4" />,
              tone: 'danger',
            },
          ];
          return (
            <article
              key={row.source.id}
              aria-label={row.name}
              className={`rounded-2xl border bg-white p-3.5 shadow-sm ${row.active ? '' : 'opacity-60'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold">{row.name}</p>
                  <p className="mt-0.5 text-[12.5px] text-gray-500">
                    {row.category} · {row.frequency} · vence{' '}
                    {row.dueDate.toLowerCase()}
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
                <CardActionsMenu ariaLabel={`Ações ${row.name}`} actions={actions} />
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
