'use client';

import { Landmark } from 'lucide-react';
import Link from 'next/link';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { pickCardGradient } from '@/components/CreditCardVisual';
import type { AccountViewCardSummary, AccountViewConta } from '../_types';
import { CreditCardTile } from './CreditCardTile';

export function CartoesSection({
  projectId,
  cartoes,
  contas,
  selected,
  onSelect,
  onPayInvoice,
  onAdjustInvoice,
  onSettleWithResidual,
}: {
  projectId: string;
  cartoes: AccountViewCardSummary[];
  contas: AccountViewConta[];
  selected: string | null;
  onSelect: (last4: string | null) => void;
  onPayInvoice: (cardLast4: string) => void;
  onAdjustInvoice: (cardLast4: string) => void;
  onSettleWithResidual: (cardLast4: string) => void;
}) {
  if (cartoes.length === 0 && contas.length === 0) return null;

  function handleCompactCardTap(card: AccountViewCardSummary) {
    onSelect(card.last4);
    if (card.status === 'parcial' && card.faturaPendente > 0) {
      onSettleWithResidual(card.last4);
      return;
    }
    if (card.status === 'paga') {
      onAdjustInvoice(card.last4);
      return;
    }
    if (card.faturaAtual > 0) {
      onPayInvoice(card.last4);
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
          Cartões e contas
        </p>
        <div className="flex items-center gap-3">
          <Link
            href={`/projects/${projectId}/credit-cards`}
            className="text-[11px] font-semibold text-lifeone-blue hover:text-[#0857C4]"
          >
            Ver todos
          </Link>
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
      </div>

      <div className="-mx-1.5 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1.5 pb-1 md:hidden">
        {cartoes.map((card) => (
          <button
            key={`card-mobile-${card.last4}`}
            type="button"
            onClick={() => handleCompactCardTap(card)}
            style={{ background: pickCardGradient(card.last4) }}
            className={`flex min-h-[64px] w-[260px] shrink-0 snap-start flex-col justify-center rounded-2xl border px-3 py-2 text-left shadow-lifeone-card transition-colors ${
              selected === card.last4
                ? 'border-white ring-1 ring-white'
                : 'border-transparent'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-[13px] font-semibold text-white">
                {card.nickname} · {card.last4}
              </p>
              <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                {card.status}
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-white/75">
              <span>vence {formatDateBR(card.vencimento)}</span>
              <span className="whitespace-nowrap font-semibold text-white">
                {formatCurrency(card.faturaAtual / 100)}
              </span>
            </div>
          </button>
        ))}

        {contas.map((conta) => {
          const active = selected === conta.last4;
          return (
            <button
              key={`bank-mobile-${conta.last4}`}
              type="button"
              onClick={() => onSelect(active ? null : conta.last4)}
              className={`flex min-h-[64px] w-[220px] shrink-0 snap-start flex-col justify-center rounded-2xl border px-3 py-2 text-left shadow-lifeone-card transition-colors ${
                active
                  ? 'border-lifeone-blue ring-1 ring-lifeone-blue'
                  : 'border-lifeone-hairline hover:border-lifeone-blue'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[13px] font-semibold text-lifeone-ink">
                  {conta.nome}
                </p>
                <span className="shrink-0 rounded-full bg-[#E6EFFE] px-2 py-0.5 text-[11px] font-semibold text-lifeone-blue">
                  conta
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-lifeone-ink-3">
                <p>conta corrente</p>
                <p className="whitespace-nowrap font-semibold text-lifeone-ink">
                  ••{conta.last4}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="hidden gap-1.5 md:grid md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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
