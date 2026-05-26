'use client';
import { useProject } from '@/contexts/project-context';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
import type { CashFlowEntry } from '@/types';
import { MobileCashFlowList } from './_components/MobileCashFlowList';

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

  if (isLoading) return <div className="text-gray-500">Carregando...</div>;
  if (error) return <div className="text-red-600">Erro ao carregar fluxo de caixa.</div>;

  const saldoAtual = entries[entries.length - 1]?.rollingBalance ?? 0;
  const saldoRealizado = entries[entries.length - 1]?.rollingBalanceRealizado ?? 0;
  const totalReceitas = entries
    .filter((e) => e.tipo === 'RECEBIMENTO')
    .reduce((s, e) => s + e.valor, 0);
  const totalDespesas = entries
    .filter((e) => e.tipo === 'DESPESA')
    .reduce((s, e) => s + e.valor, 0);

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

      {/* KPIs mobile */}
      <div className="md:hidden -mx-4 px-4 overflow-x-auto scrollbar-hide">
        <div className="flex gap-3 min-w-min pb-2">
          <div
            className={`min-w-[160px] rounded-2xl shadow-darc-soft border px-4 py-3 ${
              saldoAtual >= 0
                ? 'bg-darc-mist/30 border-darc-mist/50'
                : 'bg-darc-red-pastel/15 border-darc-red-pastel/40'
            }`}
          >
            <p className="text-[10px] uppercase tracking-wider text-darc-velvet/70">Saldo projetado</p>
            <p
              className={`font-bold tabular-nums mt-1 ${
                saldoAtual >= 0 ? 'text-darc-velvet' : 'text-darc-red'
              }`}
            >
              {formatCurrency(saldoAtual / 100)}
            </p>
          </div>
          <div
            className={`min-w-[160px] rounded-2xl shadow-darc-soft border px-4 py-3 ${
              saldoRealizado >= 0
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-darc-red-pastel/15 border-darc-red-pastel/40'
            }`}
          >
            <p className="text-[10px] uppercase tracking-wider text-emerald-700/80">Saldo realizado</p>
            <p
              className={`font-bold tabular-nums mt-1 ${
                saldoRealizado >= 0 ? 'text-emerald-700' : 'text-darc-red'
              }`}
            >
              {formatCurrency(saldoRealizado / 100)}
            </p>
          </div>
          <div className="min-w-[140px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-darc-raspberry/80">Receitas</p>
            <p className="font-bold text-darc-raspberry tabular-nums mt-1">
              {formatCurrency(totalReceitas / 100)}
            </p>
          </div>
          <div className="min-w-[140px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-darc-red/80">Despesas</p>
            <p className="font-bold text-darc-red tabular-nums mt-1">
              {formatCurrency(totalDespesas / 100)}
            </p>
          </div>
        </div>
      </div>

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
            {entries.length === 0 && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-gray-400">Nenhuma entrada no fluxo de caixa.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
