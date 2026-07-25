'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  resolveJourney,
  type ProjectType,
  type ResolvedJourneyStep,
} from '@reformaflow/domain';
import { api } from '@/lib/api';

/**
 * Jornada de onboarding do tipo de projeto, com os overrides do admin.
 *
 * NUNCA bloqueia a renderização: enquanto a chamada não responde — ou se ela
 * falhar — o wizard usa o default do catálogo. O onboarding é a primeira
 * experiência da pessoa no produto; um spinner infinito por causa de
 * configuração seria a pior falha possível aqui.
 */
export function useJourney(projectType: ProjectType | null): ResolvedJourneyStep[] {
  const query = useQuery({
    queryKey: ['onboarding-journey', projectType],
    queryFn: () => api.get<ResolvedJourneyStep[]>(`/onboarding/journey/${projectType}`),
    enabled: Boolean(projectType),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(() => {
    if (!projectType) return [];
    const fromApi = query.data;
    return Array.isArray(fromApi) && fromApi.length > 0 ? fromApi : resolveJourney(projectType);
  }, [projectType, query.data]);
}
