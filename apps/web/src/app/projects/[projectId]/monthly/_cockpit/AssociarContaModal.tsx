'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import type { BankAccountRow } from '../../bank-accounts/_types';
import BankAccountFormModal from '../../bank-accounts/_components/BankAccountFormModal';

/**
 * Associa uma conta corrente a um recebimento que nasceu sem conta (ex.: onboarding
 * pulou a conta). Lista as contas do projeto para selecionar, ou cria uma nova
 * (reusa BankAccountFormModal). Ao confirmar, faz PATCH do receipt com o bankLast4.
 */
export function AssociarContaModal({
  projectId,
  receiptId,
  descricao,
  valor,
  onClose,
}: {
  projectId: string;
  receiptId: string;
  descricao: string;
  valor: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const accountsKey = ['bank-accounts', projectId] as const;
  const { data: accounts = [], isLoading } = useQuery<BankAccountRow[]>({
    queryKey: accountsKey,
    queryFn: () => api.get(`/projects/${projectId}/bank-accounts`),
  });

  const associar = useMutation({
    mutationFn: async (bankLast4: string) => {
      await api.patch(`/projects/${projectId}/receipts/${receiptId}`, { bankLast4 });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendencias-financeiras', projectId] });
      queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
      queryClient.invalidateQueries({ queryKey: ['receipts', projectId] });
      toast.success('Conta associada ao recebimento');
      onClose();
    },
    onError: (error: Error) => {
      toast.error(`Não foi possível associar: ${error.message}`);
    },
  });

  return (
    <>
      <Modal open onClose={onClose} title="Associar conta" variant="sheet" size="sm">
        <div className="space-y-3 pb-2">
          <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card p-3">
            <p className="truncate text-[13px] font-medium text-lifeone-ink">{descricao}</p>
            <p className="text-[11px] text-lifeone-ink-3">{formatCurrency(valor / 100)}</p>
          </div>

          {isLoading ? (
            <p className="text-[13px] text-lifeone-ink-3">Carregando contas…</p>
          ) : accounts.length === 0 ? (
            <p className="text-[13px] text-lifeone-ink-3">
              Nenhuma conta cadastrada ainda. Crie uma para associar este recebimento.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {accounts.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(a.last4)}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-[13px] ${
                      selected === a.last4
                        ? 'border-lifeone-blue bg-lifeone-blue/5 text-lifeone-ink'
                        : 'border-lifeone-hairline text-lifeone-ink-2 hover:border-lifeone-blue'
                    }`}
                  >
                    <span className="truncate">{a.nickname?.trim() || a.institution}</span>
                    <span className="ml-2 shrink-0 font-mono text-lifeone-ink-3">••{a.last4}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-[12px] font-semibold text-lifeone-blue hover:underline"
          >
            + Criar nova conta
          </button>

          <button
            type="button"
            disabled={!selected || associar.isPending}
            onClick={() => selected && associar.mutate(selected)}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-lifeone-blue px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Associar conta
          </button>
        </div>
      </Modal>

      {creating && (
        <BankAccountFormModal
          projectId={projectId}
          account={null}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: accountsKey });
          }}
        />
      )}
    </>
  );
}
