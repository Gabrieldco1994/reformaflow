import { getProjectNavModules, ProjectType, type ProjectType as KnownProjectType } from '@reformaflow/domain';

const DEFAULT_HOME_SLUG = 'dashboard';

export function isKnownProjectType(value: string): value is KnownProjectType {
  return Object.values(ProjectType).includes(value as KnownProjectType);
}

/**
 * Home do projeto. Contrato E-5 (ordem exata):
 *   1. tipo desconhecido            → `${base}/dashboard` (inalterado)
 *   2. `canSeeModule` ausente       → `nav[0].slug` (byte-idêntico a hoje)
 *   3. `canSeeModule` presente      → primeiro item VISÍVEL na ordem canônica
 *   4. presente, nenhum visível     → `nav[0].slug` (fallback [0]; NÃO inventa)
 *
 * O predicado recebe `item.module` (distinto de `slug`). Casos 2 e 4 caem no
 * mesmo `[0]` por motivos diferentes; o guard do AppShell é quem decide o
 * `/no-permission` quando nada é visível — este helper nunca inventa destino.
 */
export function getProjectHomePath(
  projectId: string,
  projectType: string,
  canSeeModule?: (module: string) => boolean,
): string {
  const basePath = `/projects/${projectId}`;
  if (!isKnownProjectType(projectType)) return `${basePath}/${DEFAULT_HOME_SLUG}`;

  const nav = getProjectNavModules(projectType);
  const firstVisible = canSeeModule
    ? nav.find((item) => canSeeModule(item.module))
    : undefined;
  const homeSlug = firstVisible?.slug ?? nav[0]?.slug ?? DEFAULT_HOME_SLUG;
  return `${basePath}/${homeSlug}`;
}

