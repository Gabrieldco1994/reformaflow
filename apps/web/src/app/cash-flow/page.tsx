'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
import type { CashFlowEntry } from '@/types';

const PROJECT_ID = 'dev-project-1';

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
  const { data: entries = [], isLoading, error } = useQuery<CashFlowEntry[]>({
    queryKey: ['cash-flow'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/cash-flow`),
  });

  if (isLoading) return <div className="text-gray-500">Carregando...</div>;
  if (error) return <div className="text-red-600">Erro ao carregar fluxo de caixa.</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Fluxo de Caixa</h1>

      <div className="overflow-x-auto border rounded-lg">
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
              <th className="text-right px-4 py-2 font-medium text-gray-600">Saldo Acumulado</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {entries.map((entry) => (
              <tr key={entry.id} className="hover:bg-gray-50">
                <td className="px-4 py-2">{entry.data ? new Date(entry.data).toLocaleDateString('pt-BR') : '-'}</td>
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
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-gray-400">Nenhuma entrada no fluxo de caixa.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
