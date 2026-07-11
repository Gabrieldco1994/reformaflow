import { hasFeature, type ProjectType } from '@reformaflow/domain';

export interface BulkLinkTargetProject {
  id: string;
  name: string;
  type: string;
}

/**
 * Lista de projetos-alvo elegíveis para o "Vincular em massa": exclui o
 * projeto atual e qualquer projeto cujo tipo não tenha a feature "expenses".
 */
export function getBulkLinkTargetProjects(
  projects: BulkLinkTargetProject[],
  currentProjectId: string,
): BulkLinkTargetProject[] {
  return projects.filter(
    (p) => p.id !== currentProjectId && hasFeature(p.type as ProjectType, 'expenses'),
  );
}
