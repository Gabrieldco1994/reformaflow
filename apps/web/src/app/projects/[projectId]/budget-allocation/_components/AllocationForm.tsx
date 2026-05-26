'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

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
      alert('Budget alocado com sucesso!');
      setTargetProjectId('');
      setValor('');
      setDescricao('');
      onSuccess();
    },
    onError: (error: any) => {
      alert(error.response?.data?.message || 'Erro ao alocar budget');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const valorCents = Math.round(parseFloat(valor) * 100);
    
    if (!targetProjectId || valorCents <= 0) {
      alert('Preencha todos os campos obrigatórios');
      return;
    }

    mutation.mutate({
      targetProjectId,
      valor: valorCents,
      mes,
      descricao: descricao || undefined,
    });
  };

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
            type="number"
            step="0.01"
            min="0.01"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
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
          disabled={mutation.isPending}
          className="w-full px-4 py-2 bg-darc-red text-white rounded-lg hover:bg-darc-red/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {mutation.isPending ? 'Alocando...' : 'Alocar Budget'}
        </button>
      </form>
    </div>
  );
}
