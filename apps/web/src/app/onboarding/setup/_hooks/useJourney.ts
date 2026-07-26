'use client';

import { useQuery } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { api } from '@/lib/api';

export interface OnboardingCatalogStep {
  key: string;
  type: string;
  label: string;
}

export interface OnboardingCatalog {
  steps: OnboardingCatalogStep[];
}

/**
 * Fetches the onboarding journey catalog for a given project type.
 * Catalog defines the sequence of steps the user must complete during onboarding.
 * Results are cached to avoid refetch on re-render.
 */
export function useJourney(projectType: ProjectType) {
  return useQuery({
    queryKey: ['onboarding-journey', projectType],
    queryFn: () => api.get<OnboardingCatalog>(`/onboarding/journey/${projectType}`),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
}
