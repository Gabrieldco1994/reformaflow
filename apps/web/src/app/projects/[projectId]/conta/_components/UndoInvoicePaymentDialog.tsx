'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw, X } from 'lucide-react';
import { api, ApiResponseError } from '@/lib/api';
import { buildUndoInvoicePaymentPayload, invoiceIdentityErrorMessage } from '../_lib';
import type { AccountViewCardSummary } from '../_types';

interface UndoInvoicePaymentResponse {
  ok: true;
  undonePaymentExpenseId: string;
  cardLast4: string;
  dueMonth: string;
  revertedExpenses: number;
  revertedParcelas: number;
}

interface MatchedPayment {
  id: string;
  amountCents: number;
  data: string | null;
}

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [ambiguousPayments, setAmbiguousPayments] = useState<MatchedPayment[] | null>(null);

  const undo = useMutation({
    mutationFn: () =>
      api.post<UndoInvoicePaymentResponse>(
        `/projects/${projectId}/monthly-overview/undo-invoice-payment`,
        // Identidade explícita (quando a API a forneceu) + último4 legado
        // sempre — reverter a fatura errada é irreversível na prática.
        buildUndoInvoicePaymentPayload(card),
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
    onError: (e: Error) => {
      // 400 de ambiguidade vem com a lista dos pagamentos casados (data, valor,
      // id) — exibimos pra o usuário reconhecer "cliquei duas vezes"/"veio do
      // import" e decidir manualmente, em vez de um beco sem saída.
      const payments =
        e instanceof ApiResponseError && e.status === 400
          ? ((e.body as { payments?: MatchedPayment[] } | undefined)?.payments ?? null)
          : null;
      if (payments && payments.length > 0) {
        setAmbiguousPayments(payments);
        return;
      }
      // Recusa de identidade (mismatch id×último4, ou servidor que não conhece
      // o campo): mensagem honesta, diálogo aberto, botão clicável de novo.
      // Nunca reenviamos sem o id — ver `invoiceIdentityErrorMessage`.
      const identityMessage = invoiceIdentityErrorMessage(e);
      if (identityMessage) {
        toast.error(identityMessage);
        return;
      }
      toast.error(`Erro ao desfazer pagamento: ${e.message}`);
    },
  });

  // Diálogo destrutivo: foco inicial na ação SEGURA (Cancelar), Escape fecha,
  // Tab fica preso no diálogo e o foco volta ao gatilho ao sair.
  // Mesmo padrão do MaisSheet (_components/MaisSheet.tsx).
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusableSelector =
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

    cancelRef.current?.focus();

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

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-lifeone-ink/40 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="undo-invoice-payment-title"
        className="w-full max-w-md rounded-t-3xl bg-lifeone-card p-5 shadow-lifeone-dialog sm:rounded-3xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-lifeone-surface text-lifeone-ink-2">
              <RotateCcw className="h-5 w-5" />
            </span>
            <div>
              <h3
                id="undo-invoice-payment-title"
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
          {ambiguousPayments ? (
            <>
              <p className="text-sm text-lifeone-ink-2">
                Há mais de um pagamento casado com essa fatura — o desfazer automático não é seguro
                nesse caso. Encontramos:
              </p>
              <ul className="space-y-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-surface p-3">
                {ambiguousPayments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex items-center justify-between gap-3 text-sm text-lifeone-ink"
                  >
                    <span className="text-lifeone-ink-3">
                      {payment.data ? dateFormatter.format(new Date(payment.data)) : 'Data desconhecida'}
                    </span>
                    <span className="whitespace-nowrap font-semibold">
                      {currency.format(payment.amountCents / 100)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-lifeone-ink-3">
                Se um deles for duplicado ou tiver vindo de um import, edite ou exclua o lançamento
                manualmente na Conta.
              </p>
            </>
          ) : (
            <p className="text-sm text-lifeone-ink-2">
              Isso vai reabrir as compras dessa fatura ({card.nickname} · ••{card.last4}) como pendentes de
              pagamento novamente. O lançamento de pagamento será removido da Conta.
            </p>
          )}

          <div className="flex gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onClose}
              disabled={undo.isPending}
              className="h-11 flex-1 rounded-xl border border-lifeone-hairline bg-lifeone-card text-sm font-semibold text-lifeone-ink-2 transition hover:border-lifeone-blue disabled:opacity-60"
            >
              {ambiguousPayments ? 'Entendi' : 'Cancelar'}
            </button>
            {!ambiguousPayments && (
              <button
                type="button"
                disabled={undo.isPending}
                onClick={() => undo.mutate()}
                className="h-11 flex-1 rounded-xl border border-red-300 bg-lifeone-card text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-60"
              >
                {undo.isPending ? 'Desfazendo…' : 'Desfazer pagamento'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
