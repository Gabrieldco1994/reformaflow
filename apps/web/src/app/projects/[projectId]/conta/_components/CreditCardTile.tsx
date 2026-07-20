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
  onAdjustInvoice,
  onSettleWithResidual,
}: {
  card: AccountViewCardSummary;
  active: boolean;
  onSelect: (last4: string | null) => void;
  onPayInvoice: (cardLast4: string) => void;
  onAdjustInvoice: (cardLast4: string) => void;
  onSettleWithResidual: (cardLast4: string) => void;
}) {
  const paga = card.status === 'paga';
  const parcial = card.status === 'parcial';
  const badgeText = paga ? '\u2713 Paga' : parcial ? 'Parcial' : 'A pagar';
  const badgeClass = paga
    ? 'bg-white/90 text-[#1E924A]'
    : parcial
      ? 'bg-[#FBEBDC] text-[#B5803A]'
      : 'bg-white/15 text-white';

  return (
    <CreditCardVisual
      last4={card.last4}
      nickname={card.nickname}
      active={active}
      onClick={() => onSelect(active ? null : card.last4)}
      className="min-h-[146px] p-2.5 md:min-h-[176px] md:p-4"
      topRight={
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur md:px-2 md:text-[11px] ${badgeClass}`}
        >
          {badgeText}
        </span>
      }
      footer={
        <div className="flex items-end justify-between gap-1.5">
          <div className="min-w-0">
            <p className="text-[9px] uppercase tracking-wide text-white/60 md:text-[11px]">Fatura atual</p>
            <p className="font-geist text-[16px] font-bold tabular-nums leading-tight md:text-[19px]">
              {formatCurrency(card.faturaAtual / 100)}
            </p>
            {parcial && (
              <p className="mt-0.5 hidden text-[10px] text-white/75 md:block md:text-[11px]">
                {formatCurrency(card.faturaPaga / 100)} de {formatCurrency(card.faturaAtual / 100)}
              </p>
            )}
          </div>
          <p className="shrink-0 text-[9px] text-white/70 md:text-[11px]">vence {formatDateBR(card.vencimento)}</p>
        </div>
      }
      limit={{ pct: card.limiteUsadoPct, used: card.limiteUsado, total: card.limiteTotal }}
      action={
        card.faturaAtual > 0 ? (
          <div className="mt-0.5 grid grid-cols-1 gap-0.5">
            {!paga && (
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onPayInvoice(card.last4);
                }}
                className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-lg bg-white text-[11px] font-semibold text-lifeone-ink transition hover:bg-white/90 md:h-8 md:text-[12px]"
              >
                Pagar fatura
              </button>
            )}
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                onAdjustInvoice(card.last4);
              }}
              className="inline-flex h-6 w-full items-center justify-center rounded-lg border border-white/35 bg-transparent text-[10px] font-semibold text-white transition hover:bg-white/10 md:h-7 md:text-[11px]"
            >
              Ajustar fatura…
            </button>
            {card.faturaPendente > 0 && (
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSettleWithResidual(card.last4);
                }}
                className="inline-flex h-6 w-full items-center justify-center rounded-lg border border-white/35 bg-transparent text-[10px] font-semibold text-white transition hover:bg-white/10 md:h-7 md:text-[11px]"
              >
                Marcar quitada com resíduo…
              </button>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
