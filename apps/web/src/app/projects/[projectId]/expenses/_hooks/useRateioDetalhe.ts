'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Item de alocação de uma compra rateada (uma planejada-alvo, outro projeto). */
export interface RateioDetalheItem {
  targetExpenseId: string;
  titulo: string | null;
  fornecedor: string | null;
  projectId: string;
  projectName: string;
  projectType: string;
  /** Centavos alocados a este alvo. */
  allocationCents: number;
  /** Valor total planejado ORIGINAL do alvo (antes do rateio sobrescrever), quando conhecido. */
  plannedValorTotalCents: number | null;
  status: string;
}

/** Detalhe do rateio de uma compra-fonte — GET /projects/:projectId/expenses/:id/rateio. */
export interface RateioDetalhe {
  sourceExpenseId: string;
  rateado: boolean;
  totalSourceCents: number;
  rateadoCents: number;
  sobraCents: number;
  removedTargetsCount: number;
  items: RateioDetalheItem[];
}

/**
 * Hook dedicado ao contrato de detalhe do rateio de uma compra. Usado pela
 * seção compartilhada de `ExpenseFormModal` (DespesaModal/Visão Conta e
 * ExpensesView/Despesas Geral) — não reimplementa `RatearCompraModal`.
 */
export function useRateioDetalhe(
  projectId: string,
  expenseId: string | null | undefined,
  options?: { enabled?: boolean },
): UseQueryResult<RateioDetalhe> {
  return useQuery<RateioDetalhe>({
    queryKey: ['rateio-detalhe', projectId, expenseId],
    queryFn: () => api.get(`/projects/${projectId}/expenses/${expenseId}/rateio`),
    enabled: Boolean(projectId && expenseId) && (options?.enabled ?? true),
    staleTime: 20_000,
  });
}
