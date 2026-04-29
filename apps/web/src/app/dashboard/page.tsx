'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { KpiCards } from '@/components/dashboard/kpi-cards';
import { RoomTable } from '@/components/dashboard/room-table';
import { BudgetChart } from '@/components/dashboard/budget-chart';
import type { DashboardData } from '@/types/dashboard';

// TODO: buscar projectId do contexto/estado global
const PROJECT_ID = 'demo-project';

export default function DashboardPage() {
  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: ['dashboard', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/budget-items/dashboard`),
    // Em dev sem backend rodando, usar dados mock
    retry: false,
  });

  // Dados de demonstração quando API não está disponível
  const mockData: DashboardData = {
    totalPlanned: 30000,
    totalActual: 0,
    totalBalance: 30000,
    percentConsumed: 0,
    status: '-',
    byRoom: [
      { roomName: 'Sala de TV', planned: 0, actual: 0, balance: 0, percentConsumed: 0, status: '-' },
      { roomName: 'Cozinha', planned: 0, actual: 0, balance: 0, percentConsumed: 0, status: '-' },
      { roomName: 'Banheiro Social', planned: 0, actual: 0, balance: 0, percentConsumed: 0, status: '-' },
      { roomName: 'Banheiro Suíte', planned: 0, actual: 0, balance: 0, percentConsumed: 0, status: '-' },
      { roomName: 'Quarto Casal', planned: 0, actual: 0, balance: 0, percentConsumed: 0, status: '-' },
      { roomName: 'Área de Serviço', planned: 0, actual: 0, balance: 0, percentConsumed: 0, status: '-' },
      { roomName: 'Geral (casa toda)', planned: 0, actual: 0, balance: 0, percentConsumed: 0, status: '-' },
    ],
  };

  const dashboard = data ?? mockData;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          🏠 Dashboard — Reforma Casa
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Visão geral do orçamento e gastos da obra
        </p>
      </div>

      {error && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-700">
          API indisponível — exibindo dados de demonstração
        </div>
      )}

      <KpiCards
        totalPlanned={dashboard.totalPlanned}
        totalActual={dashboard.totalActual}
        totalBalance={dashboard.totalBalance}
        percentConsumed={dashboard.percentConsumed}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BudgetChart rooms={dashboard.byRoom} />
        <RoomTable rooms={dashboard.byRoom} />
      </div>
    </div>
  );
}
