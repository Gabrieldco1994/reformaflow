'use client';

import { getCatalogItem, SummaryPageDef, ProjectType } from '@reformaflow/domain';
import { useProject } from '@/contexts/project-context';

/**
 * Hook to load summary page metadata from the catalog.
 *
 * Usage:
 * ```tsx
 * const catalogItem = useSummaryCatalog('monthly');
 * if (catalogItem) {
 *   return <SummaryPageHeader pageData={catalogItem} />;
 * }
 * ```
 *
 * @param slug The page slug (e.g., 'dashboard', 'monthly', 'conta').
 * @returns The catalog item for the slug, or undefined if not found or project not loaded.
 */
export function useSummaryCatalog(slug: string): SummaryPageDef | undefined {
  const project = useProject();

  if (!project) {
    return undefined;
  }

  // Map string projectType from context to ProjectType enum
  const projectType = project.projectType as ProjectType;

  return getCatalogItem(projectType, slug);
}
