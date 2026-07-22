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
 */
export interface NavModule {
  slug: string;
  label: string;
  iconName: string;
  module: string;
}

export const PROJECT_NAV: Record<ProjectType, NavModule[]> = {
  [ProjectType.REFORMA]: [
    { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard' },
    { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses' },
    { slug: 'receipts', label: 'Recebimentos', iconName: 'Wallet', module: 'receipts' },
    { slug: 'cash-flow', label: 'Fluxo de Caixa', iconName: 'ArrowLeftRight', module: 'cashFlow' },
    { slug: 'schedule', label: 'Cronograma', iconName: 'CalendarClock', module: 'schedule' },
    { slug: 'pendencias', label: 'Pendências', iconName: 'ListChecks', module: 'pendencias' },
    { slug: 'floor-plans', label: 'Plantas', iconName: 'Map', module: 'floorPlans' },
    { slug: 'simulation', label: 'Simulação', iconName: 'FlaskConical', module: 'simulation' },
    { slug: 'price-compare', label: 'Preços', iconName: 'Tags', module: 'priceCompare' },
  ],
  [ProjectType.COMPRA]: [
    { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard' },
    { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses' },
    { slug: 'receipts', label: 'Recebimentos', iconName: 'Wallet', module: 'receipts' },
    { slug: 'cash-flow', label: 'Fluxo de Caixa', iconName: 'ArrowLeftRight', module: 'cashFlow' },
    { slug: 'simulation', label: 'Simulação', iconName: 'FlaskConical', module: 'simulation' },
    { slug: 'price-compare', label: 'Preços', iconName: 'Tags', module: 'priceCompare' },
  ],
  [ProjectType.PESSOAL]: [
    { slug: 'monthly', label: 'Cockpit', iconName: 'Gauge', module: 'monthlyOverview' },
    { slug: 'conta', label: 'Visão Conta', iconName: 'Landmark', module: 'monthlyOverview' },
    { slug: 'dre', label: 'DRE', iconName: 'Target', module: 'monthlyOverview' },
    { slug: 'neutros', label: 'Neutros', iconName: 'Shuffle', module: 'monthlyOverview' },
    { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses' },
    { slug: 'receipts', label: 'Recebimentos', iconName: 'Wallet', module: 'receipts' },
    { slug: 'metas', label: 'Metas', iconName: 'Target', module: 'expenses' },
    { slug: 'planning', label: 'Planning', iconName: 'CalendarClock', module: 'monthlyOverview' },
    { slug: 'budget-allocation', label: 'Alocação Budget', iconName: 'Wallet', module: 'dashboard' },
    { slug: 'cash-flow', label: 'Fluxo de Caixa', iconName: 'ArrowLeftRight', module: 'cashFlow' },
    { slug: 'credit-cards', label: 'Cartões', iconName: 'CreditCard', module: 'creditCards' },
    { slug: 'bank-accounts', label: 'Contas', iconName: 'Landmark', module: 'bankAccounts' },
  ],
  [ProjectType.CASA]: [
    { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard' },
    { slug: 'bills', label: 'Contas', iconName: 'CreditCard', module: 'recurringBills' },
    { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses' },
    { slug: 'financing', label: 'Financiamento', iconName: 'Landmark', module: 'financing' },
    { slug: 'maintenance', label: 'Manutenções', iconName: 'Wrench', module: 'maintenance' },
    { slug: 'reminders', label: 'Lembretes', iconName: 'Bell', module: 'reminders' },
  ],
  [ProjectType.CARRO]: [
    { slug: 'dashboard', label: 'Dashboard', iconName: 'LayoutDashboard', module: 'dashboard' },
    { slug: 'car-info', label: 'Meu Carro', iconName: 'Car', module: 'carInfo' },
    { slug: 'bills', label: 'Contas', iconName: 'CreditCard', module: 'recurringBills' },
    { slug: 'expenses', label: 'Despesas', iconName: 'Receipt', module: 'expenses' },
    { slug: 'vehicle-documents', label: 'Documentos', iconName: 'FileText', module: 'vehicleDocuments' },
    { slug: 'maintenance', label: 'Manutenções', iconName: 'Wrench', module: 'maintenance' },
    { slug: 'reminders', label: 'Lembretes', iconName: 'Bell', module: 'reminders' },
  ],
  [ProjectType.PLANTAS]: [
    { slug: 'dashboard', label: 'Cronograma', iconName: 'CalendarClock', module: 'dashboard' },
    { slug: 'plants-ai', label: 'Diagnóstico IA', iconName: 'ScanSearch', module: 'plantsAi' },
    { slug: 'plants', label: 'Minhas Plantas', iconName: 'Sprout', module: 'plantsAi' },
    { slug: 'maintenance', label: 'Cuidados', iconName: 'Wrench', module: 'maintenance' },
    { slug: 'reminders', label: 'Lembretes', iconName: 'Bell', module: 'reminders' },
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
