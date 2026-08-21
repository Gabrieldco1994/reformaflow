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

/**
 * Não-PESSOAL: quantos módulos da ordem canônica entram no dock (o 1º é sempre
 * `dashboard`). Constante nomeada em vez de um literal `3` espalhado — quando o
 * produto quiser mexer no nº de slots, muda-se aqui, com o PO olhando.
 */
export const DOCK_PRIMARY_SLOTS = 3;

/**
 * PESSOAL (agent-first): destinos FIXOS do dock que SÃO módulos de nav. A Maria
 * é o 3º destino do dock, mas NÃO é módulo (`/maria` não está em PROJECT_NAV);
 * ela é renderizada inline no MobileTabBar sob o mesmo gate de tipo
 * (`monthlyOverview`). O dock preserva os destinos de HOJE — ele não deriva da
 * ordem do array (decisão de produto, não efeito colateral de um PR de shell).
 * Aqui só se filtra por permissão; cada slot é guardado por si.
 *
 * U4 (#453): `credit-cards` SAIU desta lista junto com a saída do slug de
 * `PROJECT_NAV[PESSOAL]` — cartões passam a ser geridos pelo hub `/conta`. Não
 * bastava deixar a entrada morta aqui: `visibleNav` nunca mais traz o slug, e
 * uma entrada que jamais casa é um 4º slot latente que voltaria sozinho no dia
 * em que alguém devolvesse o slug ao nav. O dock é decisão de produto (3 slots),
 * então ele é declarado, não herdado por acidente.
 */
const PESSOAL_DOCK_SLUGS = new Set(['monthly', 'conta']);

function isProjectType(value: string): value is ProjectType {
  return Object.values(ProjectType).includes(value as ProjectType);
}

export interface MobileNavSplit {
  primary: NavModule[];
  secondary: NavModule[];
}

/**
 * Particiona a navegação (já filtrada por permissão) para o mobile.
 *
 * PESSOAL: o dock são os destinos de HOJE (`monthly`, `conta` — mais a Maria
 * inline no MobileTabBar). Cada um é guardado INDEPENDENTEMENTE por
 * `visibleNav`; conta não some só porque monthly foi bloqueado (era o
 * acoplamento antigo, mesma classe do D11/E-5). O `secondary` (Mais) é o
 * COMPLEMENTO EXATO do dock — nada de ocultar `dre/neutros/planning/cash-flow`
 * (D1): a invariante é `dock ∪ Mais === visibleNav`.
 *
 * Demais tipos: os primeiros `DOCK_PRIMARY_SLOTS` módulos visíveis, na ordem do
 * projeto; o resto vai para o Mais.
 */
export function getMobilePrimary(
  type: string,
  visibleNav: NavModule[],
): MobileNavSplit {
  const isPessoalDock =
    isProjectType(type) && hasFeature(type, 'monthlyOverview');

  if (isPessoalDock) {
    const primary = visibleNav.filter((module) =>
      PESSOAL_DOCK_SLUGS.has(module.slug),
    );
    const secondary = visibleNav.filter(
      (module) => !PESSOAL_DOCK_SLUGS.has(module.slug),
    );
    return { primary, secondary };
  }

  return splitMobileNav(visibleNav, DOCK_PRIMARY_SLOTS);
}

/** Matches a route exactly or below a segment boundary. */
export function isPathActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
