'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { Plus, TrendingUp, TrendingDown } from 'lucide-react';
import { useState } from 'react';

const PROJECT_ID = 'demo-project';

interface CashFlowRow {
  id: string;
  plannedDate: string;
  effectiveDate: string | null;
  description: string;
  type: string;
  amount: number;
  status: string;
  rollingBalance: number;
  room?: { name: string } | null;
  workType?: { name: string } | null;
}

export default function CashFlowPage() {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const { data: entries = [] } = useQuery<CashFlowRow[]>({
    queryKey: ['cash-flow', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/cash-flow`),
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.post(`/projects/${PROJECT_ID}/cash-flow`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cash-flow'] });
      setModalOpen(false);
    },
  });

  // Mock data para demonstração
  const mockEntries: CashFlowRow[] = [
    { id: '1', plannedDate: '2026-05-01', effectiveDate: '2026-05-01', description: 'Aporte inicial', type: 'INCOME', amount: 30000, status: 'EXECUTED', rollingBalance: 30000 },
    { id: '2', plannedDate: '2026-05-05', effectiveDate: '2026-05-05', description: 'Sinal empreiteiro', type: 'EXPENSE', amount: 4000, status: 'EXECUTED', rollingBalance: 26000 },
    { id: '3', plannedDate: '2026-05-10', effectiveDate: '2026-05-12', description: 'Porcelanato Cozinha', type: 'EXPENSE', amount: 2500, status: 'EXECUTED', rollingBalance: 23500 },
    { id: '4', plannedDate: '2026-06-01', effectiveDate: null, description: 'Pagamento empreiteiro (Civil)', type: 'EXPENSE', amount: 6000, status: 'FORECAST', rollingBalance: 17500 },
    { id: '5', plannedDate: '2026-06-15', effectiveDate: null, description: 'Materiais hidráulica', type: 'EXPENSE', amount: 3000, status: 'FORECAST', rollingBalance: 14500 },
  ];

  const displayEntries = entries.length > 0 ? entries : mockEntries;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createMutation.mutate({
      plannedDate: formData.get('plannedDate'),
      effectiveDate: formData.get('effectiveDate') || undefined,
      description: formData.get('description'),
      type: formData.get('type'),
      amount: parseFloat(formData.get('amount') as string),
    });
  };

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      EXECUTED: 'bg-green-100 text-green-700',
      FORECAST: 'bg-blue-100 text-blue-700',
      OVERDUE: 'bg-red-100 text-red-700',
    };
    const labels: Record<string, string> = {
      EXECUTED: 'Realizado',
      FORECAST: 'Previsto',
      OVERDUE: 'Vencido',
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] ?? ''}`}>
        {labels[status] ?? status}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">💰 Fluxo de Caixa</h1>
          <p className="text-sm text-gray-500 mt-1">
            Controle de entradas e saídas com saldo acumulado
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="w-4 h-4" /> Nova Entrada
        </Button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Data Prevista</th>
              <th className="px-4 py-3">Data Efetiva</th>
              <th className="px-4 py-3">Descrição</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3 text-right">Valor (R$)</th>
              <th className="px-4 py-3 text-right">Saldo Acumulado</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {displayEntries.map((entry) => (
              <tr key={entry.id} className={`hover:bg-gray-50 ${entry.status === 'FORECAST' ? 'opacity-70' : ''}`}>
                <td className="px-4 py-2 text-gray-600">
                  {new Date(entry.plannedDate).toLocaleDateString('pt-BR')}
                </td>
                <td className="px-4 py-2 text-gray-600">
                  {entry.effectiveDate ? new Date(entry.effectiveDate).toLocaleDateString('pt-BR') : '—'}
                </td>
                <td className="px-4 py-2 font-medium text-gray-900">{entry.description}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    {entry.type === 'INCOME' ? (
                      <TrendingUp className="w-4 h-4 text-green-500" />
                    ) : (
                      <TrendingDown className="w-4 h-4 text-red-500" />
                    )}
                    <span className={entry.type === 'INCOME' ? 'text-green-700' : 'text-red-700'}>
                      {entry.type === 'INCOME' ? 'Entrada' : 'Saída'}
                    </span>
                  </div>
                </td>
                <td className={`px-4 py-2 text-right font-medium ${entry.type === 'INCOME' ? 'text-green-700' : 'text-red-700'}`}>
                  {entry.type === 'INCOME' ? '+' : '-'}{formatCurrency(entry.amount)}
                </td>
                <td className={`px-4 py-2 text-right font-bold ${entry.rollingBalance < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                  {formatCurrency(entry.rollingBalance)}
                </td>
                <td className="px-4 py-2">{statusBadge(entry.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nova Entrada no Fluxo de Caixa">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input id="plannedDate" name="plannedDate" label="Data Prevista" type="date" required />
            <Input id="effectiveDate" name="effectiveDate" label="Data Efetiva" type="date" />
          </div>
          <Input id="description" name="description" label="Descrição" placeholder="Ex: Pagamento empreiteiro" required />
          <div className="grid grid-cols-2 gap-4">
            <Select
              id="type"
              name="type"
              label="Tipo"
              options={[
                { value: 'INCOME', label: '↑ Entrada' },
                { value: 'EXPENSE', label: '↓ Saída' },
              ]}
              required
            />
            <Input id="amount" name="amount" label="Valor (R$)" type="number" step="0.01" min="0.01" required />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={createMutation.isPending}>Salvar</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
