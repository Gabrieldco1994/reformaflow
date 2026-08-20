'use client';

import { useEffect, useRef } from 'react';
import { X, Undo2, SlidersHorizontal, HandCoins } from 'lucide-react';
import { invoiceActionAllowed, invoicePayBlockedReason } from '../_lib';
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Mesmo padrão do MaisSheet/UndoInvoicePaymentDialog: foco inicial num
  // controle seguro (fechar), Tab preso no sheet, Escape fecha sem mutar, e o
  // foco volta ao gatilho ao sair.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusableSelector =
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      trigger?.focus();
    };
  }, [onClose]);

  const actions = [
    parcial && card.faturaPendente > 0
      ? {
          key: 'quitar',
          label: 'Quitar c/ resíduo…',
          icon: HandCoins,
          run: () => onSettleWithResidual(card.last4),
        }
      : null,
    // "Desfazer" só aparece quando o SERVIDOR diz que há pagamento a desfazer.
    // Sem `actions` (API antiga) o comportamento é o de sempre — a opção fica
    // sempre visível. Com `actions`, um final ambíguo (409 garantido) ou uma
    // fatura sem pagamento casado (404 garantido) deixam de oferecer o verbo:
    // esta era a CTA que 404ava em runtime atrás de pipeline verde.
    invoiceActionAllowed(card, 'undo', true)
      ? {
          key: 'desfazer',
          label: 'Desfazer pagamento',
          icon: Undo2,
          run: () => onUndoPayment(card.last4),
        }
      : null,
    {
      key: 'ajustar',
      label: 'Ajustar fatura…',
      icon: SlidersHorizontal,
      run: () => onAdjustInvoice(card.last4),
    },
  ].filter((a): a is NonNullable<typeof a> => a !== null);

  // Fatura em aberto que o servidor não deixa pagar (último4 ambíguo): o sheet
  // é o destino do tap no mobile, então é AQUI que a ausência do verbo precisa
  // ser explicada — senão o usuário só vê o botão sumir. "Ajustar fatura…"
  // continua na lista: `/invoice-adjustments` não tem o 409.
  const payBlockedReason = card.faturaPendente > 0 ? invoicePayBlockedReason(card) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Ações da fatura · ${card.nickname}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-lifeone-ink/40 p-0 sm:items-center sm:p-4"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-t-3xl bg-lifeone-card p-5 shadow-lifeone-dialog sm:rounded-3xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-lifeone-ink">Ações da fatura</h3>
            <p className="text-[11px] text-lifeone-ink-3">
              {card.nickname} · ••{card.last4}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-lifeone-hairline text-lifeone-ink-3"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2">
          {payBlockedReason && (
            <p className="rounded-xl border border-[#F3D9A6] bg-[#FDF6EC] px-3 py-2 text-[12px] font-medium text-[#B54708]">
              {payBlockedReason}
            </p>
          )}
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
