'use client';

import { CreditCard, Landmark } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { CardInvoicesYearlyOrigin, OriginItemsYearlyResponse } from '../_types';

const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function monthLabel(mes: string) {
  const month = parseInt(mes.slice(5, 7), 10);
  return MONTH_LABELS[month - 1] ?? mes;
}

export function DespesasRelacionadas({
  origin,
  data,
  isLoading,
}: {
  origin: CardInvoicesYearlyOrigin;
  data: OriginItemsYearlyResponse | undefined;
  isLoading: boolean;
}) {
  const Icon = origin.kind === 'conta' ? Landmark : CreditCard;

  // Agrupa itens por mês (vencimento/débito), em ordem cronológica desc.
  const byMonth = new Map<string, OriginItemsYearlyResponse['items']>();
  for (const item of data?.items ?? []) {
    const list = byMonth.get(item.mes) ?? [];
    list.push(item);
    byMonth.set(item.mes, list);
  }
  const months = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
            <Icon className="h-4 w-4" />
          </span>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Despesas · {origin.nickname} · {origin.last4}
            </p>
            <p className="text-sm text-slate-500">
              {origin.kind === 'conta' ? 'Débitos da conta' : 'Lançamentos da fatura'} em {data?.year ?? ''}
            </p>
          </div>
        </div>
        {data && (
          <p className="shrink-0 text-base font-bold text-slate-950">{formatCurrency(data.total / 100)}</p>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-10 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      )}

      {!isLoading && months.length === 0 && (
        <div className="flex h-24 items-center justify-center rounded-xl bg-slate-50 text-sm text-slate-500">
          Sem despesas registradas nesta origem.
        </div>
      )}

      {!isLoading && months.length > 0 && (
        <div className="space-y-3">
          {months.map((mes) => {
            const items = byMonth.get(mes)!;
            const subtotal = items.reduce((sum, item) => sum + item.valor, 0);
            return (
              <div key={mes} className="overflow-hidden rounded-xl border border-slate-100">
                <div className="flex items-center justify-between bg-slate-50 px-3 py-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-600">
                    {monthLabel(mes)} · {mes.slice(0, 4)}
                  </span>
                  <span className="text-xs font-semibold text-slate-700">{formatCurrency(subtotal / 100)}</span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {items.map((item, index) => (
                    <li key={`${mes}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-800">{item.descricao}</p>
                        <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                          {formatDateBR(item.data)}
                          {item.status !== 'PAGO' && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-px font-medium text-amber-700">
                              {item.status === 'PLANEJADO' ? 'planejado' : item.status.toLowerCase()}
                            </span>
                          )}
                          {item.projetoOrigem && item.projetoOrigem.type !== 'PESSOAL' && (
                            <span className="rounded-full bg-sky-100 px-1.5 py-px font-medium text-sky-700">
                              {item.projetoOrigem.name}
                            </span>
                          )}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 text-sm font-semibold tabular-nums ${
                          item.valor < 0 ? 'text-emerald-600' : 'text-slate-900'
                        }`}
                      >
                        {formatCurrency(item.valor / 100)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
