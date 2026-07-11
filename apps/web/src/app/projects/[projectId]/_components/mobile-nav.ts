import {
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

/**
 * PESSOAL gets a curated primary set so the mobile tab bar surfaces the three
 * most-used views (Cockpit, Conta, Despesa) instead of the raw nav order.
 */
const PESSOAL_PRIMARY_SLUGS = ['monthly', 'conta', 'expenses'] as const;

export interface MobileNavSplit {
  primary: NavModule[];
  secondary: NavModule[];
}

/**
 * Computes the mobile tab-bar `primary` slots and the "Mais" sheet `secondary`
 * remainder from the already permission-filtered `visibleNav`.
 *
 * - PESSOAL → curated `['monthly','conta','expenses']`, filtered to those
 *   present in `visibleNav`, in that order.
 * - Other types → first 3 of `visibleNav` (nav order) via `splitMobileNav`.
 * - `secondary` = every visible module NOT in `primary`, in nav order.
 * - Boundary: fewer than 3 visible modules renders only what exists.
 */
export function getMobilePrimary(
  type: string,
  visibleNav: NavModule[],
): MobileNavSplit {
  let primary: NavModule[];

  if (type === ProjectType.PESSOAL) {
    primary = PESSOAL_PRIMARY_SLUGS.map((slug) =>
      visibleNav.find((m) => m.slug === slug),
    ).filter((m): m is NavModule => Boolean(m));
  } else {
    primary = splitMobileNav(visibleNav, 3).primary;
  }

  const primarySlugs = new Set(primary.map((m) => m.slug));
  const secondary = visibleNav.filter((m) => !primarySlugs.has(m.slug));

  return { primary, secondary };
}
