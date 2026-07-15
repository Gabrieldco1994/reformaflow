'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { currencyInputToCents, maskCurrencyInput } from '@/lib/currency-input';

interface Props {
  sourceProjectId: string;
  onSuccess: () => void;
}

export default function AllocationForm({ sourceProjectId, onSuccess }: Props) {
  const [targetProjectId, setTargetProjectId] = useState('');
  const [valor, setValor] = useState('');
  const [mes, setMes] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [descricao, setDescricao] = useState('');

  // Get available budget
  const { data: availableBudget = 0 } = useQuery<number>({
    queryKey: ['budget-available', sourceProjectId],
    queryFn: async () => {
      const data = await api.get(`/budget-allocations/available/${sourceProjectId}`);
      return data as number;
    },
  });

  // Get all projects except PESSOAL
  const { data: projects = [] } = useQuery<any[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const data = await api.get('/projects');
      return data as any[];
    },
    select: (data) => data.filter(p => p.type !== 'PESSOAL' && p.id !== sourceProjectId),
  });

  const mutation = useMutation({
    mutationFn: (data: any) => api.post(`/budget-allocations?sourceProjectId=${sourceProjectId}`, data),
    onSuccess: () => {
      toast.success('Budget alocado com sucesso!');
      setTargetProjectId('');
      setValor('');
      setDescricao('');
      onSuccess();
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Erro ao alocar budget');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const valorCents = currencyInputToCents(valor);
    
    if (!targetProjectId || valorCents <= 0) {
      toast.error('Preencha todos os campos obrigatórios');
      return;
    }

    // Check if trying to allocate more than available
    if (valorCents > availableBudget) {
      toast.error(`Valor excede o budget disponível. Disponível: R$ ${(availableBudget / 100).toFixed(2)}`);
      return;
    }

    mutation.mutate({
      targetProjectId,
      valor: valorCents,
      mes,
      descricao: descricao || undefined,
    });
  };

  const isFormDisabled = availableBudget === 0 || mutation.isPending;

  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 lg:p-6">
      <h2 className="font-editorial italic text-lg text-darc-velvet mb-4">Nova Alocação</h2>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-darc-velvet mb-1">
            Projeto Destino *
          </label>
          <select
            value={targetProjectId}
            onChange={(e) => setTargetProjectId(e.target.value)}
            className="w-full px-3 py-2 border border-darc-linen rounded-lg focus:ring-2 focus:ring-darc-red focus:border-transparent"
            required
          >
            <option value="">Selecione um projeto</option>
            {projects.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-darc-velvet mb-1">
            Valor (R$) *
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={valor}
            onChange={(e) => setValor(maskCurrencyInput(e.target.value))}
            className="w-full px-3 py-2 border border-darc-linen rounded-lg focus:ring-2 focus:ring-darc-red focus:border-transparent"
            placeholder="0,00"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-darc-velvet mb-1">
            Mês de Referência *
          </label>
          <input
            type="month"
            value={mes}
            onChange={(e) => setMes(e.target.value)}
            className="w-full px-3 py-2 border border-darc-linen rounded-lg focus:ring-2 focus:ring-darc-red focus:border-transparent"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-darc-velvet mb-1">
            Descrição (opcional)
          </label>
          <input
            type="text"
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            className="w-full px-3 py-2 border border-darc-linen rounded-lg focus:ring-2 focus:ring-darc-red focus:border-transparent"
            placeholder="Ex: Budget mensal, Extra reforma..."
          />
        </div>

        <button
          type="submit"
          disabled={isFormDisabled}
          className={`w-full px-4 py-2 rounded-lg font-medium transition-colors ${
            isFormDisabled
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-darc-red text-white hover:bg-darc-red/90'
          }`}
        >
          {mutation.isPending ? 'Alocando...' : 'Alocar Budget'}
        </button>

        {availableBudget === 0 && (
          <p className="text-sm text-orange-600 text-center">
            ⚠️ Nenhum budget disponível para alocar. Seus recebimentos em caixa já estão comprometidos com despesas e alocações existentes (ou ainda não há recebimentos <strong>EM CAIXA</strong>).
          </p>
        )}
      </form>
    </div>
  );
}
