'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { centsToReaisInput, currencyInputToCents, maskCurrencyInput } from '@/lib/currency-input';
import type { AccountViewCardSummary } from '../_types';

type Mode = 'adjust' | 'residual';

const REASONS = [
  { value: 'JUROS_ROTATIVO', label: 'Juros rotativo' },
  { value: 'IOF', label: 'IOF' },
  { value: 'ESTORNO', label: 'Estorno' },
  { value: 'CONTESTACAO', label: 'Compra contestada' },
  { value: 'OUTRO', label: 'Outro' },
] as const;

export function InvoiceInterventionDialog({
  projectId,
  card,
  mode,
  onClose,
}: {
  projectId: string;
  card: AccountViewCardSummary;
  mode: Mode;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isResidual = mode === 'residual';
  const [reason, setReason] = useState<(typeof REASONS)[number]['value']>('OUTRO');
  const [isNegative, setIsNegative] = useState(false);
  const [valor, setValor] = useState(
    centsToReaisInput(isResidual ? Math.max(card.faturaAtual - card.faturaPaga, 0) : 0),
  );
  const [note, setNote] = useState('');

  const amountCents = useMemo(() => {
    const cents = currencyInputToCents(valor || '0');
    if (isResidual) return cents;
    return isNegative ? -cents : cents;
  }, [isNegative, isResidual, valor]);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/projects/${projectId}/invoice-adjustments`, {
        cardLast4: card.last4,
        dueMonth: card.dueMonth,
        amountCents,
        reason: isResidual ? 'QUITACAO_RESIDUO' : reason,
        note,
      }),
    onSuccess: () => {
      toast.success(isResidual ? 'Quitação com resíduo registrada' : 'Ajuste de fatura registrado');
      queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
      queryClient.invalidateQueries({ queryKey: ['card-invoices-yearly', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      onClose();
    },
    onError: (error: Error) => toast.error(`Erro ao registrar: ${error.message}`),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-lifeone-ink/40 p-0 sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-t-3xl bg-lifeone-card p-5 shadow-lifeone-dialog sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-lifeone-ink">
              {isResidual ? 'Marcar quitada com resíduo' : 'Ajustar fatura'}
            </h3>
            <p className="text-[11px] text-lifeone-ink-3">
              {card.nickname} · ••{card.last4} · total {formatCurrency(card.faturaAtual / 100)}
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

        <div className="space-y-3">
          {!isResidual && (
            <>
              <label className="block">
                <span className="text-[11px] font-semibold text-lifeone-ink-3">Motivo</span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as (typeof REASONS)[number]['value'])}
                  className="mt-1 h-11 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
                >
                  {REASONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="inline-flex rounded-xl bg-lifeone-sidebar p-1 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setIsNegative(false)}
                  className={`rounded-lg px-3 py-1.5 ${!isNegative ? 'bg-lifeone-card text-lifeone-ink' : 'text-lifeone-ink-3'}`}
                >
                  Soma (+)
                </button>
                <button
                  type="button"
                  onClick={() => setIsNegative(true)}
                  className={`rounded-lg px-3 py-1.5 ${isNegative ? 'bg-lifeone-card text-lifeone-ink' : 'text-lifeone-ink-3'}`}
                >
                  Reduz (−)
                </button>
              </div>
            </>
          )}

          <label className="block">
            <span className="text-[11px] font-semibold text-lifeone-ink-3">
              {isResidual ? 'Resíduo declarado' : 'Valor do ajuste'}
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={valor}
              onChange={(e) => setValor(maskCurrencyInput(e.target.value))}
              className="mt-1 h-11 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold text-lifeone-ink-3">Nota</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
            />
          </label>

          <button
            type="button"
            disabled={save.isPending || amountCents === 0}
            onClick={() => save.mutate()}
            className="h-11 w-full rounded-xl bg-lifeone-blue text-sm font-semibold text-white transition hover:bg-[#0857C4] disabled:opacity-60"
          >
            {save.isPending ? 'Salvando…' : isResidual ? 'Confirmar quitação com resíduo' : 'Salvar ajuste'}
          </button>
        </div>
      </div>
    </div>
  );
}
