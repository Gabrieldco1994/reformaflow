'use client';

import { CreditCard } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { AccountViewCardSummary } from '../_types';

export function CartoesSection({ cartoes }: { cartoes: AccountViewCardSummary[] }) {
  if (cartoes.length === 0) return null;

  return (
    <section className="space-y-3 xl:space-y-4">
      <div className="xl:flex xl:items-end xl:justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Multi-cartões
        </p>
        <h2 className="mt-1 text-lg font-bold text-slate-950">Faturas e limites do ciclo atual</h2>
        <p className="mt-1 hidden text-sm text-slate-600 xl:block">
          Mesmo card no mobile, mais contexto e comparação lado a lado no desktop.
        </p>
      </div>

      <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        {cartoes.map((card) => (
          <article
            key={card.last4}
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:p-5"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
                <CreditCard className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-950">
                      {card.nickname} · {card.last4}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      vence {formatDateBR(card.vencimento)}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                      card.status === 'paga'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {card.status}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
                  <div>
                    <p className="text-[11px] text-slate-500">Fatura atual</p>
                    <p className="text-lg font-bold text-slate-950 xl:text-2xl">
                      {formatCurrency(card.faturaAtual / 100)}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-slate-50 px-3 py-2 text-right">
                    <p className="text-[11px] text-slate-500">vence</p>
                    <p className="text-sm font-semibold text-slate-900">{formatDateBR(card.vencimento)}</p>
                  </div>
                </div>

                {card.limiteUsadoPct != null && card.limiteUsado != null && card.limiteTotal != null && (
                  <div className="mt-4">
                    <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-slate-600">
                      <span>Limite usado</span>
                      <span className="font-semibold">
                        {card.limiteUsadoPct}% · {formatCurrency(card.limiteUsado / 100)} de{' '}
                        {formatCurrency(card.limiteTotal / 100)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-slate-700"
                        style={{ width: `${Math.min(Math.max(card.limiteUsadoPct, 0), 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
