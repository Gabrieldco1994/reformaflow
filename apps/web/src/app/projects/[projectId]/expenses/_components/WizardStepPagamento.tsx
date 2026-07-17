'use client';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Select } from '@/components/ui/select';
import { FormaPagamentoFields } from './FormaPagamentoFields';
import type { WizardDraft } from '../_hooks/useNovaDespesaWizard';

interface TenantCard {
  id: string;
  nickname?: string | null;
  brand: string;
  last4: string;
  project?: { id: string; name: string; type: string } | null;
}

interface TenantAccount {
  id: string;
  nickname?: string | null;
  institution: string;
  last4?: string | null;
  project?: { id: string; name: string; type: string } | null;
}

interface Props {
  draft: WizardDraft;
  patch: (patch: Partial<WizardDraft>) => void;
  allowRecorrente: boolean;
  /** Habilita as buscas de cartão/conta apenas quando o passo está visível. */
  enabled: boolean;
  totalCents: number;
}

/**
 * Passo 2 (PAGAMENTO): forma de pagamento (reusa `FormaPagamentoFields`
 * controlado) + os vínculos "Pago no cartão" / "Paga pela conta" (selects
 * controlados a partir de `/tenant/credit-cards` e `/tenant/bank-accounts`).
 */
export function WizardStepPagamento({ draft, patch, allowRecorrente, enabled, totalCents }: Props) {
  const { data: cards = [] } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
    enabled,
  });
  const { data: accounts = [] } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
    enabled,
  });

  const cardOptions = useMemo(() => {
    const opts = [{ value: '', label: 'Nenhum' }];
    for (const c of cards) {
      const proj = c.project?.name ? ` · ${c.project.name}` : '';
      opts.push({ value: c.id, label: `${c.nickname || c.brand} ****${c.last4}${proj}` });
    }
    return opts;
  }, [cards]);

  const accountOptions = useMemo(() => {
    const opts = [{ value: '', label: 'Nenhuma' }];
    for (const a of accounts) {
      const proj = a.project?.name ? ` · ${a.project.name}` : '';
      const tail = a.last4 ? ` ****${a.last4}` : '';
      opts.push({ value: a.id, label: `${a.nickname || a.institution}${tail}${proj}` });
    }
    return opts;
  }, [accounts]);

  return (
    <div className="space-y-4">
      <FormaPagamentoFields
        formaPagamento={draft.formaPagamento}
        setFormaPagamento={(v) => patch({ formaPagamento: v })}
        dataPagamento={draft.dataPagamento}
        setDataPagamento={(v) => patch({ dataPagamento: v })}
        dataInicioParcela={draft.dataInicioParcela}
        setDataInicioParcela={(v) => patch({ dataInicioParcela: v })}
        allowRecorrente={allowRecorrente}
        editing={null}
        recorrente={draft.recorrente}
        setRecorrente={(v) => patch({ recorrente: v })}
        quantidadeParcelaValue={draft.quantidadeParcela}
        onQuantidadeParcelaChange={(v) => patch({ quantidadeParcela: v })}
        recorrenciaFimValue={draft.recorrenciaFim}
        onRecorrenciaFimChange={(v) => patch({ recorrenciaFim: v })}
        dataCompraValue={draft.dataCompra}
        onDataCompraChange={(v) => patch({ dataCompra: v })}
        valorTotalCents={totalCents}
      />

      <div className="space-y-3 border-t pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Vínculos (opcional)
        </p>
        <Select
          label="Pago no cartão"
          name="creditCardId"
          options={cardOptions}
          value={draft.creditCardId}
          onChange={(e) => patch({ creditCardId: e.target.value })}
        />
        <Select
          label="Paga pela conta"
          name="bankAccountId"
          options={accountOptions}
          value={draft.bankAccountId}
          onChange={(e) => patch({ bankAccountId: e.target.value })}
        />
      </div>
    </div>
  );
}
