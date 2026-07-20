import {
  hasFeature,
  ProjectType,
  splitMobileNav,
  type NavModule,
} from '@reformaflow/domain';

/** Emoji chip per project type (mobile header + desktop project chip). */
export const TYPE_ICONS: Record<string, string> = {
  REFORMA: '🏗️',
  COMPRA: '🏠',
  PESSOAL: '💰',
  CASA: '🏡',
  CARRO: '🚗',
  PLANTAS: '🪴',
};

const PESSOAL_PRIMARY_SLUG = 'monthly';
const PESSOAL_DOCK_SLUGS = new Set(['monthly', 'conta']);
const PESSOAL_MOBILE_HIDDEN_SLUGS = new Set([
  'dre',
  'neutros',
  'planning',
  'budget-allocation',
  'cash-flow',
]);

function isProjectType(value: string): value is ProjectType {
  return Object.values(ProjectType).includes(value as ProjectType);
}

export interface MobileNavSplit {
  primary: NavModule[];
  secondary: NavModule[];
}

/**
 * Splits the already permission-filtered navigation for mobile rendering.
 * PESSOAL reserves its fixed bar for monthly + conta; every other visible module
 * remains available in the Mais sheet. Other types use the first three visible
 * modules in project navigation order.
 */
export function getMobilePrimary(
  type: string,
  visibleNav: NavModule[],
): MobileNavSplit {
  const hasMonthlyOverviewFeature =
    isProjectType(type) && hasFeature(type, 'monthlyOverview');
  const hasMonthlyVisible = visibleNav.some(
    (module) => module.slug === PESSOAL_PRIMARY_SLUG,
  );
  const primary =
    hasMonthlyOverviewFeature
      ? hasMonthlyVisible
        ? visibleNav.filter(
            (module) =>
              module.slug === PESSOAL_PRIMARY_SLUG ||
              module.slug === 'conta',
          )
        : []
      : splitMobileNav(visibleNav, 3).primary;
  const primarySlugs = hasMonthlyOverviewFeature
    ? PESSOAL_DOCK_SLUGS
    : new Set(primary.map((module) => module.slug));
  const secondary = visibleNav.filter((module) => {
    if (primarySlugs.has(module.slug)) return false;
    if (hasMonthlyOverviewFeature && PESSOAL_MOBILE_HIDDEN_SLUGS.has(module.slug)) return false;
    return true;
  });

  return { primary, secondary };
}

/** Matches a route exactly or below a segment boundary. */
export function isPathActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
