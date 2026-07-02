'use client';

import { formatCurrency, formatDateBR } from '@/lib/utils';
import { CreditCardVisual } from '@/components/CreditCardVisual';
import type { AccountViewCardSummary } from '../_types';

/**
 * Cartão da Visão Conta: casca visual realista (CreditCardVisual) + dados de
 * fatura (fatura atual, vencimento, status, limite) e ação "Pagar fatura".
 */
export function CreditCardTile({
  card,
  active,
  onSelect,
  onPayInvoice,
}: {
  card: AccountViewCardSummary;
  active: boolean;
  onSelect: (last4: string | null) => void;
  onPayInvoice: (cardLast4: string) => void;
}) {
  const paga = card.status === 'paga';

  return (
    <CreditCardVisual
      last4={card.last4}
      nickname={card.nickname}
      active={active}
      onClick={() => onSelect(active ? null : card.last4)}
      topRight={
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur ${
            paga ? 'bg-white/90 text-[#1E924A]' : 'bg-white/15 text-white'
          }`}
        >
          {paga ? '\u2713 Paga' : 'A pagar'}
        </span>
      }
      footer={
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-white/60">Fatura atual</p>
            <p className="font-geist text-[19px] font-bold tabular-nums leading-tight">
              {formatCurrency(card.faturaAtual / 100)}
            </p>
          </div>
          <p className="shrink-0 text-[11px] text-white/70">vence {formatDateBR(card.vencimento)}</p>
        </div>
      }
      limit={{ pct: card.limiteUsadoPct, used: card.limiteUsado, total: card.limiteTotal }}
      action={
        !paga && card.faturaAtual > 0 ? (
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              onPayInvoice(card.last4);
            }}
            className="mt-1 inline-flex h-8 w-full items-center justify-center gap-1 rounded-lg bg-white text-[12px] font-semibold text-lifeone-ink transition hover:bg-white/90"
          >
            Pagar fatura
          </button>
        ) : undefined
      }
    />
  );
}
