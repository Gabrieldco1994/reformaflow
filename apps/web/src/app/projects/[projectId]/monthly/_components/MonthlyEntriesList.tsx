'use client';

import { ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { formatCurrency, parseISODateLocal } from '@/lib/utils';
import { ORIGIN_COLORS, ORIGIN_ICONS, type MonthlyEntry } from '../_types';

interface Props {
  entries: MonthlyEntry[];
}

const STATUS_COLORS: Record<string, string> = {
  PAGO: 'bg-emerald-100 text-emerald-800',
  EM_CAIXA: 'bg-emerald-100 text-emerald-800',
  PLANEJADO: 'bg-yellow-100 text-yellow-800',
  PREVISTO: 'bg-yellow-100 text-yellow-800',
};

export default function MonthlyEntriesList({ entries }: Props) {
  const sorted = [...entries].sort((a, b) => (a.data < b.data ? -1 : 1));
  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen overflow-hidden">
      <div className="px-4 py-3 border-b border-darc-linen">
        <h3 className="text-sm font-semibold text-darc-velvet">
          Lançamentos do mês ({entries.length})
        </h3>
        <p className="text-[11px] text-darc-velvet/60 mt-0.5">
          Inclui lançamentos de todos os projetos do tenant
        </p>
      </div>

      {sorted.length === 0 ? (
        <p className="p-6 text-center text-xs text-darc-velvet/60">
          Nenhum lançamento neste mês ainda.
        </p>
      ) : (
        <ul className="divide-y divide-darc-linen max-h-[480px] overflow-y-auto">
          {sorted.map((e) => {
            const isReceita = e.tipo === 'RECEBIMENTO';
            const originColor = ORIGIN_COLORS[e.projectType] ?? '#999';
            return (
              <li key={e.id} className="px-4 py-3 hover:bg-darc-linen/40 transition-colors">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 pt-0.5">
                    {isReceita ? (
                      <ArrowUpCircle className="w-5 h-5 text-emerald-600" />
                    ) : (
                      <ArrowDownCircle className="w-5 h-5 text-darc-red" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm text-darc-velvet leading-snug truncate">
                        {e.categoria ?? (isReceita ? 'Recebimento' : 'Despesa')}
                        {e.subcategoria ? ` · ${e.subcategoria}` : ''}
                      </p>
                      <span
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white"
                        style={{ backgroundColor: originColor }}
                        title={e.projectName}
                      >
                        {ORIGIN_ICONS[e.projectType] ?? ''} {e.projectType}
                      </span>
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                          STATUS_COLORS[e.status] ?? 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {e.status}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-darc-velvet/60 tabular-nums">
                      <span>
                        {parseISODateLocal(e.data)?.toLocaleDateString('pt-BR', {
                          day: '2-digit', month: 'short',
                        }) ?? '—'}
                      </span>
                      {e.formaPagamento && <span>· {e.formaPagamento}</span>}
                      <span className="text-darc-velvet/50 truncate">· {e.projectName}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p
                      className={`text-sm font-bold tabular-nums ${
                        isReceita ? 'text-emerald-700' : 'text-darc-red'
                      }`}
                    >
                      {isReceita ? '+' : '−'} {formatCurrency(e.valor / 100)}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
