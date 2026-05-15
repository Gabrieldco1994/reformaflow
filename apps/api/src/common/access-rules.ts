import { ModuleSlug } from './decorators/require-module.decorator';

export const TYPE_MODULES: Record<string, ModuleSlug[]> = {
  REFORMA: [
    'dashboard',
    'expenses',
    'receipts',
    'cashFlow',
    'schedule',
    'floorPlans',
    'simulation',
    'priceCompare',
    'rooms',
  ],
  COMPRA: ['dashboard', 'expenses', 'receipts', 'cashFlow'],
  CASA: ['dashboard', 'recurringBills', 'maintenance', 'reminders'],
  CARRO: ['dashboard', 'carInfo', 'recurringBills', 'maintenance', 'reminders'],
};

export function projectTypeHasModule(
  projectType: string,
  slug: ModuleSlug,
): boolean {
  const allowed = TYPE_MODULES[projectType];
  return Array.isArray(allowed) && allowed.includes(slug);
}

export function userHasAnyModuleForType(
  projectType: string,
  allowedModules: string[],
): boolean {
  const typeMods = TYPE_MODULES[projectType] ?? [];
  return typeMods.some((m) => m !== 'dashboard' && allowedModules.includes(m));
}
