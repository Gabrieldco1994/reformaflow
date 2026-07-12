import { ProjectType } from '@reformaflow/domain';
import { hasFeature } from '@reformaflow/domain';

export type DashboardVariant = 'financial' | 'management' | 'plants' | null;

/**
 * Resolve qual variante de dashboard renderizar para um `ProjectType`.
 *
 * Extraído de `dashboard/page.tsx` (Fase G) — corrige violação da regra
 * "gate por feature, nunca por tipo hard-coded": antes o page.tsx comparava
 * `projectType === "REFORMA" || "COMPRA"` / `"CASA" || "CARRO"` literalmente.
 *
 * PESSOAL e PLANTAS permanecem como comparação direta porque não existe (e não
 * cabe criar nesta Fase, presentation-only) uma `ProjectFeature` própria para
 * "é o dashboard financeiro do Cockpit" (PESSOAL redireciona) ou "é o
 * dashboard de Plantas" (PLANTAS é fora de escopo da Fase G).
 */
export function resolveDashboardVariant(projectType: ProjectType): DashboardVariant {
  if (projectType === ProjectType.PESSOAL) return null; // redireciona para /monthly
  if (hasFeature(projectType, 'recurringBills')) return 'management';
  if (hasFeature(projectType, 'cashFlow')) return 'financial';
  if (projectType === ProjectType.PLANTAS) return 'plants';
  return null;
}
