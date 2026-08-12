'use client';

import { AlertTriangle } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { StatusBadge } from './StatusBadge';
import type { RateioDetalhe } from '../_hooks/useRateioDetalhe';

interface Props {
  isLoading: boolean;
  isError: boolean;
  detalhe: RateioDetalhe | undefined;
  onRetry: () => void;
}

/**
 * Seção compartilhada de "detalhe do rateio" de uma compra-fonte — exibida
 * dentro de `ExpenseFormModal` (reutilizada por DespesaModal/Visão Conta e
 * ExpensesView/Despesas Geral). Lista, em modo somente-leitura, TODAS as
 * planejadas-alvo para as quais esta compra foi rateada. Não oferece
 * desfazer/editar — isso continua exclusivo de `RatearCompraModal`.
 */
export function RateioDetalheSection({ isLoading, isError, detalhe, onRetry }: Props) {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-darc-linen bg-darc-cream/40 px-3 py-2.5 text-sm text-darc-velvet/60">
        Carregando rateio da compra…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
        <p className="text-sm text-red-700">Erro ao carregar o rateio desta compra.</p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-[44px] items-center text-sm font-medium text-red-700 underline"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (!detalhe || !detalhe.rateado) return null;

  const hasWarning = detalhe.removedTargetsCount > 0 || detalhe.sobraCents !== 0;
  const hasHidden = detalhe.hiddenTargetsCount > 0;

  return (
    <div
      data-testid="rateio-detalhe"
      data-total-cents={detalhe.totalSourceCents}
      data-rateado-cents={detalhe.rateadoCents}
      data-sobra-cents={detalhe.sobraCents}
      data-hidden-targets-count={detalhe.hiddenTargetsCount}
      data-hidden-allocation-cents={detalhe.hiddenAllocationCents}
      className="space-y-2 rounded-xl border border-darc-linen bg-darc-cream/40 px-3 py-2.5"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-darc-velvet/50">Compra rateada</p>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Total</p>
          <p className="whitespace-nowrap text-sm font-semibold tabular-nums text-darc-velvet">
            {formatCurrency(detalhe.totalSourceCents / 100)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Rateado</p>
          <p className="whitespace-nowrap text-sm font-semibold tabular-nums text-darc-velvet">
            {formatCurrency(detalhe.rateadoCents / 100)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Sobra</p>
          <p
            className={`whitespace-nowrap text-sm font-semibold tabular-nums ${
              detalhe.sobraCents === 0 ? 'text-emerald-600' : 'text-amber-600'
            }`}
          >
            {formatCurrency(detalhe.sobraCents / 100)}
          </p>
        </div>
      </div>

      {hasWarning && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {detalhe.removedTargetsCount > 0
              ? `${detalhe.removedTargetsCount} ${
                  detalhe.removedTargetsCount === 1 ? 'planejada removida' : 'planejadas removidas'
                } deste rateio.`
              : 'A soma das alocações não fecha o total desta compra.'}
          </span>
        </p>
      )}

      {hasHidden && (
        <p data-testid="rateio-hidden" className="text-xs text-darc-velvet/60">
          {detalhe.hiddenTargetsCount === 1
            ? `1 alocação em projeto sem acesso · ${formatCurrency(detalhe.hiddenAllocationCents / 100)}`
            : `${detalhe.hiddenTargetsCount} alocações em projetos sem acesso · ${formatCurrency(
                detalhe.hiddenAllocationCents / 100,
              )}`}
        </p>
      )}

      <ul className="space-y-1.5">
        {detalhe.items.map((item) => (
          <li
            key={item.targetExpenseId}
            data-testid="rateio-item"
            className="rounded-lg border border-darc-linen bg-white px-2 py-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-darc-velvet">
                  {item.titulo || item.fornecedor || 'Despesa'}
                </p>
                <p className="truncate text-[11px] text-darc-velvet/50">{item.projectName}</p>
              </div>
              <StatusBadge status={item.status} />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-darc-velvet/70">
              <span className="whitespace-nowrap">{formatCurrency(item.allocationCents / 100)}</span>
              {item.plannedValorTotalCents != null && (
                <span className="whitespace-nowrap text-darc-velvet/40">
                  planejado original {formatCurrency(item.plannedValorTotalCents / 100)}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
