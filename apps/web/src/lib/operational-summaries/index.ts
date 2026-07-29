/**
 * Operational summaries library — generic, reusable components for
 * onboarding, jornadas, and any other flow.
 *
 * Usage:
 * - Import types: `import type { OperationalSummaryStepProps } from '@/lib/operational-summaries'`
 * - Import registry: `import { OPERATIONAL_SUMMARY_REGISTRY, getOperationalSummaryStep } from '@/lib/operational-summaries'`
 * - Import adapters: `import { validateOperationalSummaryProps, createExpensePayload } from '@/lib/operational-summaries'`
 * - Import contract test generator: `import { createOperationalSummaryContractTest } from '@/lib/operational-summaries/contract.test'`
 */

export type {
  OperationalSummaryPayload,
  OperationalSummaryStepProps,
  OperationalSummaryStepRegistry,
  OperationalSummaryMetadata,
  OperationalSummaryError,
} from './types';

export {
  OPERATIONAL_SUMMARY_REGISTRY,
  getOperationalSummaryStep,
  listOperationalSummaryStepKeys,
} from './registry';

export {
  validateOperationalSummaryProps,
  createEmptyPayload,
  createExpensePayload,
} from './adapters';

export { createOperationalSummaryContractTest } from './contract';
