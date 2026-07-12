import { ModuleSlug } from './decorators/require-module.decorator';

export const TYPE_MODULES: Record<string, ModuleSlug[]> = {
  REFORMA: [
    'dashboard',
    'expenses',
    'receipts',
    'cashFlow',
    'schedule',
    'floorPlans',
    'simulation',
    'priceCompare',
    'rooms',
    'creditCards',
    'pendencias',
  ],
  COMPRA: ['dashboard', 'expenses', 'receipts', 'cashFlow', 'creditCards'],
  PESSOAL: ['dashboard', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts', 'monthlyOverview'],
  CASA: ['dashboard', 'recurringBills', 'maintenance', 'reminders', 'expenses'],
  CARRO: ['dashboard', 'carInfo', 'recurringBills', 'maintenance', 'reminders', 'expenses'],
  PLANTAS: ['dashboard', 'maintenance', 'reminders', 'plantsAi'],
};

export function projectTypeHasModule(
  projectType: string,
  slug: ModuleSlug,
): boolean {
  const allowed = TYPE_MODULES[projectType];
  return Array.isArray(allowed) && allowed.includes(slug);
}

export function userHasAnyModuleForType(
  projectType: string,
  allowedModules: string[],
): boolean {
  const typeMods = TYPE_MODULES[projectType] ?? [];
  return typeMods.some((m) => m !== 'dashboard' && allowedModules.includes(m));
}

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
