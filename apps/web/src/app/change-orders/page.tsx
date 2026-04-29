'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Plus, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { useState } from 'react';

const PROJECT_ID = 'demo-project';

interface ChangeOrder {
  id: string;
  date: string;
  item: string;
  reason: string;
  additionalAmount: number;
  approvedBy: string | null;
  status: string;
  notes: string | null;
  room?: { name: string } | null;
  workType?: { name: string } | null;
}

export default function ChangeOrdersPage() {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const { data: orders = [] } = useQuery<ChangeOrder[]>({
    queryKey: ['change-orders', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/change-orders`),
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.post(`/projects/${PROJECT_ID}/change-orders`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['change-orders'] });
      setModalOpen(false);
    },
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) =>
      api.patch(`/projects/${PROJECT_ID}/change-orders/${id}/approve`, { approvedBy: 'Proprietário' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['change-orders'] });
      queryClient.invalidateQueries({ queryKey: ['budget-items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) =>
      api.patch(`/projects/${PROJECT_ID}/change-orders/${id}/reject`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['change-orders'] });
    },
  });

  // Mock data
  const mockOrders: ChangeOrder[] = [
    { id: '1', date: '2026-05-20', item: 'Ponto elétrico extra na cozinha', reason: 'Necessidade de tomada para cooktop', additionalAmount: 800, approvedBy: null, status: 'PENDING', notes: null, room: { name: 'Cozinha' }, workType: { name: 'Elétrica' } },
    { id: '2', date: '2026-05-18', item: 'Troca de revestimento banheiro', reason: 'Material original descontinuado', additionalAmount: 1200, approvedBy: 'Gabriel', status: 'APPROVED', notes: 'Optou-se por Portinari', room: { name: 'Banheiro Suíte' }, workType: { name: 'Pisos/Revestimentos' } },
    { id: '3', date: '2026-05-15', item: 'Nicho extra no box', reason: 'Solicitação do cônjuge', additionalAmount: 350, approvedBy: null, status: 'REJECTED', notes: 'Fora do escopo', room: { name: 'Banheiro Social' }, workType: { name: 'Civil' } },
  ];

  const displayOrders = orders.length > 0 ? orders : mockOrders;
  const totalPending = displayOrders.filter(o => o.status === 'PENDING').reduce((s, o) => s + o.additionalAmount, 0);
  const totalApproved = displayOrders.filter(o => o.status === 'APPROVED').reduce((s, o) => s + o.additionalAmount, 0);

  const statusConfig: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
    PENDING: { icon: <Clock className="w-4 h-4" />, color: 'text-yellow-600 bg-yellow-50', label: 'Pendente' },
    APPROVED: { icon: <CheckCircle className="w-4 h-4" />, color: 'text-green-600 bg-green-50', label: 'Aprovado' },
    REJECTED: { icon: <XCircle className="w-4 h-4" />, color: 'text-red-600 bg-red-50', label: 'Rejeitado' },
    EXECUTED: { icon: <CheckCircle className="w-4 h-4" />, color: 'text-blue-600 bg-blue-50', label: 'Executado' },
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createMutation.mutate({
      date: formData.get('date'),
      item: formData.get('item'),
      reason: formData.get('reason'),
      additionalAmount: parseFloat(formData.get('additionalAmount') as string),
      roomId: formData.get('roomId') || undefined,
      workTypeId: formData.get('workTypeId') || undefined,
      notes: formData.get('notes') || undefined,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">⚠️ Pendências e Aditivos</h1>
          <p className="text-sm text-gray-500 mt-1">
            Aditivos aprovados somam automaticamente ao Previsto do orçamento
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="w-4 h-4" /> Novo Aditivo
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-xs font-medium text-yellow-700 uppercase">Pendentes</p>
          <p className="text-lg font-bold text-yellow-900">{formatCurrency(totalPending)}</p>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-xs font-medium text-green-700 uppercase">Aprovados</p>
          <p className="text-lg font-bold text-green-900">{formatCurrency(totalApproved)}</p>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <p className="text-xs font-medium text-gray-700 uppercase">Total Aditivos</p>
          <p className="text-lg font-bold text-gray-900">{formatCurrency(totalPending + totalApproved)}</p>
        </div>
      </div>

      {/* Lista */}
      <div className="space-y-3">
        {displayOrders.map((order) => {
          const config = statusConfig[order.status] ?? statusConfig['PENDING']!;
          return (
            <div key={order.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-900">{order.item}</h3>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.color}`}>
                      {config.icon} {config.label}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">{order.reason}</p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                    <span>{new Date(order.date).toLocaleDateString('pt-BR')}</span>
                    {order.room && <span>📍 {order.room.name}</span>}
                    {order.workType && <span>🔧 {order.workType.name}</span>}
                    {order.approvedBy && <span>✅ {order.approvedBy}</span>}
                    {order.notes && <span>💬 {order.notes}</span>}
                  </div>
                </div>
                <div className="text-right ml-4">
                  <p className="text-lg font-bold text-gray-900">
                    +{formatCurrency(order.additionalAmount)}
                  </p>
                  {order.status === 'PENDING' && (
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" onClick={() => approveMutation.mutate(order.id)}>
                        Aprovar
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => rejectMutation.mutate(order.id)}>
                        Rejeitar
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Novo Aditivo de Escopo">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input id="date" name="date" label="Data" type="date" required />
          <Input id="item" name="item" label="Item / Mudança" placeholder="Ex: Ponto elétrico extra" required />
          <Input id="reason" name="reason" label="Motivo" placeholder="Ex: Necessidade descoberta na obra" required />
          <div className="grid grid-cols-2 gap-4">
            <Input id="roomId" name="roomId" label="ID Ambiente" placeholder="(opcional)" />
            <Input id="workTypeId" name="workTypeId" label="ID Tipo de Obra" placeholder="(opcional)" />
          </div>
          <Input id="additionalAmount" name="additionalAmount" label="Valor Adicional (R$)" type="number" step="0.01" min="0" required />
          <Input id="notes" name="notes" label="Observações" placeholder="Detalhes adicionais" />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={createMutation.isPending}>
              <AlertTriangle className="w-4 h-4" /> Registrar Aditivo
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
