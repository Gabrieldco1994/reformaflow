import type { Expense } from '@/types';
import type { RatearMixedPayload } from './wizardPayload';

export interface BulkLinkTargetOpts {
  targetProjectId: string;
  tipoDespesa: string;
}

/**
 * Monta o payload `ratear-mixed` para o fluxo "Vincular em massa": um único
 * alvo NOVO por despesa-fonte, sem split (allocation = valorTotal integral),
 * quantidade sempre 1 e forma de pagamento fixa em A_VISTA. `status` herda
 * da fonte. `titulo`/`fornecedor` nulos ou ausentes na fonte viram
 * `undefined` (nunca `null`) no payload.
 */
export function buildBulkLinkTargetPayload(
  source: Expense,
  opts: BulkLinkTargetOpts,
): RatearMixedPayload {
  return {
    newTargets: [
      {
        targetProjectId: opts.targetProjectId,
        tipoDespesa: opts.tipoDespesa,
        valor: Math.round(source.valorTotal) / 100,
        quantidade: 1,
        titulo: source.titulo ?? undefined,
        fornecedor: source.fornecedor ?? undefined,
        formaPagamento: 'A_VISTA',
        status: source.status,
        allocation: source.valorTotal,
      },
    ],
    existing: [],
  };
}
