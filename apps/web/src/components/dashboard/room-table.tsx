'use client';

import type { RoomSummary } from '@/types/dashboard';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { BudgetStatus } from '@reformaflow/domain';

interface RoomTableProps {
  rooms: RoomSummary[];
}

function StatusBadge({ status }: { status: BudgetStatus | '-' }) {
  if (status === '-') {
    return <span className="text-xs text-gray-400">—</span>;
  }

  const styles = {
    [BudgetStatus.OK]: 'bg-green-100 text-green-700',
    [BudgetStatus.WARNING]: 'bg-yellow-100 text-yellow-700',
    [BudgetStatus.OVER_BUDGET]: 'bg-red-100 text-red-700',
  };

  const labels = {
    [BudgetStatus.OK]: 'OK',
    [BudgetStatus.WARNING]: 'Atenção',
    [BudgetStatus.OVER_BUDGET]: 'Estourado',
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

export function RoomTable({ rooms }: RoomTableProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">
        📋 Resumo por Ambiente
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-b">
              <th className="pb-2 pr-4">Ambiente</th>
              <th className="pb-2 pr-4 text-right">Previsto</th>
              <th className="pb-2 pr-4 text-right">Realizado</th>
              <th className="pb-2 pr-4 text-right">%</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rooms.map((room) => (
              <tr key={room.roomName} className="hover:bg-gray-50">
                <td className="py-2 pr-4 font-medium text-gray-900">
                  {room.roomName}
                </td>
                <td className="py-2 pr-4 text-right text-gray-600">
                  {formatCurrency(room.planned)}
                </td>
                <td className="py-2 pr-4 text-right text-gray-600">
                  {formatCurrency(room.actual)}
                </td>
                <td className="py-2 pr-4 text-right text-gray-600">
                  {room.planned > 0 ? formatPercent(room.percentConsumed) : '—'}
                </td>
                <td className="py-2">
                  <StatusBadge status={room.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
