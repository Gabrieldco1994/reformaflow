import {
  TYPE_MODULES,
  projectTypeHasModule,
  userHasAnyModuleForType,
  type TypeModuleSlug,
} from '@reformaflow/domain';

// The per-project-type module gate now lives in @reformaflow/domain
// (config/type-modules). Re-exported here so existing API importers keep their
// import path unchanged AND the enforcing server gate (modules.guard →
// projectTypeHasModule) shares ONE map with the web (auth-context →
// userHasAnyModuleForType) — they can no longer drift apart (#98).
export { TYPE_MODULES, projectTypeHasModule, userHasAnyModuleForType };

/**
 * Módulos que DONAM um recurso financeiro. Toda trava de disclosure (#480
 * SEC-1) referencia estas constantes — nunca o literal solto — para que o slug
 * exigido pelo `@RequireModule` do endpoint direto e o exigido pelo
 * preview/sugestão que descobre o mesmo recurso não possam divergir.
 */
export const EXPENSE_MODULE: TypeModuleSlug = 'expenses';
export const RECEIPT_MODULE: TypeModuleSlug = 'receipts';
export const CREDIT_CARD_MODULE: TypeModuleSlug = 'creditCards';
/**
 * Dono do catálogo de contas recorrentes de CASA/CARRO — o mesmo slug exigido
 * pelo `@RequireModule` de `RecurringBillController`. A propagação de
 * recorrências da importação de extrato ESCREVE nesse recurso em outro projeto
 * e por isso responde ao mesmo módulo (#481).
 */
export const RECURRING_BILL_MODULE: TypeModuleSlug = 'recurringBills';

/** User authorization by project type with legacy fallback for empty grants. */
export function userCanAccessProjectType(
  role: string | undefined,
  allowedProjectTypes: string[] | undefined,
  allowedModules: string[],
  projectType: string,
): boolean {
  const types = accessibleProjectTypes(role, allowedProjectTypes, allowedModules);
  if (types === null) return true;
  return types.includes(projectType);
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
  // ponytail: compat legado — quando tipos vierem vazios, reaproveita gate por módulo.
  if (types.length === 0) {
    if (!Array.isArray(allowedModules) || allowedModules.length === 0) return [];
    return Object.keys(TYPE_MODULES).filter((type) =>
      userHasAnyModuleForType(type, allowedModules),
    );
  }
  return types.filter((type) => userHasAnyModuleForType(type, allowedModules));
}

/** Papéis com acesso total (veem todos os projetos, ignoram restrição por projeto). */
export function isFullAccessRole(role: string | undefined): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

/**
 * O requisitante alcança `projectType` **para o recurso de `requiredModule`**?
 *
 * `userCanAccessProjectType` responde "esse usuário enxerga esse TIPO de
 * projeto?" — qualquer módulo não-universal do tipo serve. Essa semântica é
 * correta para listar projetos, e ERRADA para autorizar um recurso específico:
 * quem tem só `creditCards` numa REFORMA passaria a ver candidatos Expense
 * dela em previews/sugestões de importação, apesar das APIs diretas exigirem
 * `@RequireModule('expenses')` (#480 SEC-1).
 *
 * Regra (fail-closed, três condições E):
 *  1. o requisitante POSSUI `requiredModule` (`allowedModules`);
 *  2. o TIPO do projeto tem esse módulo (`projectTypeHasModule`);
 *  3. o tipo continua acessível pelo gate existente (`userCanAccessProjectType`).
 *
 * ADMIN/OWNER seguem irrestritos dentro do tenant.
 */
export function userCanAccessProjectModule(
  role: string | undefined,
  allowedProjectTypes: string[] | undefined,
  allowedModules: string[],
  projectType: string,
  requiredModule: string,
): boolean {
  if (isFullAccessRole(role)) return true;
  const modules = Array.isArray(allowedModules) ? allowedModules : [];
  if (!modules.includes(requiredModule)) return false;
  if (!projectTypeHasModule(projectType, requiredModule)) return false;
  return userCanAccessProjectType(role, allowedProjectTypes, modules, projectType);
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

/**
 * Resolve aggregate visibility to concrete IDs, including type revocations.
 *
 * `requiredModule` (opcional) restringe o escopo ao RECURSO daquele módulo
 * (#480 SEC-1): sem ele o comportamento é idêntico ao histórico — "todo projeto
 * que o usuário enxerga". Com ele, um módulo que o requisitante não possui
 * responde `[]` ANTES de qualquer leitura de projeto ou candidato, e os tipos
 * ainda passam pelo suporte ao módulo (`projectTypeHasModule`), de modo que um
 * módulo não relacionado do MESMO tipo nunca libera o recurso.
 */
export async function resolveAccessibleProjectScope(
  prisma: ProjectScopeReader,
  tenantId: string,
  role: string | undefined,
  allowedProjects: string[] | undefined,
  allowedProjectTypes: string[] | undefined,
  allowedModules: string[],
  requiredModule?: string,
): Promise<string[] | null> {
  if (isFullAccessRole(role)) return null;
  const modules = Array.isArray(allowedModules) ? allowedModules : [];
  // Fail-closed antes do banco: sem o módulo do recurso não há o que buscar.
  if (requiredModule !== undefined && !modules.includes(requiredModule)) return [];
  const accessibleTypes = accessibleProjectTypes(role, allowedProjectTypes, modules);
  const types =
    requiredModule === undefined || accessibleTypes === null
      ? accessibleTypes
      : accessibleTypes.filter((type) => projectTypeHasModule(type, requiredModule));
  if (types !== null && types.length === 0) return [];
  const projectIds = Array.isArray(allowedProjects) ? allowedProjects : [];
  const projects = await prisma.project.findMany({
    where: {
      tenantId,
      deletedAt: null,
      ...(types !== null ? { type: { in: types } } : {}),
      ...(projectIds.length > 0 ? { id: { in: projectIds } } : {}),
    },
    select: { id: true },
  });
  return projects.map((project) => project.id);
}
