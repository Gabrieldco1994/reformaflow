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
      topRight={
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur ${badgeClass}`}
        >
          {badgeText}
        </span>
      }
      footer={
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-white/60">Fatura atual</p>
            <p className="font-geist text-[19px] font-bold tabular-nums leading-tight">
              {formatCurrency(card.faturaAtual / 100)}
            </p>
            {parcial && (
              <p className="mt-0.5 text-[10px] text-white/75">
                {formatCurrency(card.faturaPaga / 100)} de {formatCurrency(card.faturaAtual / 100)}
              </p>
            )}
            {card.possuiIntervencaoManual && (
              <p className="mt-0.5 text-[10px] text-white/75">Ajuste manual</p>
            )}
          </div>
          <p className="shrink-0 text-[11px] text-white/70">vence {formatDateBR(card.vencimento)}</p>
        </div>
      }
      limit={{ pct: card.limiteUsadoPct, used: card.limiteUsado, total: card.limiteTotal }}
      action={
        card.faturaAtual > 0 ? (
          <div className="mt-1 grid grid-cols-1 gap-1">
            {!paga && (
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onPayInvoice(card.last4);
                }}
                className="inline-flex h-8 w-full items-center justify-center gap-1 rounded-lg bg-white text-[12px] font-semibold text-lifeone-ink transition hover:bg-white/90"
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
              className="inline-flex h-7 w-full items-center justify-center rounded-lg border border-white/35 bg-transparent text-[11px] font-semibold text-white transition hover:bg-white/10"
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
                className="inline-flex h-7 w-full items-center justify-center rounded-lg border border-white/35 bg-transparent text-[11px] font-semibold text-white transition hover:bg-white/10"
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
