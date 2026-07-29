/**
 * Adapters for operational summary steps.
 *
 * An adapter is a thin wrapper that converts between different prop interfaces
 * or contexts. Since the onboarding `OnboardingStepProps` now re-exports from
 * operational-summaries, adapters mainly exist for:
 *
 * 1. Context conversion (e.g., jornadas → operational summary)
 * 2. Default value injection (e.g., projectType from context)
 * 3. Mutation wrapping (e.g., optimistic updates)
 *
 * For now, this is a placeholder for future adapters that may be needed.
 */

import type { OperationalSummaryStepProps, OperationalSummaryPayload } from './types';

/**
 * Adapter: no-op wrapper that validates props conform to the operational summary contract.
 * Useful for testing or type-checking external components.
 */
export function validateOperationalSummaryProps(
  props: unknown,
): props is OperationalSummaryStepProps {
  if (!props || typeof props !== 'object') return false;

  const p = props as Record<string, unknown>;

  // Required fields
  if (typeof p.projectId !== 'string') return false;
  if (typeof p.projectType !== 'string') return false;
  if (typeof p.onDone !== 'function') return false;
  if (typeof p.onSkip !== 'function') return false;

  // Optional fields (if present, must be correct type)
  if (p.onBack !== undefined && typeof p.onBack !== 'function') return false;
  if (p.subtitle !== undefined && typeof p.subtitle !== 'string') return false;
  if (p.canSkip !== undefined && typeof p.canSkip !== 'boolean') return false;
  if (p.stepRequired !== undefined && typeof p.stepRequired !== 'boolean') return false;
  if (p.onFundingChange !== undefined && typeof p.onFundingChange !== 'function') return false;

  return true;
}

/**
 * Adapter: Helper to create a default payload.
 * Used by steps that don't produce context for downstream steps.
 */
export function createEmptyPayload(): OperationalSummaryPayload {
  return {};
}

/**
 * Adapter: Helper to create an expense payload.
 * Used by steps that create expenses (QuickExpenseStep, etc.)
 */
export function createExpensePayload(
  tipoDespesa: string,
  categoriaLabel: string,
): OperationalSummaryPayload {
  return {
    createdExpense: {
      tipoDespesa,
      categoriaLabel,
    },
  };
}
