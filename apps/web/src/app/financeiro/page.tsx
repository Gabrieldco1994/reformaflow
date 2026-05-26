'use client';

import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  TenantFinancialOverview,
  ProjectBreakdownRow,
  ConsolidatedCashFlowPoint,
  CategoryRow,
  UpcomingDueRow,
  SupplierRow,
} from './_types';
import { KpiCards } from './_components/KpiCards';
import { ProjectsBreakdown } from './_components/ProjectsBreakdown';
import { UpcomingTable } from './_components/UpcomingTable';
import { TopSuppliers } from './_components/TopSuppliers';

const CashFlowCharts = dynamic(() => import('./_components/CashFlowCharts'), {
  ssr: false,
  loading: () => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 h-[340px] animate-pulse" />
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 h-[340px] animate-pulse" />
    </div>
  ),
});

const CategoryDonut = dynamic(() => import('./_components/CategoryDonut'), { ssr: false });

export default function FinanceiroPage() {
  const overview = useQuery<TenantFinancialOverview>({
    queryKey: ['tenant-financial', 'overview'],
    queryFn: () => api.get('/tenant/financial/overview'),
    staleTime: 60_000,
  });

  const byProject = useQuery<ProjectBreakdownRow[]>({
    queryKey: ['tenant-financial', 'by-project'],
    queryFn: () => api.get('/tenant/financial/by-project'),
    staleTime: 60_000,
  });

  const cashFlow = useQuery<ConsolidatedCashFlowPoint[]>({
    queryKey: ['tenant-financial', 'cash-flow', 12],
    queryFn: () => api.get('/tenant/financial/cash-flow?months=12'),
    staleTime: 60_000,
  });

  const categories = useQuery<CategoryRow[]>({
    queryKey: ['tenant-financial', 'by-category'],
    queryFn: () => api.get('/tenant/financial/by-category'),
    staleTime: 60_000,
  });

  const upcoming = useQuery<UpcomingDueRow[]>({
    queryKey: ['tenant-financial', 'upcoming', 30],
    queryFn: () => api.get('/tenant/financial/upcoming?days=30'),
    staleTime: 60_000,
  });

  const suppliers = useQuery<SupplierRow[]>({
    queryKey: ['tenant-financial', 'top-suppliers'],
    queryFn: () => api.get('/tenant/financial/top-suppliers?limit=8'),
    staleTime: 60_000,
  });

  const loading = overview.isLoading || byProject.isLoading;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6 md:space-y-8">
      <header>
        <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60">Visão Geral</p>
        <h1 className="font-editorial italic text-2xl md:text-3xl text-darc-velvet mt-1">Saúde financeira consolidada</h1>
        <p className="text-sm text-darc-velvet/70 mt-1">
          Todos os seus projetos juntos. Clique em um projeto para ver o detalhe.
        </p>
      </header>

      {overview.error ? (
        <div className="rounded-xl border border-darc-red/40 bg-darc-red/5 p-4 text-sm text-darc-red">
          Erro ao carregar a visão consolidada. Tente recarregar.
        </div>
      ) : loading || !overview.data ? (
        <KpiSkeleton />
      ) : (
        <KpiCards data={overview.data} />
      )}

      {byProject.data && <ProjectsBreakdown rows={byProject.data} />}

      {cashFlow.data && byProject.data && (
        <CashFlowCharts cashFlow={cashFlow.data} byProject={byProject.data} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        {categories.data && <CategoryDonut rows={categories.data} />}
        {suppliers.data && <TopSuppliers rows={suppliers.data} />}
      </div>

      {upcoming.data && <UpcomingTable rows={upcoming.data} />}
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-[100px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen animate-pulse" />
      ))}
    </div>
  );
}
