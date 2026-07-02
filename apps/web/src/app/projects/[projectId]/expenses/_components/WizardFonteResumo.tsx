'use client';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel, formaLabel } from '@/lib/expense-options';
import type { WizardDraft } from '../_hooks/useNovaDespesaWizard';

interface Props {
  draft: WizardDraft;
  totalCents: number;
}

/** Resumo compacto da despesa-fonte, exibido no topo dos passos AÇÃO e CESTO. */
export function WizardFonteResumo({ draft, totalCents }: Props) {
  const title = draft.titulo || draft.fornecedor || tipoLabel(draft.tipoDespesa) || 'Compra';
  return (
    <div className="rounded-xl border border-darc-linen bg-darc-cream/40 px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Despesa</p>
      <p className="truncate font-semibold text-darc-velvet">{title}</p>
      <p className="text-sm text-darc-velvet/70">
        {formatCurrency(totalCents / 100)}
        {draft.formaPagamento ? ` · ${formaLabel(draft.formaPagamento)}` : ''}
        {Number(draft.quantidade) > 1 ? ` · ${draft.quantidade}x` : ''}
      </p>
    </div>
  );
}
