'use client';

import { X, Undo2, SlidersHorizontal, HandCoins } from 'lucide-react';
import type { AccountViewCardSummary } from '../_types';

/**
 * Seletor de ações do cartão no mobile: o carrossel compacto da Visão Conta
 * não tem espaço pra empilhar botões (ver CreditCardTile, só no grid
 * desktop). Quando a fatura tem mais de uma ação possível (paga/parcial),
 * este sheet resolve a ambiguidade em vez de rotear direto pra uma delas.
 */
export function MobileCardActionsSheet({
  card,
  onClose,
  onAdjustInvoice,
  onUndoPayment,
  onSettleWithResidual,
}: {
  card: AccountViewCardSummary;
  onClose: () => void;
  onAdjustInvoice: (cardLast4: string) => void;
  onUndoPayment: (cardLast4: string) => void;
  onSettleWithResidual: (cardLast4: string) => void;
}) {
  const parcial = card.status === 'parcial';

  const actions = [
    parcial && card.faturaPendente > 0
      ? {
          key: 'quitar',
          label: 'Quitar c/ resíduo…',
          icon: HandCoins,
          run: () => onSettleWithResidual(card.last4),
        }
      : null,
    {
      key: 'desfazer',
      label: 'Desfazer pagamento',
      icon: Undo2,
      run: () => onUndoPayment(card.last4),
    },
    {
      key: 'ajustar',
      label: 'Ajustar fatura…',
      icon: SlidersHorizontal,
      run: () => onAdjustInvoice(card.last4),
    },
  ].filter((a): a is NonNullable<typeof a> => a !== null);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Ações da fatura · ${card.nickname}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-lifeone-ink/40 p-0 sm:items-center sm:p-4"
    >
      <div className="w-full max-w-md rounded-t-3xl bg-lifeone-card p-5 shadow-lifeone-dialog sm:rounded-3xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-lifeone-ink">Ações da fatura</h3>
            <p className="text-[11px] text-lifeone-ink-3">
              {card.nickname} · ••{card.last4}
            </p>
          </div>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-lifeone-hairline text-lifeone-ink-3"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2">
          {actions.map(({ key, label, icon: Icon, run }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                run();
                onClose();
              }}
              className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl border border-lifeone-hairline bg-lifeone-surface px-3.5 text-[14px] font-semibold text-lifeone-ink transition hover:border-lifeone-blue"
            >
              <Icon className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
