import { listAllCatalogStepKeys, listSummaryCatalogSlugs } from "@reformaflow/domain";
import { listOperationalSummaryStepKeys } from "@/lib/operational-summaries/registry";

/**
 * Conjunto de `stepKey`s que o executor web sabe lidar com — alimenta
 * `ctx.knownStepKeys` de `resolveJourneyPlan` (Etapa E, parte 2, todo #4).
 * União de três fontes, cada uma cobrindo um caso:
 * - `listAllCatalogStepKeys()`: toda chave já usada por alguma jornada do
 *   catálogo (onboarding hoje) — garante que NENHUMA jornada já materializada
 *   pelo bootstrap vire "desconhecida" quando este gate ligar, mesmo para
 *   chaves sem componente (`maria-insight`/`feedback` caem no fallback
 *   seguro, igual ao comportamento de hoje).
 * - `listOperationalSummaryStepKeys()`: chaves com componente operacional
 *   registrado — cobre passos operacionais que uma jornada NOVA (fora do
 *   catálogo de onboarding) venha a usar.
 * - `listSummaryCatalogSlugs()`: todo slug do catálogo de resumos
 *   informativos — cobre as ~18 telas sem componente operacional que uma
 *   jornada nova pode configurar como SUMMARY.
 */
export function getKnownJourneyStepKeys(): string[] {
  return [
    ...new Set([
      ...listAllCatalogStepKeys(),
      ...listOperationalSummaryStepKeys(),
      ...listSummaryCatalogSlugs(),
    ]),
  ];
}
