'use client';
import React from 'react';
import { ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
import { formatCurrency, parseISODateLocal } from '@/lib/utils';
import type { CashFlowEntry } from '@/types';

interface Props {
  entries: CashFlowEntry[];
}

function MobileCashFlowListImpl({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <div className="md:hidden text-center text-darc-velvet/50 text-sm py-8 rounded-2xl bg-white shadow-darc-soft border border-darc-linen">
        Nenhuma entrada no fluxo de caixa.
      </div>
    );
  }

  // Agrupa por mês (YYYY-MM) preservando ordem
  const groups = new Map<string, { label: string; items: CashFlowEntry[] }>();
  for (const e of entries) {
    if (!e.data) continue;
    const d = new Date(e.data);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const bucket = groups.get(key) ?? { label, items: [] };
    bucket.items.push(e);
    groups.set(key, bucket);
  }

  return (
    <div className="md:hidden space-y-4">
      {[...groups.entries()].map(([key, { label, items }]) => {
        const monthBalance = items[items.length - 1]?.rollingBalance ?? 0;
        return (
          <div key={key} className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-darc-pink-logo/40">
              <span className="font-semibold uppercase tracking-[0.15em] text-[11px] text-darc-velvet capitalize">
                {label}
              </span>
              <span
                className={`text-sm font-bold tabular-nums ${
                  monthBalance >= 0 ? 'text-darc-velvet' : 'text-darc-red'
                }`}
              >
                {formatCurrency(monthBalance / 100)}
              </span>
            </div>

            <div className="divide-y divide-darc-linen">
              {items.map((entry) => {
                const isReceita = entry.tipo === 'RECEBIMENTO';
                return (
                  <div key={entry.id} className="px-4 py-3 active:bg-darc-linen/40 transition-colors">
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 pt-0.5">
                        {isReceita ? (
                          <ArrowUpCircle className="w-5 h-5 text-darc-raspberry" />
                        ) : (
                          <ArrowDownCircle className="w-5 h-5 text-darc-red" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-darc-velvet leading-snug truncate">
                          {entry.categoria ?? (isReceita ? 'Recebimento' : 'Despesa')}
                          {entry.subcategoria ? ` · ${entry.subcategoria}` : ''}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-darc-velvet/60 tabular-nums">
                          <span>
                            {entry.data
                              ? parseISODateLocal(entry.data)?.toLocaleDateString('pt-BR', {
                                  day: '2-digit',
                                  month: 'short',
                                }) ?? '—'
                              : '—'}
                          </span>
                          {entry.parcela && <span>· {entry.parcela}</span>}
                          {entry.ambiente && <span className="truncate">· {entry.ambiente}</span>}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p
                          className={`text-sm font-bold tabular-nums ${
                            isReceita ? 'text-darc-raspberry' : 'text-darc-red'
                          }`}
                        >
                          {isReceita ? '+' : '−'} {formatCurrency(entry.valor / 100)}
                        </p>
                        <p className="text-[10px] text-darc-velvet/50 tabular-nums mt-0.5">
                          fluxo {formatCurrency(entry.rollingBalance / 100)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const MobileCashFlowList = React.memo(MobileCashFlowListImpl);
