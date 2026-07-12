'use client';
import { useProject } from '@/contexts/project-context';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonCard, SkeletonList } from '@/components/ui/Skeleton';
import type { CashFlowEntry } from '@/types';
import { MobileCashFlowList } from './_components/MobileCashFlowList';
import { CashFlowKpiHeader } from './_components/CashFlowKpiHeader';

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    PAGO: 'bg-green-100 text-green-800',
    PLANEJADO: 'bg-amber-100 text-amber-800',
    PREVISTO: 'bg-blue-100 text-blue-800',
    EM_CAIXA: 'bg-emerald-100 text-emerald-800',
  };
  const style = map[status] ?? 'bg-gray-100 text-gray-800';
  return <span className={`${style} px-2 py-0.5 rounded-full text-xs font-medium`}>{status}</span>;
}

export default function CashFlowPage() {
  const { projectId: PROJECT_ID } = useProject();
  const { data: entries = [], isLoading, error } = useQuery<CashFlowEntry[]>({
    queryKey: ['cash-flow', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/cash-flow`),
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonCard className="h-16 md:w-64" />
        <div className="grid gap-3 md:grid-cols-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonList rows={5} />
      </div>
    );
  }
  if (error) return <div className="text-red-600">Erro ao carregar fluxo de caixa.</div>;

  return (
    <div className="space-y-6">
      {/* Header desktop */}
      <h1 className="hidden md:block text-2xl font-bold text-gray-900">Fluxo de Caixa</h1>

      {/* Header mobile editorial */}
      <div className="md:hidden -mt-2">
        <p className="text-[11px] uppercase tracking-[0.2em] text-darc-raspberry/70">Financeiro</p>
        <h1 className="font-editorial italic text-3xl text-darc-velvet leading-tight">
          Fluxo de Caixa
        </h1>
      </div>

      {/* Topo: KPIs canônicos (saldo projetado, saldo realizado, entradas, saídas) */}
      <CashFlowKpiHeader entries={entries} />

      {entries.length === 0 ? (
        <EmptyState
          icon={ArrowUpCircle}
          title="Sem lançamentos no período"
          description="Recebimentos e despesas aparecerão aqui quando forem cadastrados."
        />
      ) : (
        <>
          {/* Lista mobile */}
          <MobileCashFlowList entries={entries} />

          {/* Tabela desktop */}
          <div className="hidden md:block overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Data</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Tipo</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600">Valor</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Categoria</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Subcategoria</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Ambiente</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Forma Pagto</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Parcela</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-600">Status</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600" title="Inclui planejados e previstos">Saldo Projetado</th>
                  <th className="text-right px-4 py-2 font-medium text-gray-600" title="Apenas PAGO e EM_CAIXA">Saldo Realizado</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2">{entry.data ? formatDateBR(entry.data) : '-'}</td>
                    <td className="px-4 py-2">
                      {entry.tipo === 'RECEBIMENTO' ? (
                        <span className="inline-flex items-center gap-1 text-green-700">
                          <ArrowUpCircle className="w-4 h-4" /> Recebimento
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-700">
                          <ArrowDownCircle className="w-4 h-4" /> Despesa
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-medium">{formatCurrency(entry.valor / 100)}</td>
                    <td className="px-4 py-2">{entry.categoria ?? '-'}</td>
                    <td className="px-4 py-2">{entry.subcategoria ?? '-'}</td>
                    <td className="px-4 py-2">{entry.ambiente ?? '-'}</td>
                    <td className="px-4 py-2">{entry.formaPagamento ?? '-'}</td>
                    <td className="px-4 py-2">{entry.parcela ?? '-'}</td>
                    <td className="px-4 py-2"><StatusBadge status={entry.status} /></td>
                    <td className="px-4 py-2 text-right font-semibold">{formatCurrency(entry.rollingBalance / 100)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-emerald-700">{formatCurrency(entry.rollingBalanceRealizado / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
