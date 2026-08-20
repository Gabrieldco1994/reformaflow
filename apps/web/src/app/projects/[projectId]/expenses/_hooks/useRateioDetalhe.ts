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

/**
 * Detalhe do rateio de uma compra-fonte — GET /projects/:projectId/expenses/:id/rateio.
 *
 * Contrato SOURCE-ONLY (#448): participante fora da lente ⇒ a resposta é a de
 * uma compra nunca rateada. Sem lista parcial não há campo que declare o oculto
 * nem número do qual derivá-lo. `hiddenTargetsCount`/`hiddenAllocationCents`
 * não existem no contrato.
 */
export interface RateioDetalhe {
  sourceExpenseId: string;
  /**
   * `false` = para ESTE leitor a compra não está rateada — o mesmo payload
   * responde a compra sem nenhuma alocação e a compra com participante fora da
   * lente, e nada na tela pode separar os dois casos.
   */
  rateado: boolean;
  totalSourceCents: number;
  /**
   * Σ `allocationCents` dos itens. Quando vem lista, ela é COMPLETA, então este
   * número cobre todos os alvos; com `rateado: false` ele é `0` e `sobraCents`
   * é o total.
   */
  rateadoCents: number;
  sobraCents: number;
  /**
   * Alocações cujo alvo foi soft-deletado. Não é um estado distinguível de "não
   * rateada": o payload preserva o campo por estabilidade de forma, e o web não
   * pode construir uma leitura própria em cima dele.
   *
   * Opcional porque o bundle tem que renderizar sem NaN e sem alarme fabricado
   * qualquer que seja a versão do servidor. Leia sempre via
   * `../_lib/rateio-partial`.
   */
  removedTargetsCount?: number;
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
