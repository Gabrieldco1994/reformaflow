/**
 * Central registry for all operational summary steps.
 * Maps step keys to their React components.
 * Used by both onboarding and jornadas to render steps.
 */

import type { ComponentType } from 'react';
import type { OperationalSummaryStepProps } from './types';

// Import all step components
import { FundingStep } from '@/components/journeys/steps/FundingStep';
import { QuickExpenseStep } from '@/components/journeys/steps/QuickExpenseStep';
import { QuickReceiptStep } from '@/components/journeys/steps/QuickReceiptStep';
import { RecurringBillStep } from '@/components/journeys/steps/RecurringBillStep';
import { CarInfoStep } from '@/components/journeys/steps/CarInfoStep';
import { PlantStep } from '@/components/journeys/steps/PlantStep';
import { ImportMassStep } from '@/components/journeys/steps/ImportMassStep';
import { ExpenseAndImportUnifiedStep } from '@/components/journeys/steps/ExpenseAndImportUnifiedStep';

/**
 * Global registry mapping step key → component.
 * Add new steps here to make them available in both onboarding and jornadas.
 */
export const OPERATIONAL_SUMMARY_REGISTRY: Record<string, ComponentType<OperationalSummaryStepProps>> = {
  // Funding (bank account + credit card unified)
  funding: FundingStep,

  // Expenses
  expense: QuickExpenseStep,
  'expense-import': ExpenseAndImportUnifiedStep,
  import: ImportMassStep,

  // Receipts
  receipt: QuickReceiptStep,

  // Recurring bills
  bill: RecurringBillStep,

  // Car info
  car: CarInfoStep,

  // Plants
  plant: PlantStep,

  // NOTE: maria-insight and feedback are rendered directly by the shell (not via registry)
  // because they have custom props (createdExpense, feedback context) and are conditional
  // on step outcomes from earlier steps. They are NOT part of the operational summary registry.
};

/**
 * Get a step component by key.
 * Returns undefined if the key doesn't exist (allows graceful degradation).
 */
export function getOperationalSummaryStep(key: string): ComponentType<OperationalSummaryStepProps> | undefined {
  return OPERATIONAL_SUMMARY_REGISTRY[key];
}

/**
 * List all available operational summary step keys.
 */
export function listOperationalSummaryStepKeys(): string[] {
  return Object.keys(OPERATIONAL_SUMMARY_REGISTRY);
}
