'use client';

import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { AccountViewCardSummary } from '../_types';

interface UndoInvoicePaymentResponse {
  ok: true;
  undonePaymentExpenseId: string;
  cardLast4: string;
  dueMonth: string;
  revertedExpenses: number;
  revertedParcelas: number;
}

export function UndoInvoicePaymentDialog({
  projectId,
  card,
  onClose,
  onUndone,
}: {
  projectId: string;
  card: AccountViewCardSummary;
  onClose: () => void;
  onUndone?: () => void;
}) {
  const undo = useMutation({
    mutationFn: () =>
      api.post<UndoInvoicePaymentResponse>(
        `/projects/${projectId}/monthly-overview/undo-invoice-payment`,
        {
          cardLast4: card.last4,
          dueMonth: card.dueMonth,
        },
      ),
    onSuccess: (res) => {
      const n = res.revertedParcelas ?? 0;
      toast.success(
        n > 0
          ? `Pagamento desfeito — ${n} parcela${n === 1 ? '' : 's'} voltaram a ficar em aberto.`
          : 'Pagamento desfeito.',
      );
      onUndone?.();
      onClose();
    },
    onError: (e: Error) => toast.error(`Erro ao desfazer pagamento: ${e.message}`),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-lifeone-ink/40 p-0 sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-t-3xl bg-lifeone-card p-5 shadow-lifeone-dialog sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-lifeone-surface text-lifeone-ink-2">
              <RotateCcw className="h-5 w-5" />
            </span>
            <div>
              <h3
                className="text-base font-bold text-lifeone-ink font-geist not-italic"
                style={{ fontFamily: "'Geist', var(--font-sans), system-ui, sans-serif", fontStyle: 'normal' }}
              >
                Desfazer pagamento
              </h3>
              <p className="text-[11px] text-lifeone-ink-3">
                {card.nickname} · ••{card.last4}
              </p>
            </div>
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

        <div className="space-y-3">
          <p className="text-sm text-lifeone-ink-2">
            Isso vai reabrir as compras dessa fatura ({card.nickname} · ••{card.last4}) como pendentes de
            pagamento novamente. O lançamento de pagamento será removido da Conta.
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={undo.isPending}
              className="h-11 flex-1 rounded-xl border border-lifeone-hairline bg-lifeone-card text-sm font-semibold text-lifeone-ink-2 transition hover:border-lifeone-blue disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={undo.isPending}
              onClick={() => undo.mutate()}
              className="h-11 flex-1 rounded-xl border border-red-300 bg-lifeone-card text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-60"
            >
              {undo.isPending ? 'Desfazendo…' : 'Desfazer pagamento'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
