'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Plus, HardHat, CheckCircle, Clock } from 'lucide-react';
import { useState } from 'react';

const PROJECT_ID = 'demo-project';

interface Milestone {
  id: string;
  stage: string;
  percentage: number;
  percentCompleted: number;
  releasedAmount: number;
  paymentStatus: string;
  paymentDate: string | null;
}

interface ContractorSummary {
  id: string;
  name: string;
  contractedAmount: number;
  totalReleased: number;
  milestones: Milestone[];
}

export default function ContractorsPage() {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const { data: contractors = [] } = useQuery<ContractorSummary[]>({
    queryKey: ['contractors', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/contractors`),
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.post(`/projects/${PROJECT_ID}/contractors`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contractors'] });
      setModalOpen(false);
    },
  });

  const updateMilestoneMutation = useMutation({
    mutationFn: ({ milestoneId, data }: { milestoneId: string; data: Record<string, unknown> }) =>
      api.patch(`/projects/${PROJECT_ID}/contractors/milestones/${milestoneId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contractors'] });
      queryClient.invalidateQueries({ queryKey: ['budget-items'] });
    },
  });

  // Mock data
  const mockContractors: ContractorSummary[] = [
    {
      id: '1',
      name: 'João Pedreiro',
      contractedAmount: 20000,
      totalReleased: 4000,
      milestones: [
        { id: 'm1', stage: 'Sinal (20%)', percentage: 0.2, percentCompleted: 1, releasedAmount: 4000, paymentStatus: 'PAID', paymentDate: '2026-05-01' },
        { id: 'm2', stage: 'Demolição/Civil (30%)', percentage: 0.3, percentCompleted: 0.5, releasedAmount: 3000, paymentStatus: 'PARTIAL', paymentDate: null },
        { id: 'm3', stage: 'Acabamentos (30%)', percentage: 0.3, percentCompleted: 0, releasedAmount: 0, paymentStatus: 'PENDING', paymentDate: null },
        { id: 'm4', stage: 'Entrega (20%)', percentage: 0.2, percentCompleted: 0, releasedAmount: 0, paymentStatus: 'PENDING', paymentDate: null },
      ],
    },
  ];

  const displayContractors = contractors.length > 0 ? contractors : mockContractors;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createMutation.mutate({
      name: formData.get('name'),
      phone: formData.get('phone') || undefined,
      contractedAmount: parseFloat(formData.get('contractedAmount') as string),
    });
  };

  const handleMarkPaid = (milestoneId: string) => {
    updateMilestoneMutation.mutate({
      milestoneId,
      data: { paymentStatus: 'PAID', percentCompleted: 1 },
    });
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'PAID': return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'PARTIAL': return <Clock className="w-4 h-4 text-yellow-500" />;
      default: return <Clock className="w-4 h-4 text-gray-400" />;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">👷 Empreiteiros</h1>
          <p className="text-sm text-gray-500 mt-1">
            Controle de marcos de pagamento (Sinal 20%, Demolição 30%, Acabamentos 30%, Entrega 20%)
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="w-4 h-4" /> Novo Empreiteiro
        </Button>
      </div>

      {displayContractors.map((contractor) => (
        <div key={contractor.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <HardHat className="w-5 h-5 text-gray-600" />
              <div>
                <h3 className="font-semibold text-gray-900">{contractor.name}</h3>
                <p className="text-xs text-gray-500">
                  Contratado: {formatCurrency(contractor.contractedAmount)} · Liberado: {formatCurrency(contractor.totalReleased)}
                </p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-gray-900">
                {formatPercent(contractor.totalReleased / contractor.contractedAmount)} concluído
              </div>
              <div className="w-32 bg-gray-200 rounded-full h-2 mt-1">
                <div
                  className="bg-brand-600 h-2 rounded-full transition-all"
                  style={{ width: `${Math.min((contractor.totalReleased / contractor.contractedAmount) * 100, 100)}%` }}
                />
              </div>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2">Etapa</th>
                <th className="px-4 py-2 text-right">% Contrato</th>
                <th className="px-4 py-2 text-right">% Concluído</th>
                <th className="px-4 py-2 text-right">Valor Liberado</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {contractor.milestones.map((m) => (
                <tr key={m.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">{m.stage}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{formatPercent(m.percentage)}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{formatPercent(m.percentCompleted)}</td>
                  <td className="px-4 py-2 text-right font-medium">{formatCurrency(m.releasedAmount)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      {statusIcon(m.paymentStatus)}
                      <span className="text-xs text-gray-600">{m.paymentStatus}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {m.paymentStatus !== 'PAID' && (
                      <Button size="sm" variant="ghost" onClick={() => handleMarkPaid(m.id)}>
                        Marcar Pago
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Novo Empreiteiro">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input id="name" name="name" label="Nome" placeholder="Ex: João Pedreiro" required />
          <Input id="phone" name="phone" label="Telefone" placeholder="(11) 99999-0000" />
          <Input id="contractedAmount" name="contractedAmount" label="Valor Contratado (R$)" type="number" step="0.01" min="0" required />
          <p className="text-xs text-gray-500">
            4 marcos de pagamento serão criados automaticamente: Sinal 20%, Demolição/Civil 30%, Acabamentos 30%, Entrega 20%
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={createMutation.isPending}>
              <HardHat className="w-4 h-4" /> Cadastrar
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
