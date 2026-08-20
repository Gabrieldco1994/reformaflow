import { ProjectType } from '../enums';

/**
 * Informational summary page metadata — shared catalog for analytic/complex screens.
 *
 * This is the single source of truth for metadata (labels, descriptions, CTAs,
 * icons) for user-facing informational/summary pages that should not be cloned:
 * dashboards, Cockpit, Conta, DRE, Neutros, cash flow, recurrences/planning/planner/budget/pending,
 * floor-plan canvas, Gantt, simulation comparison, price history, and list summaries
 * for maintenance/reminders/documents/plants.
 *
 * The web layer consumes this via the generic informational-summary components,
 * avoiding duplication and providing a consistent UX across all analytic routes.
 *
 * Why here (not in web): Both API (for analytics/tracking) and web (for rendering)
 * need to agree on what "an informational page" is — this is pure data, so both
 * can import it without coupling.
 */

export interface SummaryCTA {
  /** Label for the button/link. */
  label: string;
  /** Optional icon token (e.g., 'Plus', 'DownloadCloud') — view maps to icon set. */
  iconName?: string;
  /** Where to route — relative to project, e.g., 'expenses/new' or '../receipts'. */
  href: string;
  /** Optional CSS semantic class for styling (e.g., 'primary', 'secondary'). */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
}

export interface SummaryPageDef {
  /** Stable slug matching the route (e.g., 'dashboard', 'monthly', 'conta'). */
  slug: string;
  /** User-facing page title/heading. */
  title: string;
  /** Optional supporting description or tagline. */
  description?: string;
  /** Optional icon token (e.g., 'BarChart3', 'Eye') — view maps to icon set. */
  iconName?: string;
  /**
   * CTAs available on this page (e.g., "Create expense", "Download report").
   * Order matches display order in the view.
   */
  ctas: SummaryCTA[];
  /**
   * Whether this page is informational-only (no mutations). Informs view
   * behavior (e.g., read-only mode, archived-page styling).
   */
  readOnly?: boolean;
}

/**
 * Catalog of informational summary pages per project type.
 *
 * Example route: `/projects/123/monthly` (Cockpit) → fetch via
 * `getSummaryCatalog(projectType)` → find by `slug: 'monthly'`.
 */
