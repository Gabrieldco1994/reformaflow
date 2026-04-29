'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { BudgetStatus } from '@reformaflow/domain';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Save } from 'lucide-react';

const PROJECT_ID = 'demo-project';

interface BudgetItemRow {
  id: string;
  roomName: string;
  workTypeName: string;
  planned: number;
  actual: number;
  balance: number;
  percentConsumed: number;
  status: BudgetStatus | '-';
}

function StatusBadge({ status }: { status: BudgetStatus | '-' }) {
  if (status === '-') return <span className="text-gray-400">—</span>;
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
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

export default function ProjectsPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const { data: items = [], isLoading } = useQuery<BudgetItemRow[]>({
    queryKey: ['budget-items', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/budget-items`),
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: ({ id, planned }: { id: string; planned: number }) =>
      api.patch(`/projects/${PROJECT_ID}/budget-items/${id}`, { planned }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budget-items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setEditingId(null);
    },
  });

  // Mock data para demonstração
  const mockItems: BudgetItemRow[] = [
    { id: '1', roomName: 'Sala de TV', workTypeName: 'Civil', planned: 3000, actual: 0, balance: 3000, percentConsumed: 0, status: '-' },
    { id: '2', roomName: 'Sala de TV', workTypeName: 'Elétrica', planned: 1500, actual: 0, balance: 1500, percentConsumed: 0, status: '-' },
    { id: '3', roomName: 'Cozinha', workTypeName: 'Civil', planned: 5000, actual: 2000, balance: 3000, percentConsumed: 0.4, status: BudgetStatus.OK },
    { id: '4', roomName: 'Cozinha', workTypeName: 'Hidráulica', planned: 3000, actual: 2500, balance: 500, percentConsumed: 0.83, status: BudgetStatus.WARNING },
    { id: '5', roomName: 'Banheiro Social', workTypeName: 'Pisos/Revestimentos', planned: 2000, actual: 2200, balance: -200, percentConsumed: 1.1, status: BudgetStatus.OVER_BUDGET },
  ];

  const displayItems = items.length > 0 ? items : mockItems;

  // Agrupar por ambiente
  const grouped = displayItems.reduce<Record<string, BudgetItemRow[]>>((acc, item) => {
    if (!acc[item.roomName]) acc[item.roomName] = [];
    acc[item.roomName]!.push(item);
    return acc;
  }, {});

  const handleSave = (id: string) => {
    const planned = parseFloat(editValue);
    if (!isNaN(planned) && planned >= 0) {
      mutation.mutate({ id, planned });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">📋 Orçamento Master</h1>
        <p className="text-sm text-gray-500 mt-1">
          Clique no valor Previsto para editar. Realizado é calculado automaticamente.
        </p>
      </div>

      {isLoading && <div className="text-gray-500">Carregando...</div>}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Ambiente</th>
              <th className="px-4 py-3">Tipo de Obra</th>
              <th className="px-4 py-3 text-right">Previsto (R$)</th>
              <th className="px-4 py-3 text-right">Realizado (R$)</th>
              <th className="px-4 py-3 text-right">Saldo (R$)</th>
              <th className="px-4 py-3 text-right">% Consumido</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {Object.entries(grouped).map(([roomName, roomItems]) =>
              roomItems.map((item, idx) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">
                    {idx === 0 ? roomName : ''}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{item.workTypeName}</td>
                  <td className="px-4 py-2 text-right">
                    {editingId === item.id ? (
                      <div className="flex items-center gap-1 justify-end">
                        <input
                          type="number"
                          className="w-24 border rounded px-2 py-1 text-right text-sm"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSave(item.id)}
                          autoFocus
                        />
                        <Button size="sm" onClick={() => handleSave(item.id)}>
                          <Save className="w-3 h-3" />
                        </Button>
                      </div>
                    ) : (
                      <button
                        className="text-brand-600 hover:underline cursor-pointer"
                        onClick={() => { setEditingId(item.id); setEditValue(String(item.planned)); }}
                      >
                        {formatCurrency(item.planned)}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-600">
                    {formatCurrency(item.actual)}
                  </td>
                  <td className={`px-4 py-2 text-right ${item.balance < 0 ? 'text-red-600 font-medium' : 'text-gray-600'}`}>
                    {formatCurrency(item.balance)}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-600">
                    {item.planned > 0 ? formatPercent(item.percentConsumed) : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={item.status} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
