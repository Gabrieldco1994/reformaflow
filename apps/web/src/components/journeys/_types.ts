import type { OnboardingFunding } from '@reformaflow/domain';
import type {
  OperationalSummaryStepProps,
  OperationalSummaryPayload,
} from '@/lib/operational-summaries';

/**
 * Interface every embeddable anchor step (bank account, credit card, quick
 * expense/receipt, recurring bill, car info, plant) implements. The shell
 * renders whichever one is active generically — it never branches on
 * project type beyond looking up `ANCHOR_STEPS`.
 *
 * DEPRECATED: Use `OperationalSummaryStepProps` from `@/lib/operational-summaries`.
 * Kept here for backward compatibility (legacy onboarding imports).
 */
export type OnboardingStepProps = OperationalSummaryStepProps;

/**
 * Dados que um passo pode propagar ao concluir, consumidos pelo wizard shell.
 *
 * DEPRECATED: Use `OperationalSummaryPayload` from `@/lib/operational-summaries`.
 * Kept here for backward compatibility (legacy onboarding imports).
 */
export type StepDonePayload = OperationalSummaryPayload;

// Re-export for convenience (steps import from _types, not from domain directly)
export type { OnboardingFunding };
