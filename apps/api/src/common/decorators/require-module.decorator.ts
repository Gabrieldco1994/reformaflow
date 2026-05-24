import { SetMetadata } from '@nestjs/common';

export const MODULE_KEY = 'requiredModule';

export type ModuleSlug =
  | 'dashboard'
  | 'expenses'
  | 'receipts'
  | 'cashFlow'
  | 'rooms'
  | 'floorPlans'
  | 'simulation'
  | 'priceCompare'
  | 'recurringBills'
  | 'maintenance'
  | 'reminders'
  | 'carInfo'
  | 'schedule'
  | 'monthlyOverview'
  | 'creditCards'
  | 'bankAccounts';

export const RequireModule = (slug: ModuleSlug) => SetMetadata(MODULE_KEY, slug);
