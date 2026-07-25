'use client';

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectType, ResolvedJourneyStep } from '@reformaflow/domain';
import { api } from '@/lib/api';
import type { JourneyMap, JourneyStepPayload } from '../_types';

const QUERY_KEY = ['admin', 'onboarding-journeys'] as const;

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function toPayload(steps: ResolvedJourneyStep[]): JourneyStepPayload[] {
  return steps.map((step, index) => ({
    stepKey: step.key,
    order: index,
    enabled: step.enabled,
    skippable: step.skippable,
    label: step.label,
    subtitle: step.subtitle,
  }));
}

/**
 * Estado do editor de jornadas: uma cópia local ("draft") por tipo de projeto,
 * editada livremente, e só enviada ao servidor no "Salvar jornada".
 *
 * O draft nasce do que o servidor devolveu e é comparado com ele para saber se
 * há alterações não salvas — sem isso o admin não teria como perceber que
 * arrastou um card e esqueceu de salvar.
 */
export function useJourneyEditor(projectType: ProjectType) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<JourneyMap>('/admin/onboarding/journeys'),
    retry: false,
  });

  // Overrides locais por tipo; ausente = ainda igual ao servidor.
  const [drafts, setDrafts] = useState<Partial<Record<string, ResolvedJourneyStep[]>>>({});

  const serverSteps = useMemo<ResolvedJourneyStep[]>(
    () => query.data?.[projectType] ?? [],
    [query.data, projectType],
  );
  const steps = drafts[projectType] ?? serverSteps;

  const dirty = useMemo(
    () => JSON.stringify(steps) !== JSON.stringify(serverSteps),
    [steps, serverSteps],
  );

  const setSteps = useCallback(
    (updater: (current: ResolvedJourneyStep[]) => ResolvedJourneyStep[]) => {
      setDrafts((current) => ({
        ...current,
        [projectType]: updater(current[projectType] ?? serverSteps),
      }));
    },
    [projectType, serverSteps],
  );

  const patchStep = useCallback(
    (key: string, patch: Partial<ResolvedJourneyStep>) => {
      setSteps((current) =>
        current.map((step) => (step.key === key ? { ...step, ...patch } : step)),
      );
    },
    [setSteps],
  );

  const moveStep = useCallback(
    (key: string, direction: -1 | 1) => {
      setSteps((current) => {
        const index = current.findIndex((step) => step.key === key);
        return index < 0 ? current : move(current, index, index + direction);
      });
    },
    [setSteps],
  );

  const reorder = useCallback(
    (activeKey: string, overKey: string) => {
      setSteps((current) => {
        const from = current.findIndex((step) => step.key === activeKey);
        const to = current.findIndex((step) => step.key === overKey);
        return from < 0 || to < 0 ? current : move(current, from, to);
      });
    },
    [setSteps],
  );

  const reset = useCallback(() => {
    setDrafts((current) => ({ ...current, [projectType]: undefined }));
  }, [projectType]);

  const saveMutation = useMutation({
    mutationFn: (next: ResolvedJourneyStep[]) =>
      api.put<ResolvedJourneyStep[]>(`/admin/onboarding/journeys/${projectType}`, {
        steps: toPayload(next),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData<JourneyMap>(QUERY_KEY, (current) =>
        current ? { ...current, [projectType]: saved } : current,
      );
      setDrafts((current) => ({ ...current, [projectType]: undefined }));
    },
  });

  return {
    steps,
    loading: query.isLoading,
    error: query.error as Error | null,
    dirty,
    saving: saveMutation.isPending,
    patchStep,
    moveStep,
    reorder,
    reset,
    save: () => saveMutation.mutateAsync(steps),
  };
}
