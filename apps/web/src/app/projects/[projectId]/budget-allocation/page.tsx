'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { ProjectTypeLabels } from '@reformaflow/domain';
import AllocationForm from './_components/AllocationForm';
import AllocationHistory from './_components/AllocationHistory';
import AvailableBudgetCard from './_components/AvailableBudgetCard';

export default function BudgetAllocationPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const queryClient = useQueryClient();

  // Get project to check if PESSOAL
  const { data: project } = useQuery<any>({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const data = await api.get(`/projects/${projectId}`);
      return data;
    },
  });

  // Get available budget
  const { data: availableBudget } = useQuery<number>({
    queryKey: ['budget-available', projectId],
    queryFn: async () => {
      const data = await api.get(`/budget-allocations/available/${projectId}`);
      return data as number;
    },
    enabled: !!project,
  });

  // Get summary
  const { data: summary } = useQuery<any>({
    queryKey: ['budget-summary', projectId],
    queryFn: async () => {
      const data = await api.get(`/budget-allocations/summary/${projectId}`);
      return data;
    },
    enabled: !!project,
  });

  // Get allocations list
  const { data: allocations = [], refetch } = useQuery<any[]>({
    queryKey: ['budget-allocations', projectId],
    queryFn: async () => {
      const data = await api.get(`/budget-allocations?sourceProjectId=${projectId}`);
      return (data as any[]) || [];
    },
    enabled: !!project,
  });

  if (!project) {
    return <div className="p-4">Carregando...</div>;
  }

  if (project.type !== 'PESSOAL') {
    return (
      <div className="p-4 lg:p-6">
        <div className="rounded-2xl bg-darc-linen/30 border border-darc-linen p-6 text-center">
          <p className="text-darc-velvet">
            Alocação de budget só está disponível para projetos do tipo <strong>PESSOAL</strong>.
          </p>
          <button
            onClick={() => router.back()}
            className="mt-4 px-4 py-2 bg-darc-red text-white rounded-lg hover:bg-darc-red/90"
          >
            Voltar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-editorial italic text-2xl lg:text-3xl text-darc-velvet mb-2">
          Alocação de Budget
        </h1>
        <p className="text-sm text-darc-velvet/60">
          Distribua seu budget do projeto <strong>{project.name}</strong> para seus outros projetos de vida.
        </p>
      </div>

      {/* Available Budget Card */}
      <AvailableBudgetCard
        available={availableBudget ?? 0}
        totalAllocated={summary?.totalAllocated ?? 0}
        allocations={summary?.allocations ?? []}
      />

      {/* Allocation Form */}
      <AllocationForm
        sourceProjectId={projectId}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['budget-available', projectId] });
          queryClient.invalidateQueries({ queryKey: ['budget-summary', projectId] });
          refetch();
        }}
      />

      {/* Allocation History */}
      <AllocationHistory
        allocations={allocations}
        onDelete={() => {
          queryClient.invalidateQueries({ queryKey: ['budget-available', projectId] });
          queryClient.invalidateQueries({ queryKey: ['budget-summary', projectId] });
          refetch();
        }}
      />
    </div>
  );
}
