'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import { canReadBudgetAllocations } from '@/lib/budget-allocation-access';
import AllocationHistory from './_components/AllocationHistory';
import AvailableBudgetCard from './_components/AvailableBudgetCard';

/**
 * #449 B2 — histórico administrativo somente leitura.
 *
 * Não há mais formulário de alocação nem exclusão: as rotas mutáveis deixaram
 * de existir na API, para qualquer papel. A página saiu da descoberta (menu) e
 * a leitura exige papel full-access não-convidado (mesmo gate da API).
 *
 * Quem chegar por deep-link sem o papel vê um aviso — e não a tela normal com
 * as consultas em 403: os fallbacks (`?? 0`) renderizariam "disponível
 * R$ 0,00", que é dado ERRADO, não dado ausente.
 */
export default function BudgetAllocationPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const { user: authUser } = useAuth();
  const canRead = canReadBudgetAllocations(authUser);

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
    enabled: !!project && canRead,
  });

  // Get summary
  const { data: summary } = useQuery<any>({
    queryKey: ['budget-summary', projectId],
    queryFn: async () => {
      const data = await api.get(`/budget-allocations/summary/${projectId}`);
      return data;
    },
    enabled: !!project && canRead,
  });

  // Get allocations list
  const { data: allocations = [] } = useQuery<any[]>({
    queryKey: ['budget-allocations', projectId],
    queryFn: async () => {
      const data = await api.get(`/budget-allocations?sourceProjectId=${projectId}`);
      return (data as any[]) || [];
    },
    enabled: !!project && canRead,
  });

  if (!canRead) {
    return (
      <div className="p-4 lg:p-6">
        <div className="rounded-2xl bg-darc-linen/30 border border-darc-linen p-6 text-center">
          <p className="text-darc-velvet">
            Alocação de Budget é um <strong>histórico administrativo somente leitura</strong> e
            está disponível apenas para administradores do workspace.
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
    <div className="p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-editorial italic text-2xl lg:text-3xl text-darc-velvet mb-2">
          Alocação de Budget
        </h1>
        <p className="text-sm text-darc-velvet/60">
          Histórico de alocações do projeto <strong>{project.name}</strong>. Somente leitura.
        </p>
      </div>

      {/* Available Budget Card */}
      <AvailableBudgetCard
        available={availableBudget ?? 0}
        totalAllocated={summary?.totalAllocated ?? 0}
        totalExpenses={summary?.totalExpenses ?? 0}
        totalReceipts={summary?.totalReceipts ?? 0}
        allocations={summary?.allocations ?? []}
      />

      {/* Allocation History */}
      <AllocationHistory allocations={allocations} />
    </div>
  );
}
