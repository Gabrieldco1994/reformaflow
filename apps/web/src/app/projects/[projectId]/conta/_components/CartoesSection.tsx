'use client';

import { CreditCard } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { AccountViewCardSummary } from '../_types';

export function CartoesSection({
  cartoes,
  onPayInvoice,
}: {
  cartoes: AccountViewCardSummary[];
  onPayInvoice: (cardLast4: string) => void;
}) {
  if (cartoes.length === 0) return null;

  return (
    <section className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        Cartões
      </p>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {cartoes.map((card) => (
          <article
            key={card.last4}
            className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
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
                onClick={() => onPayInvoice(card.last4)}
                className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1 rounded-lg bg-emerald-600 text-[12px] font-semibold text-white transition hover:bg-emerald-700"
              >
                Pagar fatura
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
