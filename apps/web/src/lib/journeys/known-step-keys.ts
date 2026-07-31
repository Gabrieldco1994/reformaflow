import {
  JOURNEY_CATALOG,
  getSummaryCatalog,
  listAllCatalogStepKeys,
  listSummaryCatalogSlugs,
  type ProjectType,
} from "@reformaflow/domain";
import { listOperationalSummaryStepKeys } from "@/lib/operational-summaries/registry";

/**
 * `stepKey`s de `JOURNEY_CATALOG` restritos a um tipo de projeto: toda
 * jornada cujo primeiro gatilho mira esse tipo, MAIS as jornadas globais
 * (`targetProjectType: null`, sem tipo — aplicam a qualquer projeto). Espelha
 * o mesmo critério do filtro de candidatos do editor
 * (`journeys-api.ts#stepKeysForProjectType`) — ambos leem só
 * `JOURNEY_CATALOG`, nunca `PROJECT_NAV`/`getJourneyScreenKeys` (essa cadeia
 * está sob mudança em paralelo por outra frente).
 */
function catalogStepKeysForType(type: ProjectType): string[] {
  const keys = new Set<string>();
  for (const definition of Object.values(JOURNEY_CATALOG)) {
    const journeyTarget = definition.triggers[0]?.targetProjectType ?? null;
    if (journeyTarget !== null && journeyTarget !== type) continue;
    for (const step of definition.steps) keys.add(step.key);
  }
  return [...keys];
}

/**
 * Conjunto de `stepKey`s que o executor web sabe lidar com — alimenta
 * `ctx.knownStepKeys` de `resolveJourneyPlan` (Etapa E, parte 2, todo #4).
 * União de três fontes, cada uma cobrindo um caso:
 * - `listAllCatalogStepKeys()` (ou, com `projectType`, só as chaves do
 *   catálogo que se aplicam a ESSE tipo): toda chave já usada por alguma
 *   jornada do catálogo (onboarding hoje) — garante que NENHUMA jornada já
 *   materializada pelo bootstrap vire "desconhecida" quando este gate ligar,
 *   mesmo para chaves sem componente (`maria-insight`/`feedback` caem no
 *   fallback seguro, igual ao comportamento de hoje).
 * - `listOperationalSummaryStepKeys()`: chaves com componente operacional
 *   registrado — cobre passos operacionais que uma jornada NOVA (fora do
 *   catálogo de onboarding) venha a usar. Não é filtrado por tipo: um
 *   componente existir não é específico de projeto, só a jornada que o usa é.
 * - `listSummaryCatalogSlugs()` (ou, com `projectType`, só os slugs do
 *   resumo informativo DESSE tipo): cobre as telas sem componente
 *   operacional que uma jornada nova pode configurar como SUMMARY.
 *
 * `projectType` ausente/`null` preserva o comportamento anterior (união de
 * TODOS os tipos) — é o caso da jornada `ALL_PROJECTS`/sem projeto ativo
 * ainda resolvido. Quando informado, restringe a etapas do PRÓPRIO tipo (mais
 * globais), então um passo de outro tipo (ex.: `car` numa jornada CASA) deixa
 * de ser "conhecido" e cai no aviso `UNKNOWN_STEP_KEY` já existente — sem
 * precisar de um código de aviso novo.
 */
export function getKnownJourneyStepKeys(projectType?: ProjectType | null): string[] {
  const catalogStepKeys = projectType
    ? catalogStepKeysForType(projectType)
    : listAllCatalogStepKeys();
  const summarySlugs = projectType
    ? getSummaryCatalog(projectType).map((page) => page.slug)
    : listSummaryCatalogSlugs();
  return [
    ...new Set([
      ...catalogStepKeys,
      ...listOperationalSummaryStepKeys(),
      ...summarySlugs,
    ]),
  ];
}
