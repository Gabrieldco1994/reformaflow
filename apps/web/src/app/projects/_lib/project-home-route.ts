import { getProjectNavModules, ProjectType, type ProjectType as KnownProjectType } from '@reformaflow/domain';

const DEFAULT_HOME_SLUG = 'dashboard';

export function isKnownProjectType(value: string): value is KnownProjectType {
  return Object.values(ProjectType).includes(value as KnownProjectType);
}

export function getProjectHomePath(projectId: string, projectType: string): string {
  const basePath = `/projects/${projectId}`;
  if (!isKnownProjectType(projectType)) return `${basePath}/${DEFAULT_HOME_SLUG}`;

  const homeSlug = getProjectNavModules(projectType)[0]?.slug ?? DEFAULT_HOME_SLUG;
  return `${basePath}/${homeSlug}`;
}
