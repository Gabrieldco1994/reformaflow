import { ProjectType } from '../enums';

/**
 * Single source of truth for the per-project-type module navigator.
 *
 * Ordering, labels, slugs, icon tokens and permission gates live here (pure,
 * testable, shared) so BOTH the desktop sidebar and the mobile tab bar / "Mais"
 * sheet consume the same list instead of drifting hard-coded maps in the view.
 *
 * `module` is the permission slug consumed by the web `auth-context.hasModule`
 * (kept as a plain string so the domain package stays free of web imports).
 * `iconName` is a stable token the view maps to its icon set (lucide today).
 * `group` is the sidebar section the entry belongs to (see `NAV_GROUPS`).
 */

/**
 * Seções da navegação. Ordem canônica e rótulos vivem em `NAV_GROUPS`.
 *
 * `projetos` é constante do SHELL: `/projects` é rota global de sessão, sem
 * módulo, então nenhuma entrada de `PROJECT_NAV` a declara e `buildNavGroups`
 * nunca a emite. Ela existe aqui porque o contrato de ORDEM a inclui — quem
 * renderiza é que a insere na posição certa.
 *
 * `modulos` é o grupo de LISTA ÚNICA: os tipos não-financeiros (REFORMA,
 * COMPRA, CASA, CARRO, PLANTAS) declaram todas as entradas nele, preservando o
 * comportamento atual de menu sem seções — mas como DADO declarado, não como
 * um `if (tipo === PESSOAL)` escondido no componente React.
 */
export type NavGroupId =
  | 'hoje'
  | 'movimentacoes'
  | 'planejamento'
  | 'projetos'
  | 'resultado'
  | 'auditoria'
  | 'modulos';

/**
 * `primary` = seções do dia a dia, sempre visíveis. `secondary` = seções de
 * conferência/consulta, que a view pode recolher. A distinção é DADO aqui para
 * que a sidebar não a redescubra por lista de ids hard-coded.
 */
export type NavGroupTier = 'primary' | 'secondary';

export interface NavGroupDefinition {
  id: NavGroupId;
  label: string;
  tier: NavGroupTier;
}

/** Um grupo já materializado com seus itens visíveis (saída de `buildNavGroups`). */
export interface NavGroup extends NavGroupDefinition {
  items: NavModule[];
}

/**
 * Ordem canônica das seções + rótulos. É esta ordem que a view percorre; o
 * `tier` é informativo, não define posição.
 */
export const NAV_GROUPS: NavGroupDefinition[] = [
  { id: 'hoje', label: 'Hoje', tier: 'primary' },
  { id: 'movimentacoes', label: 'Movimentações', tier: 'primary' },
  { id: 'planejamento', label: 'Planejamento', tier: 'primary' },
  { id: 'projetos', label: 'Projetos', tier: 'primary' },
  { id: 'resultado', label: 'Resultado', tier: 'secondary' },
  { id: 'auditoria', label: 'Auditoria', tier: 'secondary' },
  { id: 'modulos', label: 'Módulos', tier: 'secondary' },
];

export interface NavModule {
  slug: string;
  label: string;
  iconName: string;
  module: string;
  /**
   * OBRIGATÓRIO de propósito. Opcional deixaria o default implícito e
   * reintroduziria o descarte silencioso que a função hard-coded da sidebar
   * fazia (`expenses` e `receipts` existiam em `PROJECT_NAV[PESSOAL]` e sumiam
   * do menu desktop porque não constavam de nenhuma lista fixa de slugs).
   */
  group: NavGroupId;
}

