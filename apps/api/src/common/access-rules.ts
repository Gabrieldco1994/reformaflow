import {
  TYPE_MODULES,
  projectTypeHasModule,
  userHasAnyModuleForType,
} from '@reformaflow/domain';

// The per-project-type module gate now lives in @reformaflow/domain
// (config/type-modules). Re-exported here so existing API importers keep their
// import path unchanged AND the enforcing server gate (modules.guard →
// projectTypeHasModule) shares ONE map with the web (auth-context →
// userHasAnyModuleForType) — they can no longer drift apart (#98).
export { TYPE_MODULES, projectTypeHasModule, userHasAnyModuleForType };

/** User authorization requires an explicit type grant and a module for that type. */
export function userCanAccessProjectType(
  role: string | undefined,
  allowedProjectTypes: string[] | undefined,
  allowedModules: string[],
  projectType: string,
): boolean {
  if (isFullAccessRole(role)) return true;
  const types = Array.isArray(allowedProjectTypes) ? allowedProjectTypes : [];
  return (
    types.includes(projectType) &&
    userHasAnyModuleForType(projectType, allowedModules)
  );
}

export const userCanCreateProjectType = userCanAccessProjectType;

/** Returns the explicitly granted types that still have a corresponding module. */
export function accessibleProjectTypes(
  role: string | undefined,
  allowedProjectTypes: string[] | undefined,
  allowedModules: string[],
): string[] | null {
  if (isFullAccessRole(role)) return null;
  const types = Array.isArray(allowedProjectTypes) ? allowedProjectTypes : [];
  return types.filter((type) => userHasAnyModuleForType(type, allowedModules));
}

/** Papéis com acesso total (veem todos os projetos, ignoram restrição por projeto). */
export function isFullAccessRole(role: string | undefined): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

/**
 * Acesso por PROJETO (independente de módulo/tipo).
 * - ADMIN/OWNER: sempre.
 * - allowedProjects vazio: sem restrição (opt-in) — vê como hoje.
 * - allowedProjects não-vazio: só os projetos listados.
 */
export function userCanAccessProject(
  role: string | undefined,
  allowedProjects: string[] | undefined,
  projectId: string,
): boolean {
  if (isFullAccessRole(role)) return true;
  const list = allowedProjects ?? [];
  if (list.length === 0) return true;
  return list.includes(projectId);
}

/**
 * Escopo de projetos visível em agregações cross-project (tenant/*).
 * - null  => sem restrição (full-access ou allowedProjects vazio): vê tudo.
 * - array => restringir a esses ids (nunca vazio).
 */
export function accessibleProjectScope(
  role: string | undefined,
  allowedProjects: string[] | undefined,
): string[] | null {
  if (isFullAccessRole(role)) return null;
  const list = allowedProjects ?? [];
  if (list.length === 0) return null;
  return list;
}

interface ProjectScopeReader {
  project: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
}

/** Resolves aggregate visibility to concrete IDs, including type revocations. */
export async function resolveAccessibleProjectScope(
  prisma: ProjectScopeReader,
  tenantId: string,
  role: string | undefined,
  allowedProjects: string[] | undefined,
  allowedProjectTypes: string[] | undefined,
  allowedModules: string[],
): Promise<string[] | null> {
  if (isFullAccessRole(role)) return null;
  const types =
    accessibleProjectTypes(role, allowedProjectTypes, allowedModules) ?? [];
  if (types.length === 0) return [];
  const projectIds = Array.isArray(allowedProjects) ? allowedProjects : [];
  const projects = await prisma.project.findMany({
    where: {
      tenantId,
      deletedAt: null,
      type: { in: types },
      ...(projectIds.length > 0 ? { id: { in: projectIds } } : {}),
    },
    select: { id: true },
  });
  return projects.map((project) => project.id);
}
