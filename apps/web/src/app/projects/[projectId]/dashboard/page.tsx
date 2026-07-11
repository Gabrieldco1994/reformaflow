'use client';

import { useProject } from '@/contexts/project-context';
import { useAuth } from '@/contexts/auth-context';
import { useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { getProjectAccentColor } from '@/lib/project-colors';
import type { DashboardResponse } from '@/types';
import ManagementDashboard from './_components/ManagementDashboard';

const DashboardCharts = dynamic(
  () => import('./_components/DashboardCharts'),
  {
    ssr: false,
    loading: () => (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 h-[340px] animate-pulse" />
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 h-[340px] animate-pulse" />
      </div>
    ),
  },
);

function formatMesLabel(mes: string) {
  const [y, m] = mes.split('-');
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${meses[parseInt(m) - 1]}/${y.slice(2)}`;
}

// ─── Skeleton para reservar layout (evita CLS) ──────────────

function FinancialDashboardSkeleton() {
  return (
    <div className="space-y-6 md:space-y-8 animate-pulse">
      {/* KPIs mobile */}
      <div className="md:hidden -mx-4 px-4 overflow-x-hidden">
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-[78%] h-[88px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
          <div className="flex-shrink-0 w-[78%] h-[88px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        </div>
      </div>
      {/* KPIs desktop (6 cards) */}
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[96px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        ))}
      </div>
      {/* Charts (2x 340px) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        <div className="h-[340px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        <div className="h-[340px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
      </div>
      {/* Resumo section */}
      <div className="h-[200px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
    </div>
  );
}

// ─── Financial Dashboard (REFORMA / COMPRA) ──────────────────

function FinancialDashboard({ projectId, projectType }: { projectId: string; projectType: string }) {
  const { data, isLoading, error } = useQuery<DashboardResponse>({
    queryKey: ['dashboard', projectId],
    queryFn: () => api.get(`/projects/${projectId}/dashboard`),
  });

  const despesasChartData = useMemo(() =>
    (data?.despesasMensal ?? []).map((d) => ({ ...d, mesLabel: formatMesLabel(d.mes) })),
    [data?.despesasMensal]
  );

  const saldoChartData = useMemo(() =>
    (data?.saldoAcumuladoMensal ?? []).map((d) => ({ ...d, mesLabel: formatMesLabel(d.mes) })),
    [data?.saldoAcumuladoMensal]
  );

  if (isLoading) return <FinancialDashboardSkeleton />;
  if (error) return <div className="text-darc-red">Erro ao carregar dashboard.</div>;
  if (!data) return null;

  const accentColor = getProjectAccentColor(projectType);

  const kpis: { label: string; value: number; accent: string }[] = [
    { label: 'Dinheiro Disponível', value: data.kpis.dinheiroDisponivel, accent: accentColor },
    { label: 'Já Paguei', value: data.kpis.jaPaguei, accent: accentColor },
    { label: 'Previsão de Gastos', value: data.kpis.previsaoGastos, accent: accentColor },
    { label: 'Previsão de Recebimentos', value: data.kpis.previsaoRecebimentos, accent: accentColor },
    { label: 'Previsão de Saldo', value: data.kpis.previsaoSaldo, accent: accentColor },
    { label: 'Saldo', value: data.kpis.saldo, accent: accentColor },
  ];

  const showRooms = projectType === 'REFORMA';

  return (
    <div className="space-y-6 md:space-y-8">
      {projectType === 'PESSOAL' && (
        <Link
          href={`/projects/${projectId}/monthly`}
          className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-gradient-to-br from-indigo-50 to-rose-50 border border-indigo-100 hover:border-indigo-300 transition-colors group"
        >
          <div className="flex items-center gap-3">
            <CalendarClock className="w-5 h-5 text-indigo-700 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-darc-velvet">Visão Mensal Consolidada</p>
              <p className="text-[11px] text-darc-velvet/70 leading-snug">
                Gasto, recebido e saldo do mês — agrega Reforma, Casa e Carro
              </p>
            </div>
          </div>
          <span className="text-xs text-indigo-700 group-hover:translate-x-0.5 transition-transform">
            Ver →
          </span>
        </Link>
      )}

      {/* KPIs — scroll horizontal premium no mobile, grid no desktop */}
      <div className="md:hidden -mx-4 px-4 overflow-x-auto scrollbar-hide">
        <div className="flex gap-3 snap-x snap-mandatory">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="snap-start flex-shrink-0 w-[78%] rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 relative overflow-hidden"
            >
              <span className={`absolute left-0 top-4 bottom-4 w-1 rounded-r-full ${kpi.accent}`} />
              <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 pl-3">{kpi.label}</p>
              <p className="text-2xl font-bold text-darc-velvet mt-2 pl-3">{formatCurrency(kpi.value / 100)}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5 relative overflow-hidden"
          >
            <span className={`absolute left-0 top-5 bottom-5 w-1 rounded-r-full ${kpi.accent}`} />
            <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 pl-3">{kpi.label}</p>
            <p className="text-xl lg:text-2xl font-bold text-darc-velvet mt-2 pl-3">{formatCurrency(kpi.value / 100)}</p>
          </div>
        ))}
      </div>

      <DashboardCharts
        despesasChartData={despesasChartData}
        saldoChartData={saldoChartData}
      />

      {showRooms && data.resumoPorAmbiente && data.resumoPorAmbiente.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">Resumo por Ambiente</h2>
          {/* Desktop: tabela */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-darc-linen">
                  <th className="text-left px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">Ambiente</th>
                  <th className="text-right px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">Planejado</th>
                  <th className="text-right px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">Pago</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-darc-linen">
                {data.resumoPorAmbiente.map((room) => (
                  <tr key={room.roomName} className="hover:bg-darc-linen/40">
                    <td className="px-3 py-3 text-darc-velvet">{room.roomName}</td>
                    <td className="px-3 py-3 text-right text-darc-velvet">{formatCurrency(room.planned / 100)}</td>
                    <td className="px-3 py-3 text-right font-semibold text-darc-raspberry">{formatCurrency(room.actual / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile: lista */}
          <div className="md:hidden space-y-2">
            {data.resumoPorAmbiente.map((room) => (
              <div key={room.roomName} className="flex items-center justify-between py-2 border-b border-darc-linen last:border-0">
                <span className="text-sm font-medium text-darc-velvet">{room.roomName}</span>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-[0.15em] text-darc-velvet/50">{formatCurrency(room.planned / 100)} planejado</p>
                  <p className="text-sm font-bold text-darc-raspberry">{formatCurrency(room.actual / 100)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.resumoPorTipoDespesa && data.resumoPorTipoDespesa.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">Resumo por Tipo de Despesa</h2>
          <div className="divide-y divide-darc-linen">
            {data.resumoPorTipoDespesa.map((item) => (
              <div key={item.label} className="flex items-center justify-between py-2.5">
                <span className="text-sm text-darc-velvet">{item.label}</span>
                <span className="text-sm font-semibold text-darc-velvet">{formatCurrency(item.total / 100)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.resumoPorCategoria && data.resumoPorCategoria.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">Resumo por Categoria</h2>
          <div className="divide-y divide-darc-linen">
            {data.resumoPorCategoria.map((item) => (
              <div key={item.label} className="flex items-center justify-between py-2.5">
                <span className="text-sm text-darc-velvet">{item.label}</span>
                <span className="text-sm font-semibold text-darc-velvet">{formatCurrency(item.total / 100)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { projectId, projectType, projectName } = useProject();
  const { hasModule } = useAuth();

  // PESSOAL usa o Cockpit (rota /monthly) como visão principal — redireciona.
  useEffect(() => {
    if (projectType === 'PESSOAL') {
      router.replace(`/projects/${projectId}/monthly`);
    }
  }, [projectType, projectId, router]);

  if (projectType === 'PESSOAL') return null;

  const isFinancial = projectType === 'REFORMA' || projectType === 'COMPRA';
  const isManagement = projectType === 'CASA' || projectType === 'CARRO';

  return (
    <div className="space-y-6 md:space-y-8">
      {hasModule('financialDashboard') && (
      <Link
        href="/financeiro"
        className="hidden md:inline-flex items-center gap-1.5 text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 hover:text-darc-red transition-colors"
      >
        ← Visão Geral
      </Link>
      )}
      <header className="hidden md:block -mt-4">
        <p className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60">Visão geral do projeto</p>
        <h1 className="font-editorial italic text-3xl text-darc-velvet">{projectName}</h1>
      </header>
      <header className="md:hidden -mt-2">
        {hasModule('financialDashboard') && (
        <Link
          href="/financeiro"
          className="text-[10px] tracking-[0.18em] uppercase text-darc-velvet/60 hover:text-darc-red"
        >
          ← Visão Geral
        </Link>
        )}
        <h1 className="font-editorial italic text-2xl text-darc-velvet leading-tight mt-1">{projectName}</h1>
      </header>
      {isFinancial && <FinancialDashboard projectId={projectId} projectType={projectType} />}
      {isManagement && <ManagementDashboard projectId={projectId} projectType={projectType} />}
    </div>
  );
}
