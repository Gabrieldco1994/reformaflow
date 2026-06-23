'use client';

import { CreditCard, Landmark } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { AccountViewCardSummary, AccountViewConta } from '../_types';

export function CartoesSection({
  cartoes,
  contas,
  selected,
  onSelect,
  onPayInvoice,
}: {
  cartoes: AccountViewCardSummary[];
  contas: AccountViewConta[];
  selected: string | null;
  onSelect: (last4: string | null) => void;
  onPayInvoice: (cardLast4: string) => void;
}) {
  if (cartoes.length === 0 && contas.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Cartões e contas
        </p>
        {selected && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-[11px] font-semibold text-orange-600 hover:text-orange-700"
          >
            Limpar filtro
          </button>
        )}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {cartoes.map((card) => {
          const active = selected === card.last4;
          return (
            <article
              key={`card-${card.last4}`}
              onClick={() => onSelect(active ? null : card.last4)}
              className={`cursor-pointer rounded-2xl border bg-white p-3 shadow-sm transition-colors ${
                active
                  ? 'border-orange-500 ring-1 ring-orange-500'
                  : 'border-slate-200 hover:border-orange-300'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-700">
                    <CreditCard className="h-4 w-4" />
                  </span>
                  <p className="truncate text-sm font-semibold text-slate-950">
                    {card.nickname} · {card.last4}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    card.status === 'paga'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {card.status}
                </span>
              </div>

              <div className="mt-2.5 flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] text-slate-500">Fatura atual</p>
                  <p className="text-lg font-bold text-slate-950">
                    {formatCurrency(card.faturaAtual / 100)}
                  </p>
                </div>
                <p className="shrink-0 text-[11px] text-slate-500">vence {formatDateBR(card.vencimento)}</p>
              </div>

              {card.limiteUsadoPct != null && card.limiteUsado != null && card.limiteTotal != null && (
                <div className="mt-2.5">
                  <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-slate-600">
                    <span>{card.limiteUsadoPct}% usado</span>
                    <span className="font-medium">
                      {formatCurrency(card.limiteUsado / 100)} de {formatCurrency(card.limiteTotal / 100)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-slate-700"
                      style={{ width: `${Math.min(Math.max(card.limiteUsadoPct, 0), 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {card.status === 'a pagar' && card.faturaAtual > 0 && (
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onPayInvoice(card.last4);
                  }}
                  className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1 rounded-lg bg-emerald-600 text-[12px] font-semibold text-white transition hover:bg-emerald-700"
                >
                  Pagar fatura
                </button>
              )}
            </article>
          );
        })}

        {contas.map((conta) => {
          const active = selected === conta.last4;
          return (
            <article
              key={`bank-${conta.last4}`}
              onClick={() => onSelect(active ? null : conta.last4)}
              className={`flex cursor-pointer items-center gap-2 rounded-2xl border bg-white p-3 shadow-sm transition-colors ${
                active
                  ? 'border-orange-500 ring-1 ring-orange-500'
                  : 'border-slate-200 hover:border-orange-300'
              }`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-700">
                <Landmark className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-950">
                  {conta.nome} · {conta.last4}
                </p>
                <p className="text-[10px] text-slate-500">conta corrente</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
