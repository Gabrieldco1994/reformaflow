'use client';

import { Landmark } from 'lucide-react';
import type { AccountViewCardSummary, AccountViewConta } from '../_types';
import { CreditCardTile } from './CreditCardTile';

export function CartoesSection({
  cartoes,
  contas,
  selected,
  onSelect,
  onPayInvoice,
  onAdjustInvoice,
  onSettleWithResidual,
}: {
  cartoes: AccountViewCardSummary[];
  contas: AccountViewConta[];
  selected: string | null;
  onSelect: (last4: string | null) => void;
  onPayInvoice: (cardLast4: string) => void;
  onAdjustInvoice: (cardLast4: string) => void;
  onSettleWithResidual: (cardLast4: string) => void;
}) {
  if (cartoes.length === 0 && contas.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
          Cartões e contas
        </p>
        {selected && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-[11px] font-semibold text-lifeone-blue hover:text-[#0857C4]"
          >
            Limpar filtro
          </button>
        )}
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {cartoes.map((card) => (
          <CreditCardTile
            key={`card-${card.last4}`}
            card={card}
            active={selected === card.last4}
            onSelect={onSelect}
            onPayInvoice={onPayInvoice}
            onAdjustInvoice={onAdjustInvoice}
            onSettleWithResidual={onSettleWithResidual}
          />
        ))}

        {contas.map((conta) => {
          const active = selected === conta.last4;
          return (
            <article
              key={`bank-${conta.last4}`}
              onClick={() => onSelect(active ? null : conta.last4)}
              className={`flex cursor-pointer items-center gap-2 rounded-2xl border bg-lifeone-card p-2.5 shadow-lifeone-card transition-colors ${
                active
                  ? 'border-lifeone-blue ring-1 ring-lifeone-blue'
                  : 'border-lifeone-hairline hover:border-lifeone-blue'
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#E6EFFE] text-lifeone-blue">
                <Landmark className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-lifeone-ink">
                  {conta.nome} · {conta.last4}
                </p>
                <p className="text-[11px] text-lifeone-ink-3">conta corrente</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
