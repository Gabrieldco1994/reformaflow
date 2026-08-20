'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CreditCard, X } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { centsToReaisInput, currencyInputToCents, maskCurrencyInput } from '@/lib/currency-input';
import { buildPayInvoicePayload, invoiceIdentityErrorMessage } from '../_lib';
import type { AccountViewCardSummary, AccountViewConta } from '../_types';

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Chave de seleção da conta de débito. Usa `accountId` quando a API o fornece
 * (identidade estável) e cai no último4 na API antiga — o mesmo comportamento
 * de hoje. Nunca some do DOM: o `<option>` sempre tem valor.
 */
function contaKey(conta: AccountViewConta) {
  return conta.accountId?.trim() || conta.last4;
}

export function PagarFaturaDialog({
  projectId,
  card,
  contas,
  onClose,
}: {
  projectId: string;
  card: AccountViewCardSummary;
  contas: AccountViewConta[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const defaultAmount = card.faturaPendente > 0 ? card.faturaPendente : card.faturaAtual;
  const [valor, setValor] = useState(centsToReaisInput(defaultAmount));
  const [data, setData] = useState(todayKey());
  const [contaSelecionada, setContaSelecionada] = useState(
    contas[0] ? contaKey(contas[0]) : '',
  );

  useEffect(() => {
    if (!contaSelecionada && contas[0]) setContaSelecionada(contaKey(contas[0]));
  }, [contas, contaSelecionada]);

  const conta = contas.find((item) => contaKey(item) === contaSelecionada) ?? null;

  const pay = useMutation({
    mutationFn: () => {
      if (!conta) throw new Error('Selecione a conta de onde o pagamento sai.');
      // Identidade explícita quando a API a forneceu + último4 legado SEMPRE:
      // é o que faz a ação completar tanto na API nova (id tem precedência)
      // quanto na antiga (ignora chave desconhecida e resolve por último4).
      return api.post(
        `/projects/${projectId}/monthly-overview/pay-invoice`,
        buildPayInvoicePayload({
          card,
          account: conta,
          amountCents: currencyInputToCents(valor || '0'),
          paymentDate: data,
        }),
      );
    },
    onSuccess: () => {
      toast.success(`Pagamento da fatura ${card.nickname} registrado`);
      queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
      queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      onClose();
    },
    onError: (e: Error) => {
      // Recusa de identidade: mensagem honesta + recarrega a Visão Conta para
      // a próxima tentativa sair com a identidade fresca. NUNCA reenviamos o
      // payload sem os ids (downgrade de identidade) — ver
      // `invoiceIdentityErrorMessage`. O diálogo fica aberto e o botão volta a
      // ficar clicável: sem CTA morta, sem falso sucesso.
      const identityMessage = invoiceIdentityErrorMessage(e);
      if (identityMessage) {
        queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
        toast.error(identityMessage);
        return;
      }
      toast.error(`Erro ao pagar fatura: ${e.message}`);
    },
  });

  const noAccounts = contas.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-lifeone-ink/40 p-0 sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-t-3xl bg-lifeone-card p-5 shadow-lifeone-dialog sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-lifeone-surface text-lifeone-ink-2">
              <CreditCard className="h-5 w-5" />
            </span>
            <div>
              <h3
                className="text-base font-bold text-lifeone-ink font-geist not-italic"
                style={{ fontFamily: "'Geist', var(--font-sans), system-ui, sans-serif", fontStyle: 'normal' }}
              >
                Pagar fatura
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

        {noAccounts ? (
          <div className="rounded-2xl border border-[#EAD9C0] bg-[#FBEBDC] p-4 text-sm text-[#B5803A]">
            Cadastre uma conta bancária para registrar de onde o pagamento sai.
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="text-[11px] font-semibold text-lifeone-ink-3">Valor</span>
              <input
                type="text"
                inputMode="numeric"
                value={valor}
                onChange={(e) => setValor(maskCurrencyInput(e.target.value))}
                className="mt-1 h-11 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
              />
              <span className="mt-1 block text-[11px] text-lifeone-ink-4">
                pendente: {formatCurrency(card.faturaPendente / 100)} · total: {formatCurrency(card.faturaAtual / 100)}
              </span>
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold text-lifeone-ink-3">Sai da conta</span>
              <select
                value={contaSelecionada}
                onChange={(e) => setContaSelecionada(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
              >
                {contas.map((conta) => (
                  <option key={contaKey(conta)} value={contaKey(conta)}>
                    {conta.nome} · ••{conta.last4}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold text-lifeone-ink-3">Data do pagamento</span>
              <input
                type="date"
                value={data}
                onChange={(e) => setData(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
              />
            </label>

            <button
              type="button"
              disabled={pay.isPending || !conta}
              onClick={() => pay.mutate()}
              className="h-11 w-full rounded-xl bg-lifeone-blue text-sm font-semibold text-[#FFFFFF] transition hover:bg-[#0857C4] disabled:opacity-60"
            >
              {pay.isPending ? 'Pagando…' : 'Confirmar pagamento'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
