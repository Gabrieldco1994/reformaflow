'use client';

import { useMemo } from 'react';
import { useQuery, useQueries, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { RateioTargetsBySource } from '../_lib/personal-hierarchy';

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
  /** Σ allocationCents dos alvos ATIVOS — visíveis + ocultos. NÃO depende de quem olha (I-D). */
  rateadoCents: number;
  sobraCents: number;
  removedTargetsCount: number;
  /** Alocações de alvo ATIVO em projeto fora da lente do requisitante (ou fora do tenant). */
  hiddenTargetsCount: number;
  /** Σ centavos das ocultas. Explica Σ items < rateadoCents SEM virar `sobra` fantasma (I-A). */
  hiddenAllocationCents: number;
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
    refetchOnMount: 'always',
  });
}

/**
 * Bulk (client-side) do detalhe do rateio para VÁRIAS possíveis fontes — issue
 * #428 follow-up: a aba Despesas (PESSOAL) precisa saber, para cada despesa
 * local com `linkedExpenseId`, se ela é uma fonte de rateio ATIVO e, se for,
 * TODOS os `targetExpenseId` (não só o 1º, apontado por `linkedExpenseId`) —
 * senão os demais alvos vazam como saída separada e dobram o total exibido.
 *
 * Reusa a MESMA queryKey/queryFn de `useRateioDetalhe` (cache compartilhado
 * com `RateioDetalheSection`/`ExpenseFormModal`) via `useQueries` — não
 * inventa endpoint novo; não existe hoje um bulk endpoint de rateio no back.
 * `candidateSourceIds` deve ser restrito a despesas com `linkedExpenseId`
 * truthy (só essas podem ser fonte de rateio — o back sempre seta
 * `linkedExpenseId` no 1º alvo quando rateia, ver `ratearSource`).
 */
export function useRateioTargetsBySource(
  projectId: string,
  candidateSourceIds: string[],
  options?: { enabled?: boolean },
): { rateioTargetsBySource: RateioTargetsBySource; isLoading: boolean } {
  const enabled = options?.enabled ?? true;
  const results = useQueries({
    queries: candidateSourceIds.map((sourceId) => ({
      queryKey: ['rateio-detalhe', projectId, sourceId],
      queryFn: () => api.get<RateioDetalhe>(`/projects/${projectId}/expenses/${sourceId}/rateio`),
      enabled: enabled && Boolean(projectId && sourceId),
      staleTime: 20_000,
    })),
  });

  const rateioTargetsBySource = useMemo(() => {
    const map: RateioTargetsBySource = new Map();
    results.forEach((r, idx) => {
      const detalhe = r.data;
      if (!detalhe?.rateado) return;
      const sourceId = candidateSourceIds[idx];
      map.set(sourceId, detalhe.items.map((item) => item.targetExpenseId));
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, candidateSourceIds]);

  return {
    rateioTargetsBySource,
    isLoading: results.some((r) => r.isLoading),
  };
}
