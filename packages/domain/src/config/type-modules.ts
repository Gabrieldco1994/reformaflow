import { ProjectType } from '../enums';

/**
 * Module slugs that can gate a project type. Superset of the rows any type
 * renders; kept as a string union for authorship safety (the map below is
 * checked against it).
 */
export type TypeModuleSlug =
  | 'dashboard'
  | 'expenses'
  | 'receipts'
  | 'cashFlow'
  | 'monthlyOverview'
  | 'rooms'
  | 'floorPlans'
  | 'simulation'
  | 'priceCompare'
  | 'recurringBills'
  | 'maintenance'
  | 'reminders'
  | 'carInfo'
  | 'creditCards'
  | 'bankAccounts'
  | 'schedule'
  | 'pendencias'
  | 'plantsAi'
  | 'financing'
  | 'vehicleDocuments';

/**
 * The module slug universal to every project type (its Dashboard/home row).
 * Owning ONLY this module must never, by itself, grant a project type — both
 * gate consumers exclude it (see `userHasAnyModuleForType`). This is the exact
 * "compensating divergence" that made #98 dangerous to collapse naively.
 */
export const UNIVERSAL_MODULE: TypeModuleSlug = 'dashboard';

/**
 * Single source of truth for the per-project-type module ACCESS gate.
 *
 * This is the exact set the API enforces on every request (`@RequireModule` →
 * `projectTypeHasModule` in the modules guard) AND the set the web uses to
 * decide `hasProjectType` / `canCreateProjectType`. Keeping ONE map here makes
 * it impossible for the client gate to drift stricter or looser than the server
 * gate — the bug #98 was filed for.
 *
 * Distinct from:
 *  - `PROJECT_NAV` (module-navigator.ts): which rows are RENDERED. Invariant,
 *    locked by a test: every `PROJECT_NAV[type].module` ∈ `TYPE_MODULES[type]`.
 *  - `PROJECT_FEATURES` (project-features.ts): product CAPABILITY per type.
 */
export const TYPE_MODULES: Record<ProjectType, TypeModuleSlug[]> = {
  [ProjectType.REFORMA]: [
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
  [ProjectType.COMPRA]: ['dashboard', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'priceCompare'],
  [ProjectType.PESSOAL]: [
    'dashboard',
    'expenses',
    'receipts',
    'cashFlow',
    'creditCards',
    'bankAccounts',
    'monthlyOverview',
    'pendencias',
  ],
  [ProjectType.CASA]: ['dashboard', 'recurringBills', 'maintenance', 'reminders', 'expenses', 'financing'],
  [ProjectType.CARRO]: [
    'dashboard',
    'carInfo',
    'vehicleDocuments',
    'recurringBills',
    'maintenance',
    'reminders',
    'expenses',
  ],
  [ProjectType.PLANTAS]: ['dashboard', 'maintenance', 'reminders', 'plantsAi'],
};

/**
 * Is `slug` part of the access gate for project `type`?
 * `type`/`slug` are plain strings so API call sites that pass a Prisma
 * `project.type` (and the modules guard's required slug) need no cast.
 */
export function projectTypeHasModule(type: string, slug: string): boolean {
  const allowed = TYPE_MODULES[type as ProjectType];
  return Array.isArray(allowed) && (allowed as string[]).includes(slug);
}

/**
 * Does a user owning `ownedModules` qualify for project `type`?
 * The `UNIVERSAL_MODULE` (dashboard) is excluded: owning only the universal
 * module must never, by itself, grant a project type. The SAME predicate is
 * used by BOTH the API (project listing / creation) and the web
 * (`auth-context.hasProjectType`) so the two gates can never diverge.
 */
export function userHasAnyModuleForType(type: string, ownedModules: string[]): boolean {
  const typeMods = TYPE_MODULES[type as ProjectType] ?? [];
  return typeMods.some((m) => m !== UNIVERSAL_MODULE && ownedModules.includes(m));
}