export const PROJECT_NAV: Record<ProjectType, NavModule[]> = {
  [ProjectType.REFORMA]: [
    { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard', group: 'modulos' },
    { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses', group: 'modulos' },
    { slug: 'receipts', label: 'Recebimentos', iconName: 'Wallet', module: 'receipts', group: 'modulos' },
    { slug: 'cash-flow', label: 'Fluxo de Caixa', iconName: 'ArrowLeftRight', module: 'cashFlow', group: 'modulos' },
    { slug: 'schedule', label: 'Cronograma', iconName: 'CalendarClock', module: 'schedule', group: 'modulos' },
    { slug: 'pendencias', label: 'Pendências', iconName: 'ListChecks', module: 'pendencias', group: 'modulos' },
    { slug: 'floor-plans', label: 'Plantas', iconName: 'Map', module: 'floorPlans', group: 'modulos' },
    { slug: 'simulation', label: 'Simulação', iconName: 'FlaskConical', module: 'simulation', group: 'modulos' },
    { slug: 'price-compare', label: 'Preços', iconName: 'Tags', module: 'priceCompare', group: 'modulos' },
  ],
  [ProjectType.COMPRA]: [
    { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard', group: 'modulos' },
    { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses', group: 'modulos' },
    { slug: 'price-compare', label: 'Preços', iconName: 'Tags', module: 'priceCompare', group: 'modulos' },
  ],
  [ProjectType.PESSOAL]: [
    { slug: 'monthly', label: 'Cockpit', iconName: 'Gauge', module: 'monthlyOverview', group: 'hoje' },
    { slug: 'conta', label: 'Visão Conta', iconName: 'Landmark', module: 'monthlyOverview', group: 'movimentacoes' },
    { slug: 'dre', label: 'DRE', iconName: 'Target', module: 'monthlyOverview', group: 'resultado' },
    { slug: 'neutros', label: 'Neutros', iconName: 'Shuffle', module: 'monthlyOverview', group: 'auditoria' },
    { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses', group: 'movimentacoes' },
    { slug: 'receipts', label: 'Recebimentos', iconName: 'Wallet', module: 'receipts', group: 'movimentacoes' },
    // module 'expenses' (não 'recurrences'): a permissão do usuário é persistida
    // no signup, e quem já tem conta não teria 'recurrences' — sumiria do menu.
    { slug: 'recorrentes', label: 'Recorrentes', iconName: 'Repeat', module: 'expenses', group: 'planejamento' },
    { slug: 'metas', label: 'Metas', iconName: 'Target', module: 'expenses', group: 'planejamento' },
    { slug: 'planning', label: 'Orçamento futuro', iconName: 'CalendarClock', module: 'monthlyOverview', group: 'planejamento' },
    { slug: 'planejador', label: 'Compras e cenários', iconName: 'Calculator', module: 'monthlyOverview', group: 'planejamento' },
    // 'budget-allocation' saiu da descoberta em #449 (B2): virou histórico
    // administrativo somente leitura, alcançável apenas por deep-link de ADMIN.
    // Sem esta remoção o item continuaria no menu de todo mundo levando a 403.
    { slug: 'cash-flow', label: 'Fluxo de Caixa', iconName: 'ArrowLeftRight', module: 'cashFlow', group: 'auditoria' },
    { slug: 'credit-cards', label: 'Cartões', iconName: 'CreditCard', module: 'creditCards', group: 'movimentacoes' },
    { slug: 'bank-accounts', label: 'Contas', iconName: 'Landmark', module: 'bankAccounts', group: 'movimentacoes' },
  ],
  [ProjectType.CASA]: [
    { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard', group: 'modulos' },
    { slug: 'bills', label: 'Contas', iconName: 'CreditCard', module: 'recurringBills', group: 'modulos' },
    { slug: 'financing', label: 'Financiamento', iconName: 'Landmark', module: 'financing', group: 'modulos' },
    { slug: 'maintenance', label: 'Manutenções', iconName: 'Wrench', module: 'maintenance', group: 'modulos' },
    { slug: 'reminders', label: 'Lembretes', iconName: 'Bell', module: 'reminders', group: 'modulos' },
  ],
  [ProjectType.CARRO]: [
    { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard', group: 'modulos' },
    { slug: 'car-info', label: 'Meu Carro', iconName: 'Car', module: 'carInfo', group: 'modulos' },
    { slug: 'bills', label: 'Contas', iconName: 'CreditCard', module: 'recurringBills', group: 'modulos' },
    { slug: 'vehicle-documents', label: 'Documentos', iconName: 'FileText', module: 'vehicleDocuments', group: 'modulos' },
    { slug: 'financing', label: 'Financiamento', iconName: 'Landmark', module: 'financing', group: 'modulos' },
    { slug: 'maintenance', label: 'Manutenções', iconName: 'Wrench', module: 'maintenance', group: 'modulos' },
    { slug: 'reminders', label: 'Lembretes', iconName: 'Bell', module: 'reminders', group: 'modulos' },
  ],
  [ProjectType.PLANTAS]: [
    { slug: 'dashboard', label: 'Cronograma', iconName: 'CalendarClock', module: 'dashboard', group: 'modulos' },
    { slug: 'plants-ai', label: 'Diagnóstico IA', iconName: 'ScanSearch', module: 'plantsAi', group: 'modulos' },
    { slug: 'plants', label: 'Minhas Plantas', iconName: 'Sprout', module: 'plantsAi', group: 'modulos' },
    { slug: 'maintenance', label: 'Cuidados', iconName: 'Wrench', module: 'maintenance', group: 'modulos' },
    { slug: 'reminders', label: 'Lembretes', iconName: 'Bell', module: 'reminders', group: 'modulos' },
  ],
};

/**
 * Ordered nav modules for a project type. Returns a defensive copy; unknown
 * types yield an empty list (never throws).
 */
export function getProjectNavModules(type: ProjectType): NavModule[] {
  return (PROJECT_NAV[type] ?? []).map((m) => ({ ...m }));
}

/**
 * True when `slug` is a live product route for `type` (present in
 * `PROJECT_NAV[type]`). Source of truth for "does this type still expose this
 * screen as a nav destination" — used e.g. by routes that must self-redirect
 * when their slug is removed from the navigator (a feature can remain gated
 * via `hasFeature` for cross-project purposes without still being a routable
 * screen; see issue #369, CASA/CARRO `expenses`).
 */
export function hasNavRoute(type: ProjectType, slug: string): boolean {
  return (PROJECT_NAV[type] ?? []).some((m) => m.slug === slug);
}

const KNOWN_NAV_GROUP_IDS = new Set<string>(NAV_GROUPS.map((g) => g.id));

/**
 * Grupo de destino quando o `group` declarado é irreconhecível em runtime.
 * `modulos` é a lista única — o rótulo genérico é o menos errado dos destinos.
 */
const FALLBACK_NAV_GROUP: NavGroupId = 'modulos';

/**
 * ⚠️ LEIA ANTES DE APAGAR OU DE ESCREVER TESTE NOVO PARA ISTO.
 *
 * Este caminho de fallback é PROVAVELMENTE INALCANÇÁVEL com os dados de hoje,
 * e isso é garantido por teste, não por otimismo: `nav-groups.test.ts` U1-04
 * (totalidade) varre `Object.values(ProjectType)` e prova que TODA entrada de
 * `PROJECT_NAV` declara um `group` que existe em `NAV_GROUPS`. Enquanto a
 * navegação for constante TypeScript, o `if` abaixo nunca é falso em produção.
 *
 * As duas leituras erradas que este comentário existe para impedir:
 *
 * - "É código morto, apago." Não é morto: é REDE. Ele existe para o dia em que
 *   esta lista deixar de ser constante TypeScript (nav vinda da API, de
 *   feature flag, de config de tenant) — aí o `group` passa a ser string de
 *   runtime e o compilador para de garantir qualquer coisa. Apagar agora é
 *   barato; descobrir a falta depois custa um menu vazio em produção.
 *
 * - "É caminho vivo, vou cobrir os ramos." Não é vivo. O único teste que o
 *   exercita (U1-11) monta um item inválido à mão com `as unknown as
 *   NavModule` justamente porque o tipo torna o caso impossível de escrever
 *   honestamente. Não derive dele que existe dado real assim.
 *
 * Por que DEGRADAR em vez de DESCARTAR: descartar em silêncio é literalmente o
 * defeito que o U1 (#450) veio matar — a função hard-coded da sidebar montava
 * os grupos a partir de listas fixas de slugs e sumia com o resto sem erro e
 * sem aviso (`expenses`, `receipts` e `bank-accounts` de PESSOAL passaram meses
 * fora do menu desktop assim). Um item no grupo errado é um bug que alguém vê
 * e reporta; um item que evapora é um bug que ninguém vê. A ordem de tentativa
 * reflete isso: grupo do próprio item → grupo que `PROJECT_NAV[type]` declara
 * para aquele slug → `modulos`. Sair de mãos vazias não é opção em lugar
 * nenhum desta função.
 */
function resolveNavGroup(item: NavModule, declaredByType: Map<string, NavGroupId>): NavGroupId {
  if (KNOWN_NAV_GROUP_IDS.has(item.group)) return item.group;
  const declared = declaredByType.get(item.slug);
  return declared && KNOWN_NAV_GROUP_IDS.has(declared) ? declared : FALLBACK_NAV_GROUP;
}

/**
 * Particiona a lista JÁ FILTRADA por permissão (`visibleNav`) nas seções de
 * `NAV_GROUPS`. Pura: não lê nem muta nada fora dos argumentos.
 *
 * Contrato — as três garantias que a função hard-coded da sidebar não dava:
 * 1. ORDEM DOS GRUPOS = a de `NAV_GROUPS`, sempre; nunca a ordem de chegada.
 * 2. ORDEM DENTRO DO GRUPO = a de `visibleNav`, isto é, a de `PROJECT_NAV`.
 *    A tabela de mapeamento define PERTENCIMENTO, não posição.
 * 3. PARTIÇÃO TOTAL: todo item de `visibleNav` sai em exatamente um grupo.
 *    A versão anterior montava os grupos a partir de listas fixas de slugs e
 *    descartava o resto em silêncio — `expenses` e `receipts` sumiram do menu
 *    desktop de PESSOAL assim, sem erro e sem ninguém notar.
 *
 * Grupos que ficam vazios após o filtro de permissão NÃO são emitidos: um
 * cabeçalho "Auditoria" sem nenhum link é pior que a ausência do cabeçalho.
 * Por isso `projetos` nunca aparece na saída — `/projects` é rota global de
 * sessão, sem módulo, então nenhuma entrada de `PROJECT_NAV` a declara; ela
 * vive em `NAV_GROUPS` só pelo contrato de ordem, e quem renderiza a insere
 * (a decisão de produto é Projetos ancorado no CABEÇALHO, não como item do
 * rail — o grupo existir aqui e não sair daqui são a mesma coisa, não uma
 * inconsistência).
 *
 * Sobre `type`, sem enfeite: com os dados de hoje ele NÃO é necessário para
 * particionar — cada item já carrega o próprio `group`. Ele serve de entrada
 * para o fallback de `resolveNavGroup`, que por sua vez é inalcançável hoje
 * (ver o aviso lá em cima); assumidamente circular. Fica pelos dois motivos
 * concretos que sobrevivem à circularidade: a assinatura já é o contrato
 * fechado com a camada de view, e quando esta lista deixar de ser constante
 * TypeScript o `type` passa a ser a única forma de recuperar o grupo de um
 * item cujo `group` veio errado da rede. Tipos desconhecidos não lançam —
 * mesmo contrato de `getProjectNavModules`.
 */
export function buildNavGroups(type: ProjectType, visibleNav: NavModule[]): NavGroup[] {
  const declaredByType = new Map<string, NavGroupId>(
    (PROJECT_NAV[type] ?? []).map((m) => [m.slug, m.group] as const),
  );

  const itemsByGroup = new Map<NavGroupId, NavModule[]>();
  for (const item of visibleNav) {
    const groupId = resolveNavGroup(item, declaredByType);
    const bucket = itemsByGroup.get(groupId);
    if (bucket) bucket.push(item);
    else itemsByGroup.set(groupId, [item]);
  }

  const groups: NavGroup[] = [];
  for (const definition of NAV_GROUPS) {
    const items = itemsByGroup.get(definition.id);
    if (!items || items.length === 0) continue;
    groups.push({ ...definition, items });
  }
  return groups;
}

/**
 * Splits an ordered nav list into the mobile tab-bar "primary" slots and the
 * "Mais" sheet "secondary" remainder. The view decides `primaryCount` (e.g. 3
 * when a center slot is reserved for the copiloto action, 4 otherwise).
 */
export function splitMobileNav(
  modules: NavModule[],
  primaryCount = 4,
): { primary: NavModule[]; secondary: NavModule[] } {
  const count = Math.max(0, primaryCount);
  return {
    primary: modules.slice(0, count),
    secondary: modules.slice(count),
  };
}
