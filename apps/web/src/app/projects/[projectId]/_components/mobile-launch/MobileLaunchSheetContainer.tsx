'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';
import { invalidateExpenseQueries } from '../../expenses/_hooks/useExpenseMutations';
import { currentMonthKey } from '../../conta/_lib';
import type { AccountViewResponse, OriginItemsYearlyResponse } from '../../conta/_types';
import { MobileLaunchSheet } from './MobileLaunchSheet';
import type { LaunchAccountOption, LaunchCardOption, LaunchPayload } from './types';

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

type CreatedExpense = { id: string };

export function MobileLaunchSheetContainer({ projectId, open, onClose }: Props) {
  const queryClient = useQueryClient();
  const { projectType } = useProject();
  const month = currentMonthKey();
  const year = month.slice(0, 4);

  // Origens só do PROJETO ATUAL: CreditCard/BankAccount têm projectId no schema,
  // então os endpoints /tenant/* (tenant-wide) traziam cartões/contas de outros
  // projetos. Os project-scoped retornam a entidade completa (id, nickname, last4,
  // closingDay, dueDay) — cada label vem do nickname da própria entidade.
  const { data: accounts = [] } = useQuery<LaunchAccountOption[]>({
    queryKey: ['project', projectId, 'bank-accounts'],
    queryFn: () => api.get(`/projects/${projectId}/bank-accounts`),
    enabled: open,
    staleTime: 60_000,
  });

  const { data: cards = [] } = useQuery<LaunchCardOption[]>({
    queryKey: ['project', projectId, 'credit-cards'],
    queryFn: () => api.get(`/projects/${projectId}/credit-cards`),
    enabled: open,
    staleTime: 60_000,
  });

  const { data: accountView } = useQuery<AccountViewResponse>({
    queryKey: ['account-view', projectId, month],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview/account-view?month=${month}`),
    enabled: open,
  });

  const { data: yearlyItems } = useQuery<OriginItemsYearlyResponse>({
    queryKey: ['origin-items-yearly', projectId, year, 'all'],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview/origin-items-yearly?year=${year}&kind=all`),
    enabled: open,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/expenses/${id}`),
    onSuccess: () => {
      invalidateExpenseQueries(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: ['origin-items-yearly', projectId] });
      toast.success('Lançamento desfeito');
    },
    onError: (error: Error) => toast.error(`Não foi possível desfazer: ${error.message}`),
  });

  const createMutation = useMutation({
    mutationFn: (payload: LaunchPayload) => api.post<CreatedExpense>(`/projects/${projectId}/expenses`, payload),
    onSuccess: (created, variables) => {
      invalidateExpenseQueries(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: ['origin-items-yearly', projectId] });
      toast.success('Despesa lançada', {
        description: `${variables.titulo ?? 'Despesa'} · ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(variables.valor)}`,
        action: created?.id
          ? {
              label: 'Desfazer',
              onClick: () => deleteMutation.mutate(created.id),
            }
          : undefined,
      });
    },
    onError: (error: Error) => toast.error(`Erro ao lançar despesa: ${error.message}`),
  });

  const recentDescriptions = useMemo(() => {
    const unique = new Set<string>();
    for (const item of yearlyItems?.items ?? []) {
      // Remove sufixo cru de parcela ("Sofá — parcela 4/10" → "Sofá") para o chip
      // não vazar "4/10" nem duplicar a mesma compra parcelada.
      const label = item.descricao?.replace(/\s*[—–-]?\s*(parcela\s*)?\d+\s*\/\s*\d+\s*$/i, '').trim();
      if (!label) continue;
      unique.add(label);
      if (unique.size >= 8) break;
    }
    return Array.from(unique);
  }, [yearlyItems]);

  return (
    <MobileLaunchSheet
      open={open}
      onClose={onClose}
      onLaunch={(payload) => createMutation.mutateAsync(payload).then(() => undefined)}
      launching={createMutation.isPending}
      accounts={accounts}
      cards={cards}
      recentDescriptions={recentDescriptions}
      projectType={projectType}
      projectedBalanceCents={accountView?.sobraPrevista ?? null}
    />
  );
}
