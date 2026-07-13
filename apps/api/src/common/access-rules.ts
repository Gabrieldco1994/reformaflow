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

/**
 * Pode CRIAR projetos do tipo informado?
 * - ADMIN/OWNER: sempre.
 * - allowedProjectTypes não-vazio: só os tipos listados (controle explícito).
 * - allowedProjectTypes vazio: deriva dos módulos (comportamento atual).
 */
export function userCanCreateProjectType(
  role: string | undefined,
  allowedProjectTypes: string[] | undefined,
  allowedModules: string[],
  projectType: string,
): boolean {
  if (isFullAccessRole(role)) return true;
  const types = allowedProjectTypes ?? [];
  if (types.length > 0) return types.includes(projectType);
  return userHasAnyModuleForType(projectType, allowedModules);
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
