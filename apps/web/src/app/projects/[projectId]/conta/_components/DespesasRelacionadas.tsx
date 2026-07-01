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
  selectedMonth,
}: {
  origin: CardInvoicesYearlyOrigin;
  data: OriginItemsYearlyResponse | undefined;
  isLoading: boolean;
  selectedMonth: string | null;
}) {
  const Icon = origin.kind === 'conta' ? Landmark : CreditCard;

  // Agrupa itens por mês (vencimento/débito), em ordem cronológica desc.
  // Se um mês está selecionado (clique na barra), filtra só ele.
  const byMonth = new Map<string, OriginItemsYearlyResponse['items']>();
  for (const item of data?.items ?? []) {
    if (selectedMonth && item.mes !== selectedMonth) continue;
    const list = byMonth.get(item.mes) ?? [];
    list.push(item);
    byMonth.set(item.mes, list);
  }
  const months = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));

  const filteredTotal = months.reduce(
    (sum, mes) => sum + byMonth.get(mes)!.reduce((s, item) => s + item.valor, 0),
    0,
  );

  return (
    <section className="space-y-3 rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-lifeone-surface text-lifeone-ink-2">
            <Icon className="h-4 w-4" />
          </span>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
              Despesas · {origin.nickname} · {origin.last4}
            </p>
            <p className="text-sm text-lifeone-ink-3">
              {origin.kind === 'conta' ? 'Débitos da conta' : 'Lançamentos da fatura'}
              {selectedMonth
                ? ` · ${MONTH_LABELS[parseInt(selectedMonth.slice(5, 7), 10) - 1]} ${selectedMonth.slice(0, 4)}`
                : ` em ${data?.year ?? ''}`}
            </p>
          </div>
        </div>
        {data && (
          <p className="shrink-0 text-base font-bold text-lifeone-ink font-geist tabular-nums">
            {formatCurrency((selectedMonth ? filteredTotal : data.total) / 100)}
          </p>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-10 animate-pulse rounded-lg bg-lifeone-surface" />
          ))}
        </div>
      )}

      {!isLoading && months.length === 0 && (
        <div className="flex h-24 items-center justify-center rounded-xl bg-lifeone-surface text-sm text-lifeone-ink-3">
          {selectedMonth
            ? 'Sem despesas neste mês para esta origem.'
            : 'Sem despesas registradas nesta origem.'}
        </div>
      )}

      {!isLoading && months.length > 0 && (
        <div className="space-y-3">
          {months.map((mes) => {
            const items = byMonth.get(mes)!;
            const subtotal = items.reduce((sum, item) => sum + item.valor, 0);
            return (
              <div key={mes} className="overflow-hidden rounded-xl border border-lifeone-hairline-3">
                <div className="flex items-center justify-between bg-lifeone-surface px-3 py-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-lifeone-ink-2">
                    {monthLabel(mes)} · {mes.slice(0, 4)}
                  </span>
                  <span className="text-xs font-semibold text-lifeone-ink-2">{formatCurrency(subtotal / 100)}</span>
                </div>
                <ul className="divide-y divide-lifeone-hairline-3">
                  {items.map((item, index) => (
                    <li key={`${mes}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-lifeone-ink">{item.descricao}</p>
                        <p className="flex items-center gap-1.5 text-[11px] text-lifeone-ink-4">
                          {formatDateBR(item.data)}
                          {item.status !== 'PAGO' && (
                            <span className="rounded-full bg-[#FBEBDC] px-1.5 py-px font-medium text-[#B5803A]">
                              {item.status === 'PLANEJADO' ? 'planejado' : item.status.toLowerCase()}
                            </span>
                          )}
                          {item.projetoOrigem && item.projetoOrigem.type !== 'PESSOAL' && (
                            <span className="rounded-full bg-[#E6EFFE] px-1.5 py-px font-medium text-lifeone-blue">
                              {item.projetoOrigem.name}
                            </span>
                          )}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 text-sm font-semibold tabular-nums font-geist ${
                          item.valor < 0 ? 'text-[#1E924A]' : 'text-lifeone-ink'
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