export const SUMMARY_CATALOG: Record<ProjectType, SummaryPageDef[]> = {
  [ProjectType.REFORMA]: [
    {
      slug: 'dashboard',
      title: 'Dashboard',
      description: 'Visão geral do projeto',
      iconName: 'BarChart3',
      ctas: [
        { label: 'Adicionar despesa', iconName: 'Plus', href: 'expenses/new', variant: 'primary' },
        {
          label: 'Ver cronograma',
          iconName: 'CalendarClock',
          href: 'schedule',
          variant: 'secondary',
        },
      ],
    },
    {
      slug: 'cash-flow',
      title: 'Fluxo de Caixa',
      description: 'Entradas e saídas ao longo do tempo',
      iconName: 'ArrowLeftRight',
      ctas: [
        { label: 'Adicionar receita', iconName: 'Plus', href: 'receipts/new', variant: 'primary' },
        { label: 'Voltar', iconName: 'ChevronLeft', href: './', variant: 'ghost' },
      ],
    },
    {
      slug: 'price-compare',
      title: 'Comparação de Preços',
      description: 'Histórico e análise de preços',
      iconName: 'Tags',
      ctas: [
        { label: 'Buscar novo item', iconName: 'Search', href: '#', variant: 'secondary' },
      ],
      readOnly: true,
    },
    {
      slug: 'simulation',
      title: 'Simulação',
      description: 'Cenários e projeções',
      iconName: 'FlaskConical',
      ctas: [
        { label: 'Criar simulação', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
  ],
  [ProjectType.COMPRA]: [
    {
      slug: 'dashboard',
      title: 'Dashboard',
      description: 'Visão geral da compra',
      iconName: 'BarChart3',
      ctas: [
        { label: 'Adicionar despesa', iconName: 'Plus', href: 'expenses/new', variant: 'primary' },
      ],
    },
    {
      slug: 'price-compare',
      title: 'Comparação de Preços',
      description: 'Histórico de preços',
      iconName: 'Tags',
      ctas: [],
      readOnly: true,
    },
  ],
  [ProjectType.PESSOAL]: [
    {
      slug: 'monthly',
      title: 'Cockpit Pessoal',
      description: 'Resumo mensal do seu patrimônio',
      iconName: 'Gauge',
      ctas: [
        { label: 'Adicionar despesa', iconName: 'Plus', href: 'expenses/new', variant: 'primary' },
        { label: 'Ver detalhes', iconName: 'Eye', href: 'conta', variant: 'secondary' },
      ],
    },
    {
      slug: 'conta',
      title: 'Visão Conta',
      description: 'Movimentações por conta e cartão',
      iconName: 'Landmark',
      ctas: [
        {
          label: 'Vincular conta',
          iconName: 'Link',
          href: 'bank-accounts',
          variant: 'primary',
        },
      ],
    },
    {
      slug: 'dre',
      title: 'DRE',
      description: 'Receitas, despesas e lucro',
      iconName: 'Target',
      ctas: [
        { label: 'Adicionar receita', iconName: 'Plus', href: 'receipts/new', variant: 'primary' },
      ],
      readOnly: true,
    },
    {
      slug: 'neutros',
      title: 'Movimentações Neutras',
      description: 'Transferências e não-operacionais',
      iconName: 'Shuffle',
      ctas: [],
      readOnly: true,
    },
    {
      slug: 'cash-flow',
      title: 'Fluxo de Caixa',
      description: 'Projeção de saldo ao longo do tempo',
      iconName: 'ArrowLeftRight',
      ctas: [
        { label: 'Planejador', iconName: 'Calculator', href: 'planejador', variant: 'secondary' },
      ],
    },
    {
      slug: 'recorrentes',
      title: 'Recorrentes',
      description: 'Despesas e receitas que se repetem',
      iconName: 'Repeat',
      ctas: [
        { label: 'Adicionar recorrência', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'metas',
      title: 'Metas',
      description: 'Objetivos de economia',
      iconName: 'Target',
      ctas: [
        { label: 'Criar meta', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'planning',
      title: 'Planning',
      description: 'Planejamento de receitas e despesas',
      iconName: 'CalendarClock',
      ctas: [
        { label: 'Adicionar item', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'planejador',
      title: 'Planejador de Fluxo',
      description: 'Estruture seu fluxo financeiro',
      iconName: 'Calculator',
      ctas: [
        { label: 'Voltar', iconName: 'ChevronLeft', href: 'cash-flow', variant: 'ghost' },
      ],
    },
    // 'budget-allocation' saiu do catálogo em #449 (B2): histórico
    // administrativo somente leitura não tem CTA nem card de descoberta.
  ],
  [ProjectType.CASA]: [
    {
      slug: 'dashboard',
      title: 'Dashboard',
      description: 'Visão geral da casa',
      iconName: 'BarChart3',
      ctas: [
        { label: 'Adicionar conta', iconName: 'Plus', href: 'bills/new', variant: 'primary' },
        { label: 'Manutenção', iconName: 'Wrench', href: 'maintenance', variant: 'secondary' },
      ],
    },
    {
      slug: 'maintenance',
      title: 'Manutenções',
      description: 'Registro de serviços e reparos',
      iconName: 'Wrench',
      ctas: [
        { label: 'Registrar manutenção', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'reminders',
      title: 'Lembretes',
      description: 'Tarefas e alertas recorrentes',
      iconName: 'Bell',
      ctas: [
        { label: 'Novo lembrete', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
  ],
  [ProjectType.CARRO]: [
    {
      slug: 'dashboard',
      title: 'Dashboard',
      description: 'Visão geral do veículo',
      iconName: 'BarChart3',
      ctas: [
        { label: 'Adicionar conta', iconName: 'Plus', href: 'bills/new', variant: 'primary' },
      ],
    },
    {
      slug: 'car-info',
      title: 'Meu Carro',
      description: 'Dados do veículo',
      iconName: 'Car',
      ctas: [
        { label: 'Editar', iconName: 'Edit', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'vehicle-documents',
      title: 'Documentos',
      description: 'CRLV, seguro, licenciamento',
      iconName: 'FileText',
      ctas: [
        { label: 'Adicionar documento', iconName: 'Upload', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'maintenance',
      title: 'Manutenções',
      description: 'Histórico de serviços',
      iconName: 'Wrench',
      ctas: [
        { label: 'Registrar serviço', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'reminders',
      title: 'Lembretes',
      description: 'Alertas de revisão e manutenção',
      iconName: 'Bell',
      ctas: [
        { label: 'Novo lembrete', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
  ],
  [ProjectType.PLANTAS]: [
    {
      slug: 'dashboard',
      title: 'Cronograma',
      description: 'Calendário de cuidados',
      iconName: 'CalendarClock',
      ctas: [
        { label: 'Adicionar planta', iconName: 'Plus', href: 'plants', variant: 'primary' },
      ],
    },
    {
      slug: 'plants',
      title: 'Minhas Plantas',
      description: 'Catalogo de plantas cuidadas',
      iconName: 'Sprout',
      ctas: [
        { label: 'Adicionar planta', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'plants-ai',
      title: 'Diagnóstico IA',
      description: 'Análise e sugestões para plantas',
      iconName: 'ScanSearch',
      ctas: [
        { label: 'Usar câmera', iconName: 'Camera', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'maintenance',
      title: 'Cuidados',
      description: 'Tarefas de manutenção',
      iconName: 'Wrench',
      ctas: [
        { label: 'Novo cuidado', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
    {
      slug: 'reminders',
      title: 'Lembretes',
      description: 'Alertas de irrigação e adubação',
      iconName: 'Bell',
      ctas: [
        { label: 'Novo lembrete', iconName: 'Plus', href: '#', variant: 'primary' },
      ],
    },
  ],
};

/**
 * Fetches the summary catalog for a given project type. Returns a defensive copy.
 * @param projectType The project type.
 * @returns Array of summary page definitions; empty array if type unknown.
 */
export function getSummaryCatalog(projectType: ProjectType): SummaryPageDef[] {
  return (SUMMARY_CATALOG[projectType] ?? []).map((page) => ({
    ...page,
    ctas: page.ctas.map((cta) => ({ ...cta })),
  }));
}

/**
 * Fetches a single summary page definition by slug.
 * @param projectType The project type.
 * @param slug The page slug (e.g., 'dashboard', 'monthly').
 * @returns The page definition, or undefined if not found.
 */
export function getCatalogItem(
  projectType: ProjectType,
  slug: string,
): SummaryPageDef | undefined {
  const catalog = getSummaryCatalog(projectType);
  return catalog.find((page) => page.slug === slug);
}

/**
 * Every distinct slug across every project type's catalog — the set of
 * `stepKey`s a Jornada SUMMARY step can target for an informational summary
 * (Etapa E, parte 2). Deduped: the same slug (e.g. `dashboard`) means a
 * different screen per project type, but is a single valid `stepKey` — the
 * runtime resolves the actual `SummaryPageDef` with the ACTIVE project's own
 * type via `getCatalogItem`, never by assuming which type a slug "belongs" to.
 */
export function listSummaryCatalogSlugs(): string[] {
  const slugs = new Set<string>();
  for (const pages of Object.values(SUMMARY_CATALOG)) {
    for (const page of pages) slugs.add(page.slug);
  }
  return [...slugs];
}
